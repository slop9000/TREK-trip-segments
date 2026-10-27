import { hexForTone, isTone, normalizeHexColor, toneForColor } from '../shared/palette';
import { MAX_SEGMENTS_PER_TRIP } from '../shared/limits';
import type { PluginContext } from '../shared/host-types';
import type { DayRange, SegmentInput, SegmentRow } from '../shared/types';

/**
 * The only file in the plugin that contains SQL.
 *
 * Every statement is an exported constant, for two reasons: `createMockHost`'s
 * db stub resolves `query()` by exact SQL string, so tests can only stub what
 * they can name; and a single test can run the host's forbidden-keyword regex
 * over all of them at once (ATTACH/DETACH/VACUUM/PRAGMA/RECURSIVE/
 * LOAD_EXTENSION are rejected outright by plugin-data.service.ts:28).
 *
 * Only anonymous `?` placeholders: `trek-plugin dev` runs node:sqlite while
 * production runs better-sqlite3, and the two disagree about `?N` and array
 * binding.
 */
const COLUMNS = 'id, trip_id, name, color, tone, start_day, end_day, created_at, updated_at';

export const SQL_LIST = `SELECT ${COLUMNS} FROM segments WHERE trip_id = ? ORDER BY start_day ASC, id ASC`;

export const SQL_GET = `SELECT ${COLUMNS} FROM segments WHERE trip_id = ? AND id = ?`;

export const SQL_COUNT = 'SELECT COUNT(*) AS n FROM segments WHERE trip_id = ?';

export const SQL_DELETE = 'DELETE FROM segments WHERE trip_id = ? AND id = ?';

/**
 * Insert only if the trip is under its segment limit AND nothing overlaps.
 *
 * Doing both checks inside the statement makes the write atomic — a read-then-
 * write would let two tabs both pass validation and then both insert. Zero rows
 * returned means one of the two guards refused, which the caller turns into a
 * 409 (disambiguating with SQL_COUNT only to log the reason).
 */
export const SQL_INSERT_IF_FREE = `INSERT INTO segments (trip_id, name, color, tone, start_day, end_day)
SELECT ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM segments WHERE trip_id = ?) < ?
  AND NOT EXISTS (SELECT 1 FROM segments WHERE trip_id = ? AND start_day <= ? AND end_day >= ?)
RETURNING ${COLUMNS}`;

/** Same guard, minus the count, and excluding the row being edited from the overlap test. */
export const SQL_UPDATE_IF_FREE = `UPDATE segments
SET name = ?, color = ?, tone = ?, start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ?
  AND NOT EXISTS (SELECT 1 FROM segments WHERE trip_id = ? AND id <> ? AND start_day <= ? AND end_day >= ?)
RETURNING ${COLUMNS}`;

/**
 * The edited leg inside a knock-on save. No overlap guard, on purpose: in the
 * middle of the batch the legs DO overlap — the edited one has grown before
 * its neighbour has moved — so a per-statement guard would refuse whichever
 * update ran first. The whole batch is checked once, at the end, by
 * sqlAbortIfLayoutBroken().
 *
 * Every update in the batch matches only the range it was planned from, so a
 * leg another tab moved in between is left as that tab left it, and the final
 * check sees that the plan no longer holds.
 */
export const SQL_UPDATE_EDITED = `UPDATE segments
SET name = ?, color = ?, tone = ?, start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ? AND start_day = ? AND end_day = ?
RETURNING ${COLUMNS}`;

/** Another leg's new range inside a knock-on save. Name and colour are left alone. */
export const SQL_UPDATE_RANGE = `UPDATE segments
SET start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ? AND start_day = ? AND end_day = ?`;

/**
 * The last statement of a knock-on save, and the one that makes it atomic.
 *
 * `ctx.db.tx` rolls the whole batch back only when a statement THROWS, and
 * SQLite has no RAISE() outside a trigger. So this is an insert that can only
 * ever fail: it selects a row only when the trip's legs now overlap, or when
 * not every touched leg now has exactly its planned range (another tab moved
 * or deleted one since we read them), and that row violates the table's own
 * `CHECK (end_day >= start_day)`. A healthy layout inserts nothing.
 *
 * The checks the route ran beforehand saw the rows as they were when it read
 * them; this one sees them as they are inside the transaction, so a concurrent
 * write can never slip a broken or unplanned layout past it.
 */
export function sqlAbortIfLayoutBroken(touched: number): string {
  const planned = new Array(touched).fill('(id = ? AND start_day = ? AND end_day = ?)').join(' OR ');
  return `INSERT INTO segments (trip_id, name, color, tone, start_day, end_day)
SELECT ?, '', '#000000', 'default', 1, 0
WHERE EXISTS (
    SELECT 1 FROM segments a JOIN segments b
      ON b.trip_id = a.trip_id AND b.id > a.id AND a.start_day <= b.end_day AND a.end_day >= b.start_day
    WHERE a.trip_id = ?
  )
  OR (SELECT COUNT(*) FROM segments WHERE trip_id = ? AND (${planned})) <> ?`;
}

/** How the deliberate abort above reads in an error message, from either SQLite driver. */
const ABORT_MESSAGE = /CHECK constraint failed/i;

/**
 * One statement for every trip on the dashboard. The trip-card hook gets up to
 * 60 ids and has a 5s budget against an RPC limit that rejects rather than
 * queues, so per-trip queries are not an option.
 */
export function sqlListForTrips(count: number): string {
  const placeholders = new Array(count).fill('?').join(', ');
  return `SELECT trip_id, name, color, tone, start_day, end_day FROM segments WHERE trip_id IN (${placeholders}) ORDER BY trip_id ASC, start_day ASC, id ASC`;
}

