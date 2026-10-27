import { beforeEach, describe, expect, it } from 'vitest';
import { routes } from '../src/server/routes';
import { mcpTools } from '../src/server/mcp-tools';
import { insertSegmentIfFree, listSegments } from '../src/server/repo';
import { ensureSchema, resetSchemaMemo } from '../src/server/schema';
import { makeDays, realDbContext } from './helpers';
import type { PluginContext, PluginRequest } from '../src/shared/host-types';

/**
 * PUT /segments with other legs' new ranges, against a REAL sqlite database.
 *
 * The mock host's tx() answers every write with zero changes and never rolls
 * anything back, so atomicity can only be shown with a database that really
 * runs the batch in a transaction (test/helpers.ts).
 */

const DAY_COUNT = 20;

type Ctx = ReturnType<typeof realDbContext> & { broadcasts: string[] };

function tripContext(): Ctx {
  const base = realDbContext();
  const broadcasts: string[] = [];
  return Object.assign(base, {
    broadcasts,
    trips: {
      ...base.trips,
      getById: async (tripId: number) => (tripId === 1 ? { id: 1, title: 'Japan' } : null),
      getDays: async () => makeDays(DAY_COUNT, { startDate: '2026-04-10' }),
    },
    ws: {
      broadcastToTrip: async (_tripId: number, event: string) => {
        broadcasts.push(event);
      },
    },
  });
}

const put = routes.find((r) => r.method === 'PUT' && r.path === '/segments')!;

function request(body: Record<string, unknown>): PluginRequest {
  return { method: 'PUT', path: '/segments', query: {}, body, headers: {}, user: null };
}

async function send(ctx: PluginContext, body: Record<string, unknown>) {
  const res = await put.handler(request(body), ctx);
  return { status: res.status, body: JSON.parse(String(res.body)) as Record<string, unknown> };
}

const COLOR = '#4F46E5';
let ctx: Ctx;
let ids: { tokyo: number; kyoto: number; osaka: number; nara: number };

async function layout(): Promise<string[]> {
  return (await listSegments(ctx, 1)).map((r) => `${r.name} ${r.start_day}-${r.end_day}`);
}

beforeEach(async () => {
  resetSchemaMemo();
  ctx = tripContext();
  await ensureSchema(ctx);
  const add = async (name: string, start: number, end: number) =>
    (await insertSegmentIfFree(ctx, 1, { name, color: COLOR, start_day: start, end_day: end }))!.id;
  ids = {
    tokyo: await add('Tokyo', 1, 5),
    kyoto: await add('Kyoto', 6, 10),
    osaka: await add('Osaka', 11, 15),
    nara: await add('Nara', 16, 20),
  };
});

const tokyo = (start: number, end: number) => ({
  tripId: 1,
  id: ids.tokyo,
  name: 'Tokyo',
  color: COLOR,
  start_day: start,
  end_day: end,
});

