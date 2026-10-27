import { describe, expect, it } from 'vitest';
import { COLOR_MIGRATION_SQL, MIGRATION_SQL, ensureSchema, resetSchemaMemo } from '../src/server/schema';
import {
  SQL_COUNT,
  SQL_DELETE,
  SQL_GET,
  SQL_INSERT_IF_FREE,
  SQL_LIST,
  SQL_UPDATE_EDITED,
  SQL_UPDATE_IF_FREE,
  SQL_UPDATE_RANGE,
  countSegments,
  deleteSegment,
  getSegment,
  insertSegmentIfFree,
  listSegments,
  sqlAbortIfLayoutBroken,
  sqlListForTrips,
  updateSegmentIfFree,
  updateSegmentWithOthers,
} from '../src/server/repo';
import { MAX_SEGMENTS_PER_TRIP } from '../src/shared/limits';
import { realDbContext } from './helpers';
import type { SegmentInput } from '../src/shared/types';

const seg = (name: string, start: number, end: number): SegmentInput => ({
  name,
  color: '#4F46E5',
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
    COLOR_MIGRATION_SQL,
    'sqlListForTrips(3)': sqlListForTrips(3),
    SQL_UPDATE_EDITED,
    SQL_UPDATE_RANGE,
    'sqlAbortIfLayoutBroken(3)': sqlAbortIfLayoutBroken(3),
  };

  it.each(Object.entries(statements))('%s uses no forbidden keyword', (_name, sql) => {
    expect(FORBIDDEN.test(sql)).toBe(false);
  });

  it.each(Object.entries(statements))('%s binds only anonymous placeholders', (_name, sql) => {
    // node:sqlite (dev) and better-sqlite3 (prod) disagree about `?N`.
    expect(/\?\d/.test(sql)).toBe(false);
  });
});

describe('colour migration', () => {
  it('adds and backfills the colour column on a tone-only installation', async () => {
    const ctx = realDbContext();
    await ctx.db.exec(`
      CREATE TABLE segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        tone TEXT NOT NULL,
        start_day INTEGER NOT NULL,
        end_day INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO segments
        (trip_id, name, tone, start_day, end_day, created_at, updated_at)
      VALUES
        (1, 'Legacy', 'warn', 1, 2, 'x', 'x');
    `);

    resetSchemaMemo();
    await ensureSchema(ctx);
    expect(await listSegments(ctx, 1)).toMatchObject([{ name: 'Legacy', color: '#F59E0B', tone: 'warn' }]);

    // The dev host forgets migration ids on restart; the probe must make a
    // second startup harmless even though the database file survives.
    resetSchemaMemo();
    await ensureSchema(ctx);
    expect(await listSegments(ctx, 1)).toHaveLength(1);
    ctx.close();
  });
});

describe('insert guard', () => {
  it('returns the created row via RETURNING', async () => {
    const ctx = await freshDb();
    const created = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));

    expect(created).not.toBeNull();
    expect(created).toMatchObject({
      id: 1,
      trip_id: 1,
      name: 'Tokyo',
      color: '#4F46E5',
      start_day: 1,
      end_day: 5,
      tone: 'default',
    });
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

describe('knock-on save', () => {
  async function tiled() {
    const ctx = await freshDb();
    const a = await insertSegmentIfFree(ctx, 1, seg('Tokyo', 1, 5));
    const b = await insertSegmentIfFree(ctx, 1, seg('Kyoto', 6, 10));
    const c = await insertSegmentIfFree(ctx, 1, seg('Osaka', 11, 15));
    // Another trip with the same days, which must never be touched or counted.
    await insertSegmentIfFree(ctx, 2, seg('Elsewhere', 1, 20));
    return { ctx, a: a!, b: b!, c: c! };
  }

  const ranges = async (ctx: Awaited<ReturnType<typeof freshDb>>, tripId = 1) =>
    (await listSegments(ctx, tripId)).map((r) => `${r.name} ${r.start_day}-${r.end_day}`);

  /**
   * The reason this exists: one statement at a time, the first update of a
   * push always collides with the leg that has not moved yet.
   */
  it('saves a layout that no order of single guarded updates could reach', async () => {
    const { ctx, a, b, c } = await tiled();
    expect(await updateSegmentIfFree(ctx, 1, a.id, seg('Tokyo', 1, 7))).toBeNull();

    const saved = await updateSegmentWithOthers(ctx, 1, a.id, seg('Tokyo longer', 1, 7), [
      { id: b.id, start_day: 8, end_day: 12 },
      { id: c.id, start_day: 13, end_day: 17 },
    ]);

    expect(saved).toMatchObject({ id: a.id, name: 'Tokyo longer', start_day: 1, end_day: 7 });
    expect(await ranges(ctx)).toEqual(['Tokyo longer 1-7', 'Kyoto 8-12', 'Osaka 13-17']);
    expect(await ranges(ctx, 2)).toEqual(['Elsewhere 1-20']);
    ctx.close();
  });

  it('leaves the other legs\' names and colours alone', async () => {
    const { ctx, a, b } = await tiled();
    await updateSegmentWithOthers(ctx, 1, a.id, seg('Tokyo', 1, 6), [{ id: b.id, start_day: 7, end_day: 10 }]);

    expect(await getSegment(ctx, 1, b.id)).toMatchObject({ name: 'Kyoto', color: '#4F46E5', start_day: 7 });
    ctx.close();
  });

  it('writes nothing at all when the final layout overlaps', async () => {
    const { ctx, a, b } = await tiled();

    // Kyoto moves, Osaka does not: Kyoto 8-12 now runs into Osaka 11-15.
    const saved = await updateSegmentWithOthers(ctx, 1, a.id, seg('Tokyo', 1, 7), [
      { id: b.id, start_day: 8, end_day: 12 },
    ]);

    expect(saved).toBeNull();
    expect(await ranges(ctx)).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15']);
    expect(await countSegments(ctx, 1)).toBe(3); // the guard's own row never lands either
    ctx.close();
  });

  it('writes nothing when a touched leg was deleted meanwhile', async () => {
    const { ctx, a, b } = await tiled();
    await deleteSegment(ctx, 1, b.id);

    const saved = await updateSegmentWithOthers(ctx, 1, a.id, seg('Tokyo', 1, 7), [
      { id: b.id, start_day: 8, end_day: 10 },
    ]);

    expect(saved).toBeNull();
    expect(await ranges(ctx)).toEqual(['Tokyo 1-5', 'Osaka 11-15']);
    ctx.close();
  });

  it('never reaches into another trip', async () => {
    const { ctx, a } = await tiled();
    const other = (await listSegments(ctx, 2))[0]!;

    const saved = await updateSegmentWithOthers(ctx, 1, a.id, seg('Tokyo', 1, 5), [
      { id: other.id, start_day: 16, end_day: 20 },
    ]);

    expect(saved).toBeNull();
    expect(await ranges(ctx, 2)).toEqual(['Elsewhere 1-20']);
    ctx.close();
  });
});
