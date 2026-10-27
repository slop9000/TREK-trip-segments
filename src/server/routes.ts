import { buildDayIndex, resolveSegment } from '../shared/drift';
import { MAX_SEGMENTS_PER_TRIP } from '../shared/limits';
import { hexForTone, isTone, normalizeHexColor } from '../shared/palette';
import { explicitChanges, isResolution, planKnockOn, toRangeUpdates } from '../shared/knock-on';
import { normalizeName, validateSegmentInput } from '../shared/validate';
import { buildDetail, buildOverview, withTrip } from './read-model';
import {
  countSegments,
  deleteSegment,
  getSegment,
  insertSegmentIfFree,
  listSegments,
  updateSegmentIfFree,
  updateSegmentWithOthers,
} from './repo';
import { ensureSchema } from './schema';
import {
  announceChange,
  badRequest,
  bodyInt,
  bodyObject,
  conflict,
  guard,
  json,
  notFound,
  queryInt,
  unprocessable,
} from './respond';
import type { PluginContext, PluginResponse, PluginRoute } from '../shared/host-types';
import type { KnockOnPicks } from '../shared/knock-on';
import type { DayIndex, RangeUpdate, SegmentInput } from '../shared/types';

/**
 * Paths are matched by EXACT STRING EQUALITY against everything after
 * `/api/plugins/trip-segments` (plugins-proxy.controller.ts:86). There is no
 * `:param` support and a trailing slash is significant, so every identifier
 * travels in the query string or the body.
 */

interface ParsedInput {
  input: SegmentInput;
  missing: string[];
}

/** Pull a complete segment input out of a request body. PUT sends all four fields too. */
function parseSegmentInput(body: Record<string, unknown>): ParsedInput {
  const missing: string[] = [];

  const rawName = body['name'];
  if (typeof rawName !== 'string') missing.push('name');

  const rawColor = body['color'];
  const rawTone = body['tone']; // accepted for backward compatibility
  const color =
    rawColor === undefined
      ? isTone(rawTone)
        ? hexForTone(rawTone)
        : null
      : normalizeHexColor(rawColor);
  if (!color) missing.push('color');

  const startDay = bodyInt(body, 'start_day');
  if (startDay === null) missing.push('start_day');

  const endDay = bodyInt(body, 'end_day');
  if (endDay === null) missing.push('end_day');

  return {
    input: {
      name: normalizeName(rawName),
      color: color ?? hexForTone('default'),
      start_day: startDay ?? 0,
      end_day: endDay ?? 0,
    },
    missing,
  };
}

/**
 * How the other legs should make room, if the caller asked for that. Exactly one
 * of two forms:
 *
 * - `others`: the other legs' new ranges, as the Segments tab sends them — the
 *   very changes the user saw and chose in the editor;
 * - `resolve_start` / `resolve_end`: a resolution per end of the leg, for
 *   callers without the editor's planner (the MCP tools). The server plans it.
 *
 * Neither form is trusted: both end up as range updates that are validated
 * against the trip's current rows and written in one checked transaction.
 */
type KnockOnRequest =
  | { kind: 'none' }
  | { kind: 'others'; others: RangeUpdate[] }
  | { kind: 'picks'; picks: KnockOnPicks }
  | { kind: 'invalid'; detail: string };

