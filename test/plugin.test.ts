import { describe, expect, it } from 'vitest';
import { createMockHost } from 'trek-plugin-sdk/testing';
import { HOOK_PERMISSION, KNOWN_PERMISSIONS } from 'trek-plugin-sdk';
import manifest from '../trek-plugin.json';
import plugin from '../src/server/index';
import { SQL_INSERT_IF_FREE, SQL_LIST } from '../src/server/repo';
import { makeDays } from './helpers';

describe('manifest and code agree', () => {
  it('grants a permission for every hook it implements', () => {
    const granted = new Set<string>(manifest.permissions);
    const gaps = Object.keys(plugin.hooks ?? {})
      .filter((hook) => !granted.has(HOOK_PERMISSION[hook] ?? `hook:UNKNOWN(${hook})`))
      .map((hook) => `${hook} needs ${HOOK_PERMISSION[hook] ?? '???'}`);

    // An implemented-but-ungranted hook installs, activates, and then silently
    // never runs — providersOf() drops it with no error anywhere.
    expect(gaps).toEqual([]);
  });

  it('knows the permission name of every hook it implements', () => {
    for (const hook of Object.keys(plugin.hooks ?? {})) {
      expect(HOOK_PERMISSION[hook], `no permission mapped for ${hook}`).toBeDefined();
    }
  });

  /**
   * The one that protects installs everywhere: declaring a permission the host
   * does not know is fatal, not a graceful degradation — install/manifest.ts
   * throws and the plugin never installs. The manifest's `trek` range is what
   * keeps this honest, so this asserts against the SDK pinned to that range.
   */
  it('never ships a permission outside the TREK line it targets', () => {
    for (const permission of manifest.permissions) {
      expect(KNOWN_PERMISSIONS, `${permission} is not a permission TREK 4 knows`).toContain(permission);
    }
  });

  it('declares db:own and db:read:trips, which every route depends on', () => {
    expect(manifest.permissions).toContain('db:own');
    expect(manifest.permissions).toContain('db:read:trips');
    expect(manifest.permissions).toContain('ws:broadcast:trip');
  });

  it('uses flat route paths, because matching is exact string equality', () => {
    for (const route of plugin.routes ?? []) {
      expect(route.path.startsWith('/')).toBe(true);
      expect(route.path).not.toMatch(/:/); // no `:param` support in the proxy
      expect(route.path).not.toMatch(/\/$/); // a trailing slash would never match
      expect(route.auth).not.toBe(false);
    }
  });

  it('documents every permission verbatim in the README, as the registry requires', async () => {
    const readme = await import('node:fs').then((fs) => fs.readFileSync('README.md', 'utf8'));
    for (const permission of manifest.permissions) {
      expect(readme, `README is missing ${permission}`).toContain(permission);
    }
  });
});

