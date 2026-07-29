import type { PluginContext } from '../shared/host-types';

export const MIGRATION_ID = '001-segments';

/**
 * `ctx.db.migrate` is idempotent per id in production, but `trek-plugin dev`
 * tracks applied ids in an in-memory Set and therefore re-runs every migration
 * on each restart against the same file. Everything here must survive that, so
 * every statement is IF NOT EXISTS.
 *
 * `start_day`/`end_day` are 1-based ORDINAL POSITIONS in the trip's day list,
 * not `days.day_number` (which gaps when a day is deleted) and not dates (which
 * are nullable). There is no colour column: the palette is exactly the host's
 * four tones, so hex is derived and can never drift from what the map draws.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  tone       TEXT NOT NULL DEFAULT 'default',
  start_day  INTEGER NOT NULL,
  end_day    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_day >= 1),
  CHECK (end_day >= start_day),
  CHECK (tone IN ('default','success','warn','danger'))
);
CREATE INDEX IF NOT EXISTS idx_segments_trip ON segments(trip_id, start_day);
`;

let pending: Promise<void> | null = null;

/**
 * Run the migration at most once per child process. Routes and hooks both call
 * this because `onLoad` runs userless and a hook can be the first thing invoked
 * after a restart. On failure the memo is cleared so the next call retries
 * rather than caching a rejected promise forever.
 */
export function ensureSchema(ctx: PluginContext): Promise<void> {
  if (!pending) {
    pending = ctx.db
      .migrate(MIGRATION_ID, MIGRATION_SQL)
      .then(() => undefined)
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

/** Test seam — lets a test start from a clean memo. */
export function resetSchemaMemo(): void {
  pending = null;
}
