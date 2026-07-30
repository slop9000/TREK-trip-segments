import type { PluginContext } from '../shared/host-types';

export const MIGRATION_ID = '001-segments';
export const COLOR_MIGRATION_ID = '002-segment-color';
export const SQL_PROBE_COLOR = 'SELECT color FROM segments LIMIT 0';

/**
 * `ctx.db.migrate` is idempotent per id in production, but `trek-plugin dev`
 * tracks applied ids in an in-memory Set and therefore re-runs the base
 * migration on each restart against the same file. Its statements must remain
 * IF NOT EXISTS-safe; the additive colour migration is separately probe-gated.
 *
 * `start_day`/`end_day` are 1-based ORDINAL POSITIONS in the trip's day list,
 * not `days.day_number` (which gaps when a day is deleted) and not dates (which
 * are nullable). `tone` remains as a compatibility fallback for host hooks that
 * have not gained a hex colour channel.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4F46E5',
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

/**
 * Existing installations have the original tone-only table. We probe before
 * applying this migration because the dev host forgets applied migration ids on
 * restart while keeping the database file.
 */
export const COLOR_MIGRATION_SQL = `
ALTER TABLE segments ADD COLUMN color TEXT;
UPDATE segments
SET color = CASE tone
  WHEN 'success' THEN '#10B981'
  WHEN 'warn' THEN '#F59E0B'
  WHEN 'danger' THEN '#EF4444'
  ELSE '#4F46E5'
END
WHERE color IS NULL;
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
    pending = (async () => {
      await ctx.db.migrate(MIGRATION_ID, MIGRATION_SQL);
      try {
        await ctx.db.query(SQL_PROBE_COLOR);
      } catch {
        await ctx.db.migrate(COLOR_MIGRATION_ID, COLOR_MIGRATION_SQL);
      }
    })()
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
