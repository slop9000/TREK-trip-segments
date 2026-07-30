import { buildDayIndex, resolveSegment } from '../shared/drift';
import { MAX_SEGMENTS_PER_TRIP } from '../shared/limits';
import { hexForTone, isTone, normalizeHexColor } from '../shared/palette';
import { normalizeName, validateSegmentInput } from '../shared/validate';
import { buildDetail, buildOverview, withTrip } from './read-model';
import { countSegments, deleteSegment, getSegment, insertSegmentIfFree, updateSegmentIfFree } from './repo';
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
import type { PluginContext, PluginRoute } from '../shared/host-types';
import type { DayIndex, SegmentInput } from '../shared/types';

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

      await ensureSchema(ctx);

      const result = await withTrip(ctx, tripId, async () => {
        const idx = await loadDayIndex(ctx, tripId);

        const issues = fieldIssues(input, idx.count);
        if (issues.length > 0) return unprocessable(issues);

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