describe('PUT /segments with other legs', () => {
  it('saves the edited leg and every moved leg together, and broadcasts once', async () => {
    const res = await send(ctx, {
      ...tokyo(1, 7),
      others: [
        { id: ids.kyoto, start_day: 8, end_day: 12 },
        { id: ids.osaka, start_day: 13, end_day: 17 },
        { id: ids.nara, start_day: 18, end_day: 20 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body['segment']).toMatchObject({ id: ids.tokyo, start_day: 1, end_day: 7 });
    expect(res.body['moved']).toHaveLength(3);
    expect(await layout()).toEqual(['Tokyo 1-7', 'Kyoto 8-12', 'Osaka 13-17', 'Nara 18-20']);
    expect(ctx.broadcasts).toEqual(['changed']);
  });

  it('rejects a final layout that still overlaps, and writes nothing', async () => {
    const res = await send(ctx, {
      ...tokyo(1, 7),
      // Kyoto makes room for Tokyo but runs into Osaka, which was left out.
      others: [{ id: ids.kyoto, start_day: 8, end_day: 12 }],
    });

    expect(res.status).toBe(422);
    expect(res.body['issues']).toEqual(['others_invalid']);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
    expect(ctx.broadcasts).toEqual([]);
  });

  it('rejects another leg moved past the end of the trip', async () => {
    const res = await send(ctx, {
      ...tokyo(1, 7),
      others: [
        { id: ids.kyoto, start_day: 8, end_day: 12 },
        { id: ids.osaka, start_day: 13, end_day: 17 },
        { id: ids.nara, start_day: 18, end_day: 22 },
      ],
    });

    expect(res.status).toBe(422);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  it('rejects an edited leg that still overlaps what was left in place', async () => {
    const res = await send(ctx, { ...tokyo(1, 7), others: [{ id: ids.osaka, start_day: 11, end_day: 14 }] });

    expect(res.status).toBe(422);
    expect(res.body['issues']).toEqual(['overlap']);
  });

  it('answers 409 when a leg in the plan no longer exists', async () => {
    const res = await send(ctx, { ...tokyo(1, 7), others: [{ id: 999, start_day: 8, end_day: 10 }] });

    expect(res.status).toBe(409);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  /**
   * The race the route's own validation cannot see: it read the rows, then
   * another tab wrote before the batch ran. Only the in-transaction guard can
   * refuse this, and it must leave every row as the other tab left it.
   */
  it('rolls back when the layout changed between the read and the write', async () => {
    const realQuery = ctx.db.query.bind(ctx.db);
    let raced = false;
    ctx.db.query = (async (sql: string, ...args: unknown[]) => {
      const out = await realQuery(sql, ...args);
      if (!raced && sql.startsWith('SELECT') && sql.includes('ORDER BY start_day')) {
        raced = true;
        // Osaka grows backwards over day 10 right after the route listed the legs.
        await ctx.db.exec('UPDATE segments SET start_day = 9 WHERE id = ?', ids.osaka);
        await ctx.db.exec('UPDATE segments SET end_day = 8 WHERE id = ?', ids.kyoto);
      }
      return out;
    }) as typeof ctx.db.query;

    const res = await send(ctx, {
      ...tokyo(1, 7),
      others: [{ id: ids.kyoto, start_day: 8, end_day: 10 }],
    });

    expect(res.status).toBe(409);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-8', 'Osaka 9-15', 'Nara 16-20']);
    expect(ctx.broadcasts).toEqual([]);
  });

  it('answers 400 for a malformed list of other legs', async () => {
    expect((await send(ctx, { ...tokyo(1, 7), others: 'everything' })).status).toBe(400);
    expect((await send(ctx, { ...tokyo(1, 7), others: [{ id: ids.kyoto }] })).status).toBe(400);
    expect(
      (await send(ctx, { ...tokyo(1, 7), others: [], resolve_end: 'push' })).status,
    ).toBe(400);
  });

  it('treats an empty list as an ordinary update', async () => {
    const res = await send(ctx, { ...tokyo(1, 4), others: [] });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo 1-4', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  it('keeps refusing a plain overlapping update', async () => {
    const res = await send(ctx, tokyo(1, 7));

    expect(res.status).toBe(409);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });
});

describe('PUT /segments with a named resolution', () => {
  it('plans a push server-side, cutting the last leg at the end of the trip', async () => {
    const res = await send(ctx, { ...tokyo(1, 7), resolve_end: 'push' });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo 1-7', 'Kyoto 8-12', 'Osaka 13-17', 'Nara 18-20']);
  });

  it('takes the days from the neighbour only', async () => {
    const res = await send(ctx, { ...tokyo(1, 7), resolve_end: 'take' });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo 1-7', 'Kyoto 8-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  it('pulls the later legs forward when the leg gets shorter', async () => {
    const res = await send(ctx, { ...tokyo(1, 3), resolve_end: 'pull' });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo 1-3', 'Kyoto 4-8', 'Osaka 9-13', 'Nara 14-20']);
  });

  it('gives way at the start of a leg', async () => {
    const res = await send(ctx, {
      tripId: 1,
      id: ids.osaka,
      name: 'Osaka',
      color: COLOR,
      start_day: 9,
      end_day: 15,
      resolve_start: 'take',
    });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-8', 'Osaka 9-15', 'Nara 16-20']);
  });

  it('refuses a resolution that would empty a leg, and writes nothing', async () => {
    const res = await send(ctx, { ...tokyo(1, 10), resolve_end: 'take' });

    expect(res.status).toBe(422);
    expect(res.body['issues']).toEqual(['resolve_end_unavailable']);
    expect(await layout()).toEqual(['Tokyo 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  it('refuses an unknown resolution', async () => {
    expect((await send(ctx, { ...tokyo(1, 7), resolve_end: 'shove' })).status).toBe(400);
  });

  it('is a plain update when the resolution is not needed', async () => {
    const res = await send(ctx, { ...tokyo(1, 5), name: 'Tokyo renamed', resolve_end: 'push' });

    expect(res.status).toBe(200);
    expect(await layout()).toEqual(['Tokyo renamed 1-5', 'Kyoto 6-10', 'Osaka 11-15', 'Nara 16-20']);
  });

  it('is reachable through the update_trip_segment MCP tool', async () => {
    const tool = mcpTools.find((t) => t.name === 'update_trip_segment')!;
    const result = await tool.handler({ ...tokyo(1, 7), resolve_end: 'push' }, ctx);

    expect(result).toMatchObject({ ok: true, segment: { start_day: 1, end_day: 7 } });
    expect(await layout()).toEqual(['Tokyo 1-7', 'Kyoto 8-12', 'Osaka 13-17', 'Nara 18-20']);
  });

  it('answers 404 for a trip the user cannot see', async () => {
    const res = await send(ctx, { ...tokyo(1, 7), tripId: 2, resolve_end: 'push' });
    expect(res.status).toBe(404);
  });
});
