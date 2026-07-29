import { describe, expect, it } from 'vitest';
import { MIGRATION_SQL } from '../src/server/schema';
import {
  SQL_COUNT,
  SQL_DELETE,
  SQL_GET,
  SQL_INSERT_IF_FREE,
  SQL_LIST,
  SQL_UPDATE_IF_FREE,
  countSegments,
  deleteSegment,
  getSegment,
  insertSegmentIfFree,
  listSegments,
  sqlListForTrips,
  updateSegmentIfFree,
} from '../src/server/repo';
import { MAX_SEGMENTS_PER_TRIP } from '../src/shared/limits';
import { realDbContext } from './helpers';
import type { SegmentInput } from '../src/shared/types';

const seg = (name: string, start: number, end: number): SegmentInput => ({
  name,
  tone: 'default',
  start_day: start,
  end_day: end,
});

async function freshDb() {
  const ctx = realDbContext();
  await ctx.db.migrate('001-segments', MIGRATION_SQL);
  return ctx;
}

describe('SQL safety', () => {
  /**
   * plugin-data.service.ts:28 runs this regex over the WHOLE statement and
   * refuses on a match — including inside comments and identifiers. A single
   * `WITH RECURSIVE` anywhere would make the statement permanently unusable in
   * production while working fine in any local sqlite test.
   */
  const FORBIDDEN = /\b(ATTACH|DETACH|VACUUM|PRAGMA|RECURSIVE|LOAD_EXTENSION)\b/i;

  const statements: Record<string, string> = {
    SQL_LIST,
    SQL_GET,
    SQL_COUNT,
    SQL_DELETE,
    SQL_INSERT_IF_FREE,
    SQL_UPDATE_IF_FREE,
    MIGRATION_SQL,
    'sqlListForTrips(3)': sqlListForTrips(3),
  };

  it.each(Object.entries(statements))('%s uses no forbidden keyword', (_name, sql) => {
    expect(FORBIDDEN.test(sql)).toBe(false);
  });

  it.each(Object.entries(statements))('%s binds only anonymous placeholders', (_name, sql) => {
    // node:sqlite (dev) and better-sqlite3 (prod) disagree about `?N`.
    expect(/\?\d/.test(sql)).toBe(false);
  });
});

describe('insert guard', () => {
  it('returns the created row via RETURNING', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(created).not.toBeNull();
    expect(created).toMatchObject({ id: 1, trip_id: 1, name: 'Tokyo', start_day: 1, end_day: 5, tone: 'default' });
    expect(created?.created_at).toBeTruthy();
    ctx.close();
  });

  it('refuses an overlapping range', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await insertSegmentIfFree(ctx, 1, seg('Inside', 2, 3))).toBeNull();
    expect(await insertSegmentIfFree(ctx, 1, seg('Straddles start', 1, 1))).toBeNull();
    expect(await insertSegmentIfFree(ctx, 1, seg('Straddles end', 5, 9))).toBeNull();
    expect(await insertSegmentIfFree(ctx, 1, seg('Encloses', 1, 12))).toBeNull();
    ctx.close();
  });

  it('allows an adjacent range and a gap', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await insertSegmentIfFree(ctx, 1, seg('Adjacent', 6, 9))).not.toBeNull();
    expect(await insertSegmentIfFree(ctx, 1, seg('After a gap', 20, 25))).not.toBeNull();
    ctx.close();
  });

  it('scopes the overlap check to one trip', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await insertSegmentIfFree(ctx, 2, seg('Other trip, same days', 1, 5))).not.toBeNull();
    ctx.close();
  });

  it(`refuses the segment past the ${MAX_SEGMENTS_PER_TRIP} limit`, async () => {
    const ctx = await freshDb();
    // One-day, non-overlapping legs so only the count guard can refuse.
    for (let i = 1; i <= MAX_SEGMENTS_PER_TRIP; i++) {
      expect(await insertSegmentIfFree(ctx, 1, seg(`Leg ${i}`, i, i))).not.toBeNull();
    }
    expect(await countSegments(ctx, 1)).toBe(MAX_SEGMENTS_PER_TRIP);

    expect(await insertSegmentIfFree(ctx, 1, seg('One too many', 99, 99))).toBeNull();
    // The limit is per trip, not global.
    expect(await insertSegmentIfFree(ctx, 2, seg('Other trip', 99, 99))).not.toBeNull();
    ctx.close();
  });
});

describe('update guard', () => {
  it('updates and returns the row', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    const updated = await updateSegmentIfFree(ctx, 1, created!.id, seg('Tokyo renamed', 1, 7));
    expect(updated).toMatchObject({ id: created!.id, name: 'Tokyo renamed', start_day: 1, end_day: 7 });
    ctx.close();
  });

  it('lets a segment keep its own range (does not collide with itself)', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await updateSegmentIfFree(ctx, 1, created!.id, seg('Same range, new name', 1, 5))).not.toBeNull();
    ctx.close();
  });

  it('refuses a range that collides with a different segment', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));
    const second = await insertSegmentIfFree(ctx, 1, seg('Kanazawa', 6, 9));

    expect(await updateSegmentIfFree(ctx, 1, second!.id, seg('Kanazawa', 5, 9))).toBeNull();
    ctx.close();
  });

  it('returns null for a segment on another trip, so the route can 404', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await updateSegmentIfFree(ctx, 2, created!.id, seg('Tokyo', 1, 5))).toBeNull();
    expect(await getSegment(ctx, 2, created!.id)).toBeNull();
    ctx.close();
  });
});

describe('read and delete', () => {
  it('lists in start-day order regardless of insertion order', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Third', 20, 25));
    await insertSegmentIfFree(ctx, 1, seg('First', 1, 5));
    await insertSegmentIfFree(ctx, 1, seg('Second', 6, 9));

    expect((await listSegments(ctx, 1)).map((s) => s.name)).toEqual(['First', 'Second', 'Third']);
    ctx.close();
  });

  it('deletes only within the trip', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(await deleteSegment(ctx, 2, created!.id)).toBe(false);
    expect(await deleteSegment(ctx, 1, created!.id)).toBe(true);
    expect(await deleteSegment(ctx, 1, created!.id)).toBe(false);
    ctx.close();
  });

  it('binds one placeholder per trip id in the trip-card query', async () => {
    const ctx = await freshDb();
    await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));
    await insertSegmentIfFree(ctx, 3, seg('Bangkok', 1, 5));

    const rows = await ctx.db.query<{ trip_id: number; name: string }>(sqlListForTrips(3), 1, 2, 3);
    expect(rows.map((r) => r.trip_id).sort()).toEqual([1, 3]);
    ctx.close();
  });
});