/** Narrow a raw sqlite row, dropping anything malformed rather than trusting it. */
export function toSegmentRow(raw: unknown): SegmentRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = Number(r['id']);
  const tripId = Number(r['trip_id']);
  const startDay = Number(r['start_day']);
  const endDay = Number(r['end_day']);
  if (!Number.isInteger(id) || !Number.isInteger(tripId)) return null;
  if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) return null;

  const tone = isTone(r['tone']) ? r['tone'] : 'default';
  return {
    id,
    trip_id: tripId,
    name: String(r['name'] ?? ''),
    color: normalizeHexColor(r['color']) ?? hexForTone(tone),
    tone,
    start_day: startDay,
    end_day: endDay,
    created_at: String(r['created_at'] ?? ''),
    updated_at: String(r['updated_at'] ?? ''),
  };
}

function rows(raw: unknown[]): SegmentRow[] {
  const out: SegmentRow[] = [];
  for (const r of raw) {
    const row = toSegmentRow(r);
    if (row) out.push(row);
  }
  return out;
}

export async function listSegments(ctx: PluginContext, tripId: number): Promise<SegmentRow[]> {
  return rows(await ctx.db.query(SQL_LIST, tripId));
}

export async function getSegment(ctx: PluginContext, tripId: number, id: number): Promise<SegmentRow | null> {
  const found = rows(await ctx.db.query(SQL_GET, tripId, id));
  return found[0] ?? null;
}

export async function countSegments(ctx: PluginContext, tripId: number): Promise<number> {
  const result = await ctx.db.query<{ n: number }>(SQL_COUNT, tripId);
  return Number(result[0]?.n ?? 0);
}

/** Returns the created row, or null when the atomic guard refused. */
export async function insertSegmentIfFree(
  ctx: PluginContext,
  tripId: number,
  input: SegmentInput,
): Promise<SegmentRow | null> {
  const created = await ctx.db.query(
    SQL_INSERT_IF_FREE,
    tripId,
    input.name,
    input.color,
    toneForColor(input.color),
    input.start_day,
    input.end_day,
    tripId,
    MAX_SEGMENTS_PER_TRIP,
    tripId,
    input.end_day,
    input.start_day,
  );
  return rows(created)[0] ?? null;
}

/** Returns the updated row, or null when the row is missing or the range collides. */
export async function updateSegmentIfFree(
  ctx: PluginContext,
  tripId: number,
  id: number,
  input: SegmentInput,
): Promise<SegmentRow | null> {
  const updated = await ctx.db.query(
    SQL_UPDATE_IF_FREE,
    input.name,
    input.color,
    toneForColor(input.color),
    input.start_day,
    input.end_day,
    id,
    tripId,
    tripId,
    id,
    input.end_day,
    input.start_day,
  );
  return rows(updated)[0] ?? null;
}

/** One leg's move inside a knock-on save: where it was planned from, and where it goes. */
export interface PlannedMove {
  id: number;
  from: DayRange;
  to: DayRange;
}

/**
 * Save an edited leg together with new ranges for other legs, all or nothing.
 *
 * Returns the edited row, or null when the in-transaction check refused: the
 * final layout overlapped, or a touched leg was no longer where the plan found
 * it. The route answers 409 for that, because it means the caller planned
 * against rows that have since changed. Any other failure is not a conflict
 * and is rethrown, so it surfaces as a 500 and is logged as an error.
 */
export async function updateSegmentWithOthers(
  ctx: PluginContext,
  tripId: number,
  edited: PlannedMove,
  input: SegmentInput,
  moves: readonly PlannedMove[],
): Promise<SegmentRow | null> {
  const touched = [{ ...edited, to: [input.start_day, input.end_day] as DayRange }, ...moves];
  const ops = [
    {
      sql: SQL_UPDATE_EDITED,
      args: [
        input.name,
        input.color,
        toneForColor(input.color),
        input.start_day,
        input.end_day,
        edited.id,
        tripId,
        ...edited.from,
      ],
    },
    ...moves.map((m) => ({ sql: SQL_UPDATE_RANGE, args: [...m.to, m.id, tripId, ...m.from] })),
    {
      sql: sqlAbortIfLayoutBroken(touched.length),
      args: [tripId, tripId, tripId, ...touched.flatMap((t) => [t.id, ...t.to]), touched.length],
    },
  ];

  let result: Awaited<ReturnType<PluginContext['db']['tx']>>;
  try {
    result = await ctx.db.tx(ops);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!ABORT_MESSAGE.test(message)) throw err;
    ctx.log.info('knock-on save refused', { tripId, touched: touched.length });
    return null;
  }
  return rows(result.results[0]?.rows ?? [])[0] ?? null;
}

export async function deleteSegment(ctx: PluginContext, tripId: number, id: number): Promise<boolean> {
  const { changes } = await ctx.db.exec(SQL_DELETE, tripId, id);
  return changes > 0;
}

export interface TripSegmentSummary {
  trip_id: number;
  name: string;
}

/** One query for every visible trip card. Returns [] for an empty id list. */
export async function listSegmentsForTrips(ctx: PluginContext, tripIds: number[]): Promise<TripSegmentSummary[]> {
  if (tripIds.length === 0) return [];

  const raw = await ctx.db.query(sqlListForTrips(tripIds.length), ...tripIds);
  const out: TripSegmentSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const tripId = Number(r['trip_id']);
    if (!Number.isInteger(tripId)) continue;
    out.push({ trip_id: tripId, name: String(r['name'] ?? '') });
  }
  return out;
}
