import { buildDayIndex, resolveAll } from '../../shared/drift';
import { DAY_TINT_MAX } from '../../shared/limits';
import { safeLabel } from '../../shared/format';
import { listSegments } from '../repo';
import { ensureSchema } from '../schema';
import type { DayTintContribution, PluginContext } from '../../shared/host-types';
import type { DayIndex, SegmentView } from '../../shared/types';

/**
 * Paint every day of a leg in that leg's colour, so leg membership is visible
 * while scrolling the itinerary rather than only at the two banner days.
 *
 * This hook does not exist in upstream TREK yet — see `DayTintContribution` in
 * shared/host-types.ts. Registering it is harmless on a host that has never
 * heard of it: `providersOf('dayTintProvider')` finds no permission mapping and
 * returns nothing, so the hook is simply never invoked.
 *
 * Where the day-schedule hook must ration 60 items across a whole trip, this one
 * is bounded by the day count, which is the entire reason it exists.
 */
export function buildTints(views: readonly SegmentView[], idx: DayIndex): DayTintContribution[] {
  const out: DayTintContribution[] = [];

  for (const view of views) {
    // An out_of_range leg owns no days, so it tints nothing.
    if (view.effStart === null || view.effEnd === null) continue;

    const label = safeLabel(view.name, view.index).slice(0, 60);

    for (let pos = view.effStart; pos <= view.effEnd; pos++) {
      if (out.length >= DAY_TINT_MAX) return out;
      const dayId = idx.dayIdByPos[pos - 1];
      if (dayId === undefined) continue;

      // Header and badge, but deliberately NOT the `color` shorthand — that would
      // also wash the activity list.
      //
      // A leg is context, not content. The header carries the day number, title
      // and date, so tinting it answers "which leg is this day" every time the
      // day scrolls past; the badge repeats it as a small solid mark, which the
      // host paints at roughly twice the header's alpha (--day-tint-badge, 16%
      // light / 24% dark) so it reads at a glance. The dense list of places and
      // bookings below stays on a plain background, where it is easiest to read.
      out.push({ dayId, headerColor: view.color, badgeColor: view.color, label });
    }
  }

  return out;
}

export async function getDayTints(tripId: number, ctx: PluginContext): Promise<DayTintContribution[]> {
  try {
    await ensureSchema(ctx);

    // Segments first: most trips have none, and this way they cost one query
    // rather than also pulling the whole day list.
    const rows = await listSegments(ctx, tripId);
    if (rows.length === 0) return [];

    const idx = buildDayIndex(await ctx.trips.getDays(tripId));
    return buildTints(resolveAll(rows, idx), idx);
  } catch (err) {
    ctx.log.warn('dayTintProvider failed', {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
