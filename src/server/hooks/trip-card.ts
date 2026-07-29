import { TRIP_CARD_MAX_TRIPS, TRIP_CARD_NAME_PREVIEW } from '../../shared/limits';
import { plural, safeLabel } from '../../shared/format';
import { listSegmentsForTrips } from '../repo';
import { ensureSchema } from '../schema';
import type { PluginContext, TripCardContribution } from '../../shared/host-types';
import type { TripSegmentSummary } from '../repo';

/**
 * Build one badge per trip that has segments.
 *
 * `tripId` must be a real number: the host checks `typeof c.tripId === 'number'`
 * and silently drops the badge otherwise (trip-card-contributions.controller.ts:60),
 * so a driver handing back a numeric string would produce a badge that never
 * appears with no error anywhere.
 */
export function buildCards(rows: readonly TripSegmentSummary[]): TripCardContribution[] {
  const namesByTrip = new Map<number, string[]>();
  for (const row of rows) {
    const names = namesByTrip.get(row.trip_id);
    if (names) names.push(row.name);
    else namesByTrip.set(row.trip_id, [row.name]);
  }

  const cards: TripCardContribution[] = [];
  for (const [tripId, names] of namesByTrip) {
    const preview = names.slice(0, TRIP_CARD_NAME_PREVIEW).map((n, i) => safeLabel(n, i));
    const extra = names.length - preview.length;

    cards.push({
      tripId,
      id: 'segments',
      label: plural(names.length, 'leg', 'legs'),
      value: (preview.join(', ') + (extra > 0 ? ` +${extra}` : '')).slice(0, 256),
      icon: 'Route',
      tone: 'default',
    });
  }
  return cards;
}

export async function getCards(tripIds: number[], ctx: PluginContext): Promise<TripCardContribution[]> {
  try {
    if (!Array.isArray(tripIds) || tripIds.length === 0) return [];

    const ids = tripIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, TRIP_CARD_MAX_TRIPS);
    if (ids.length === 0) return [];

    await ensureSchema(ctx);

    // Exactly one query and zero ctx.trips.* calls. The host already
    // access-checked every id, and per-trip reads across 60 cards would blow
    // both the 5s hook timeout and an RPC limit that rejects rather than queues.
    return buildCards(await listSegmentsForTrips(ctx, ids));
  } catch (err) {
    ctx.log.warn('tripCardProvider failed', {
      count: tripIds?.length ?? 0,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