function parseKnockOn(body: Record<string, unknown>): KnockOnRequest {
  const rawOthers = body['others'];
  const rawStart = body['resolve_start'];
  const rawEnd = body['resolve_end'];
  const hasPicks = rawStart !== undefined || rawEnd !== undefined;

  if (rawOthers !== undefined && hasPicks) {
    return { kind: 'invalid', detail: 'send either others or resolve_start/resolve_end, not both' };
  }

  if (hasPicks) {
    if (rawStart !== undefined && !isResolution(rawStart)) return { kind: 'invalid', detail: 'resolve_start is invalid' };
    if (rawEnd !== undefined && !isResolution(rawEnd)) return { kind: 'invalid', detail: 'resolve_end is invalid' };
    const picks: KnockOnPicks = {};
    if (rawStart !== undefined) picks.start = rawStart;
    if (rawEnd !== undefined) picks.end = rawEnd;
    return { kind: 'picks', picks };
  }

  if (rawOthers === undefined) return { kind: 'none' };
  if (!Array.isArray(rawOthers) || rawOthers.length > MAX_SEGMENTS_PER_TRIP) {
    return { kind: 'invalid', detail: 'others must be a list of legs' };
  }

  const others: RangeUpdate[] = [];
  for (const item of rawOthers) {
    const entry = bodyObject(item);
    const id = entry ? bodyInt(entry, 'id') : null;
    const start = entry ? bodyInt(entry, 'start_day') : null;
    const end = entry ? bodyInt(entry, 'end_day') : null;
    if (id === null || start === null || end === null) {
      return { kind: 'invalid', detail: 'each of others needs id, start_day and end_day' };
    }
    others.push({ id, start_day: start, end_day: end });
  }
  return others.length > 0 ? { kind: 'others', others } : { kind: 'none' };
}

/**
 * Field-level validation only.
 *
 * Overlap and the per-trip limit are deliberately NOT checked here: both are
 * enforced atomically inside the INSERT/UPDATE statement, so a read-then-write
 * check would cost an extra round trip and still lose a race between two tabs.
 * Passing `existing: []` makes that explicit — this call answers "is the input
 * well-formed", and SQL answers "does it fit".
 */
function fieldIssues(input: SegmentInput, dayCount: number): string[] {
  return validateSegmentInput(input, { dayCount, existing: [] });
}

/** Days are needed for both the range check and the dates on the response. */
async function loadDayIndex(ctx: PluginContext, tripId: number): Promise<DayIndex> {
  return buildDayIndex(await ctx.trips.getDays(tripId));
}

/**
 * The knock-on half of PUT /segments. Returns null when nothing but the edited
 * leg would change, so the caller falls through to the plain guarded update.
 *
 * The final layout is validated as a whole by the same shared validator the
 * editor runs, against rows read here rather than anything the caller sent;
 * then the write happens in one transaction that re-checks the layout itself.
 */
async function saveWithOthers(
  ctx: PluginContext,
  tripId: number,
  id: number,
  input: SegmentInput,
  idx: DayIndex,
  knockOn: Extract<KnockOnRequest, { kind: 'others' | 'picks' }>,
): Promise<PluginResponse | null> {
  const rows = await listSegments(ctx, tripId);
  if (!rows.some((r) => r.id === id)) return notFound();

  let others: RangeUpdate[];
  if (knockOn.kind === 'picks') {
    const plan = planKnockOn({ id, start_day: input.start_day, end_day: input.end_day }, rows, idx.count);
    const planned = explicitChanges(plan, knockOn.picks);
    if (!planned.ok) return unprocessable([`resolve_${planned.side}_unavailable`]);
    others = toRangeUpdates(planned.changes);
  } else {
    // A leg the caller knows about and we do not was deleted since it read the
    // trip, so its whole plan is stale.
    if (knockOn.others.some((o) => !rows.some((r) => r.id === o.id))) return conflict('a leg changed meanwhile');
    others = knockOn.others;
  }
  if (others.length === 0) return null;

  const issues = validateSegmentInput(input, { dayCount: idx.count, existing: rows, editingId: id, others });
  if (issues.length > 0) return unprocessable(issues);

  const updated = await updateSegmentWithOthers(ctx, tripId, id, input, others);
  if (!updated) {
    const existing = await getSegment(ctx, tripId, id);
    return existing ? conflict('the legs changed meanwhile') : notFound();
  }

  await announceChange(ctx, tripId);
  return json(200, { segment: resolveSegment(updated, idx.count, 0, idx.dateByPos), moved: others });
}

