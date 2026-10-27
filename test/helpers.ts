import { DatabaseSync } from 'node:sqlite';
import type { HostDay, PluginContext } from '../src/shared/host-types';

/**
 * A PluginContext backed by a REAL sqlite database.
 *
 * `createMockHost`'s db is a recorder that answers `query()` from a map keyed by
 * the exact SQL string, so it can prove which statement ran but never that the
 * statement works. Since the whole overlap/limit guard lives inside one SQL
 * statement, and `INSERT ... RETURNING` through `.iterate()` is the one thing
 * the plan flagged as unverified, these tests execute the real thing.
 *
 * node:sqlite is what `trek-plugin dev` uses; production uses better-sqlite3.
 * Both implement RETURNING, and only anonymous `?` placeholders are used so the
 * two agree on binding.
 */
export function realDbContext(): PluginContext & { close(): void } {
  const db = new DatabaseSync(':memory:');

  return {
    id: 'trip-segments',
    db: {
      query: async <T>(sql: string, ...args: unknown[]): Promise<T[]> =>
        db.prepare(sql).all(...(args as never[])) as T[],
      exec: async (sql: string, ...args: unknown[]) => {
        if (args.length === 0) {
          db.exec(sql);
          return { changes: 0 };
        }
        return { changes: Number(db.prepare(sql).run(...(args as never[])).changes) };
      },
      migrate: async (_id: string, sql: string) => {
        db.exec(sql);
        return { applied: true };
      },
      // All or nothing, like the host's PluginDataDb.tx: a statement that throws
      // rolls back every earlier one in the batch.
      tx: async (ops: Array<{ sql: string; args?: unknown[] }>) => {
        db.exec('BEGIN');
        try {
          const results = ops.map((op) => {
            const stmt = db.prepare(op.sql);
            const args = (op.args ?? []) as never[];
            return /^\s*(SELECT|WITH|VALUES)\b/i.test(op.sql) || /\bRETURNING\b/i.test(op.sql)
              ? { rows: stmt.all(...args) as unknown[] }
              : { changes: Number(stmt.run(...args).changes) };
          });
          db.exec('COMMIT');
          return { results };
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      },
    },
    trips: {
      getById: async () => null,
      getDays: async () => [],
      getReservations: async () => [],
      getAccommodations: async () => [],
    },
    ws: { broadcastToTrip: async () => undefined },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    close: () => db.close(),
  };
}

/** Minimal days, with control over ids and dates. */
export function makeDays(count: number, opts: { firstId?: number; startDate?: string | null } = {}): HostDay[] {
  const firstId = opts.firstId ?? 101;
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    trip_id: 1,
    date: opts.startDate === null || opts.startDate === undefined ? null : addDays(opts.startDate, i),
    title: `Day ${i + 1}`,
    assignments: [],
    notes_items: [],
  }));
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
