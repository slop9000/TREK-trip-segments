import { buildDayIndex, resolveAll } from '../../shared/drift';
import { DAY_TINT_MAX } from '../../shared/limits';
import { safeLabel } from '../../shared/format';
import { listSegments } from '../repo';
import { ensureSchema } from '../schema';
import type { DayTintContribution, PluginContext } from '../../shared/host-types';
import { DEFAULT_TINT_MODE, coerceTintMode } from '../../shared/types';
import type { DayIndex, SegmentView, TintMode } from '../../shared/types';

/**
 * Paint every day of a leg in that leg's colour, so leg membership is visible
 * while scrolling the itinerary rather than only at the two banner days.
 *
 * Shipped in TREK 4.0.0 (#1743) and granted since plugin 1.2.0.
 *
 * Where the day-schedule hook must ration 60 items across a whole trip, this one
 * is bounded by the day count, which is the entire reason it exists.
 */
export function buildTints(
  views: readonly SegmentView[],
  idx: DayIndex,
  mode: TintMode = DEFAULT_TINT_MODE,
): DayTintContribution[] {
  if (mode === 'off') return [];
  const out: DayTintContribution[] = [];

  for (const view of views) {
    // An out_of_range leg owns no days, so it tints nothing.
    if (view.effStart === null || view.effEnd === null) continue;

    const label = safeLabel(view.name, view.index).slice(0, 60);

    for (let pos = view.effStart; pos <= view.effEnd; pos++) {
      if (out.length >= DAY_TINT_MAX) return out;
      const dayId = idx.dayIdByPos[pos - 1];
      if (dayId === undefined) continue;

      // Build by OMITTING the regions this mode does not paint, never by passing
      // null or an empty string: the host's `named()` treats null as "unnamed" so
      // the region would inherit a shorthand, and a junk non-null value degrades
      // that region to tone `default` — indigo, not absent.
      //
      // `full-day` uses the `color` shorthand rather than naming all three: the
      // host spreads it across badge + header + activity itself, so the output is
      // identical and the payload smaller.
      //
      // The default stays header-badge because a leg is context, not content. The
      // header carries the day number, title and date, so tinting it answers
      // "which leg is this day" every time the day scrolls past; the badge repeats
      // it as a small solid mark at roughly twice the alpha (--day-tint-badge, 16%
      // light / 24% dark) so it reads at a glance. Tinting the activity list too
      // is now the user's call — worth knowing that day-note cards already paint
      // their own colour at 11%, only ~1.8x the activity tint, so `full-day`
      // shifts the perceived hue of the user's own note colour-coding.
      out.push(
        mode === 'full-day'
          ? { dayId, color: view.color, label }
          : mode === 'badge-only'
            ? { dayId, badgeColor: view.color, label }
            : { dayId, headerColor: view.color, badgeColor: view.color, label },
      );
    }
  }

  return out;
}

/**
 * The viewer's chosen tint mode.
 *
 * Its OWN try/catch on purpose: getDayTints' outer catch returns [], so letting a
 * transient settings RPC failure fall through there would silently remove every
 * tint rather than fall back to the default. Costs one RPC round trip against the
 * hook's 5000 ms budget, alongside the two queries already here.
 *
 * `ctx.settings` is optional in our local type for test doubles; the host always
 * provides it.
 */
async function readTintMode(ctx: PluginContext): Promise<TintMode> {
  try {
    return coerceTintMode(await ctx.settings?.get('tintMode'));
  } catch {
    return DEFAULT_TINT_MODE;
  }
}

export async function getDayTints(tripId: number, ctx: PluginContext): Promise<DayTintContribution[]> {
  try {
    await ensureSchema(ctx);

    // Segments first: most trips have none, and this way they cost one query
    // rather than also pulling the whole day list.
    const rows = await listSegments(ctx, tripId);
    if (rows.length === 0) return [];

    // Read the preference only once there is something to paint, so a trip with
    // no legs keeps costing exactly one query.
    const mode = await readTintMode(ctx);
    if (mode === 'off') return [];

    const idx = buildDayIndex(await ctx.trips.getDays(tripId));
    return buildTints(resolveAll(rows, idx), idx, mode);
  } catch (err) {
    ctx.log.warn('dayTintProvider failed', {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