export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/overview',
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, 'tripId');
      if (tripId === null) return badRequest('tripId is required');

      await ensureSchema(ctx);

      const payload = await withTrip(ctx, tripId, (trip) => buildOverview(ctx, tripId, trip));
      return payload ? json(200, payload) : notFound();
    }),
  },

  {
    method: 'GET',
    path: '/segment-detail',
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, 'tripId');
      if (tripId === null) return badRequest('tripId is required');

      const id = queryInt(req.query, 'id');
      if (id === null) return badRequest('id is required');

      await ensureSchema(ctx);

      const result = await withTrip(ctx, tripId, () => buildDetail(ctx, tripId, id));
      // null from either layer means "not visible to you" or "no such segment";
      // both are a 404 from the caller's point of view.
      return result ? json(200, result) : notFound();
    }),
  },

  {
    method: 'POST',
    path: '/segments',
    auth: true,
    handler: guard(async (req, ctx) => {
      const body = bodyObject(req.body);
      if (!body) return badRequest('a JSON object body is required');

      const tripId = bodyInt(body, 'tripId');
      if (tripId === null) return badRequest('tripId is required');

      const { input, missing } = parseSegmentInput(body);
      if (missing.length > 0) return badRequest(`missing or invalid: ${missing.join(', ')}`);

      await ensureSchema(ctx);

      const result = await withTrip(ctx, tripId, async () => {
        const idx = await loadDayIndex(ctx, tripId);

        const issues = fieldIssues(input, idx.count);
        if (issues.length > 0) return unprocessable(issues);

        const created = await insertSegmentIfFree(ctx, tripId, input);
        if (!created) {
          // The guard refused. Which one it was only matters for the log — the
          // client sees a bare 409 either way and reloads.
          const total = await countSegments(ctx, tripId);
          ctx.log.info('segment insert refused', { tripId, total });
          return conflict(
            total >= MAX_SEGMENTS_PER_TRIP ? 'segment limit reached' : 'overlaps an existing segment',
          );
        }

        await announceChange(ctx, tripId);
        return json(200, { segment: resolveSegment(created, idx.count, 0, idx.dateByPos) });
      });

      return result ?? notFound();
    }),
  },

  {
    method: 'PUT',
    path: '/segments',
    auth: true,
    handler: guard(async (req, ctx) => {
      const body = bodyObject(req.body);
      if (!body) return badRequest('a JSON object body is required');

      const tripId = bodyInt(body, 'tripId');
      if (tripId === null) return badRequest('tripId is required');

      const id = bodyInt(body, 'id');
      if (id === null) return badRequest('id is required');

      const { input, missing } = parseSegmentInput(body);
      if (missing.length > 0) return badRequest(`missing or invalid: ${missing.join(', ')}`);

      const knockOn = parseKnockOn(body);
      if (knockOn.kind === 'invalid') return badRequest(knockOn.detail);

      await ensureSchema(ctx);

      const result = await withTrip(ctx, tripId, async () => {
        const idx = await loadDayIndex(ctx, tripId);

        const issues = fieldIssues(input, idx.count);
        if (issues.length > 0) return unprocessable(issues);

        if (knockOn.kind !== 'none') {
          const moved = await saveWithOthers(ctx, tripId, id, input, idx, knockOn);
          if (moved) return moved;
          // null: the picks asked for nothing that moves another leg, so this
          // is an ordinary single-leg update after all.
        }

        const updated = await updateSegmentIfFree(ctx, tripId, id, input);
        if (!updated) {
          // Zero rows means either "no such segment on this trip" or "the new
          // range collides"; only a follow-up read can tell them apart, and the
          // difference is the difference between 404 and 409.
          const existing = await getSegment(ctx, tripId, id);
          return existing ? conflict('overlaps an existing segment') : notFound();
        }

        await announceChange(ctx, tripId);
        return json(200, { segment: resolveSegment(updated, idx.count, 0, idx.dateByPos) });
      });

      return result ?? notFound();
    }),
  },

  {
    method: 'DELETE',
    path: '/segments',
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, 'tripId');
      if (tripId === null) return badRequest('tripId is required');

      const id = queryInt(req.query, 'id');
      if (id === null) return badRequest('id is required');

      await ensureSchema(ctx);

      const result = await withTrip(ctx, tripId, async () => {
        const removed = await deleteSegment(ctx, tripId, id);
        if (!removed) return notFound();

        await announceChange(ctx, tripId);
        return json(200, { deleted: true });
      });

      return result ?? notFound();
    }),
  },
];