describe('MCP tools', () => {
  const tool = (name: string) => {
    const found = plugin.mcpTools?.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing MCP tool ${name}`);
    return found;
  };

  it('declares a complete, collision-resistant segment tool set', () => {
    expect(plugin.mcpTools?.map((candidate) => candidate.name)).toEqual([
      'list_trip_segments',
      'get_trip_segment',
      'create_trip_segment',
      'update_trip_segment',
      'delete_trip_segment',
    ]);
    expect(tool('list_trip_segments').annotations?.readOnlyHint).toBe(true);
    expect(tool('create_trip_segment').annotations?.readOnlyHint).toBe(false);
    expect(tool('delete_trip_segment').annotations?.destructiveHint).toBe(true);
  });

  it('uses the existing authenticated write path and broadcasts a successful MCP create', async () => {
    const created = [
      { id: 7, trip_id: 1, name: 'Tokyo', color: '#123ABC', tone: 'default', start_day: 1, end_day: 5, created_at: 'x', updated_at: 'x' },
    ];
    const host = hostFor([1], { [SQL_INSERT_IF_FREE]: created });

    const result = await tool('create_trip_segment').handler(
      { tripId: 1, name: 'Tokyo', color: '#123abc', start_day: 1, end_day: 5 },
      host.ctx as never,
    );

    expect(result).toMatchObject({ ok: true, segment: { id: 7, name: 'Tokyo', color: '#123ABC' } });
    expect(host.broadcasts).toHaveLength(1);
  });

  it('does not let an MCP caller manage a trip they cannot access', async () => {
    const host = hostFor([2]);

    const result = await tool('list_trip_segments').handler({ tripId: 1 }, host.ctx as never);

    expect(result).toMatchObject({ ok: false, status: 404, error: 'not_found' });
  });
});

const ROUTE = (path: string, method = 'GET') => ({ method, path });

/**
 * The published SDK's `PluginDefinition` is a release behind the host: its `Day`
 * has no `assignments` or `notes_items`, even though `DaysService.list()` really
 * does return them (days.service.ts:175-229), and its hook map knows nothing of
 * `dayScheduleProvider` or `mapLayerProvider`. The runtime shapes agree — only
 * the type declarations lag — so this cast is confined to the test boundary and
 * never appears in shipped code.
 */
const asSdkPlugin = (def: typeof plugin): never => def as never;

function hostFor(members: number[], queryResults: Record<string, unknown[]> = {}) {
  return createMockHost({
    actingUserId: 1,
    grants: manifest.permissions,
    trips: {
      1: {
        members,
        data: { id: 1, title: 'Japan', start_date: '2026-04-10', end_date: '2026-04-21' },
        days: makeDays(12, { startDate: '2026-04-10' }),
        reservations: [],
        accommodations: [],
      },
    },
    queryResults,
  });
}

describe('trip access', () => {
  /**
   * The reason `withTrip` exists. `ctx.trips.getById` THROWS for a non-member
   * (rpc-host.ts:1167) rather than returning null, and an uncaught throw in a
   * handler is turned into a 502 "Plugin error" by the proxy — which reads to
   * the user as a broken plugin rather than a missing trip.
   */
  it('answers 404, not a rejection, when the user is not a member', async () => {
    const driver = hostFor([2]).run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/overview'), { query: { tripId: '1' } });

    expect(res.status).toBe(404);
  });

  it('answers 404 for a trip that does not exist at all', async () => {
    const driver = hostFor([1]).run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/overview'), { query: { tripId: '999' } });

    expect(res.status).toBe(404);
  });

  it('answers 400 without a tripId', async () => {
    const driver = hostFor([1]).run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/overview'), { query: {} });

    expect(res.status).toBe(400);
  });
});

describe('overview', () => {
  it('reports the day count and full coverage gap with no segments', async () => {
    const driver = hostFor([1], { [SQL_LIST]: [] }).run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/overview'), { query: { tripId: '1' } });
    const body = JSON.parse(String(res.body));

    expect(res.status).toBe(200);
    expect(body.dayCount).toBe(12);
    expect(body.segments).toEqual([]);
    expect(body.uncovered).toEqual([[1, 12]]);
    expect(body.days[0]).toMatchObject({ pos: 1, date: '2026-04-10' });
  });

  it('resolves a stored segment against the current day count', async () => {
    const rows = [
      { id: 1, trip_id: 1, name: 'Tokyo', tone: 'default', start_day: 1, end_day: 5, created_at: 'x', updated_at: 'x' },
      // Runs past day 12 — must come back clipped, not dropped.
      { id: 2, trip_id: 1, name: 'Kyoto', tone: 'warn', start_day: 10, end_day: 30, created_at: 'x', updated_at: 'x' },
      // Starts past the end of the trip entirely.
      { id: 3, trip_id: 1, name: 'Ghost', tone: 'danger', start_day: 40, end_day: 45, created_at: 'x', updated_at: 'x' },
    ];
    const driver = hostFor([1], { [SQL_LIST]: rows }).run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/overview'), { query: { tripId: '1' } });
    const body = JSON.parse(String(res.body));

    expect(body.segments.map((s: { status: string }) => s.status)).toEqual(['ok', 'clipped', 'out_of_range']);
    expect(body.segments[1]).toMatchObject({ effStart: 10, effEnd: 12, effLength: 3 });
    expect(body.segments[2]).toMatchObject({ effStart: null, effEnd: null, effLength: 0 });
    expect(body.uncovered).toEqual([[6, 9]]);
  });
});

describe('writes', () => {
  const created = [
    { id: 7, trip_id: 1, name: 'Tokyo', color: '#12ABEF', tone: 'success', start_day: 1, end_day: 5, created_at: 'x', updated_at: 'x' },
  ];

  it('broadcasts to the trip after a successful create', async () => {
    const host = hostFor([1], { [SQL_INSERT_IF_FREE]: created });
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: { tripId: 1, name: 'Tokyo', color: '#12abef', start_day: 1, end_day: 5 },
    });

    expect(res.status).toBe(200);
    expect(host.broadcasts).toHaveLength(1);
    expect(host.broadcasts[0]).toMatchObject({ event: 'changed' });
  });

  it('returns 409 and does not broadcast when the atomic guard refuses', async () => {
    // No stub for SQL_INSERT_IF_FREE, so it yields zero rows — exactly what the
    // real statement does when the range overlaps or the limit is reached.
    const host = hostFor([1]);
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: { tripId: 1, name: 'Tokyo', tone: 'default', start_day: 1, end_day: 5 },
    });

    expect(res.status).toBe(409);
    expect(host.broadcasts).toHaveLength(0);
  });

  it('rejects an unsafe custom colour instead of falling back to a supplied tone', async () => {
    const host = hostFor([1]);
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: {
        tripId: 1,
        name: 'Tokyo',
        color: 'red 50%, transparent), url(https://evil.example/x.png',
        tone: 'default',
        start_day: 1,
        end_day: 5,
      },
    });

    expect(res.status).toBe(400);
    expect(host.broadcasts).toHaveLength(0);
  });

  it('still accepts a tone-only request from an older client', async () => {
    const host = hostFor([1], { [SQL_INSERT_IF_FREE]: created });
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: { tripId: 1, name: 'Tokyo', tone: 'default', start_day: 1, end_day: 5 },
    });

    expect(res.status).toBe(200);
  });

  it('rejects a range past the end of the trip before touching the database', async () => {
    const host = hostFor([1]);
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: { tripId: 1, name: 'Too long', tone: 'default', start_day: 1, end_day: 99 },
    });

    expect(res.status).toBe(422);
    expect(JSON.parse(String(res.body)).issues).toContain('range_out_of_bounds');
  });

  it('never lets a non-member write', async () => {
    const host = hostFor([2], { [SQL_INSERT_IF_FREE]: created });
    const driver = host.run(asSdkPlugin(plugin));

    const res = await driver.route(ROUTE('/segments', 'POST'), {
      body: { tripId: 1, name: 'Tokyo', tone: 'default', start_day: 1, end_day: 5 },
    });

    expect(res.status).toBe(404);
    expect(host.broadcasts).toHaveLength(0);
  });
});
