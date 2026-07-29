import { buildDayIndex, resolveAll } from '../../shared/drift';
import { DAY_SCHEDULE_MAX_ITEMS } from '../../shared/limits';
import { plural, safeLabel } from '../../shared/format';
import { listSegments } from '../repo';
import { ensureSchema } from '../schema';
import type { DayScheduleContribution, PluginContext } from '../../shared/host-types';
import type { DayIndex, SegmentView } from '../../shared/types';

interface LiveSegment {
  view: SegmentView;
  start: number;
  end: number;
}

function liveSegments(views: readonly SegmentView[]): LiveSegment[] {
  const out: LiveSegment[] = [];
  for (const view of views) {
    // An out_of_range leg has no days to attach a banner to.
    if (view.effStart === null || view.effEnd === null) continue;
    out.push({ view, start: view.effStart, end: view.effEnd });
  }
  return out;
}

/**
 * Banners marking where each leg starts and ends.
 *
 * The host caps a provider at 60 items and truncates in the order WE return
 * them (day-schedule.controller.ts:52), so every "begins" banner is emitted
 * before any "ends" banner: with our own 40-segment limit the starts always fit,
 * and only the less important end markers can ever be cut.
 *
 * Deliberately no `minutes`: the day plan sums that field into the day's
 * route-time footer (PluginDaySchedule.tsx:59), so a leg banner claiming
 * duration would corrupt a number the user reads as travel time.
 */
export function buildItems(views: readonly SegmentView[], idx: DayIndex): DayScheduleContribution[] {
  const live = liveSegments(views);
  const total = live.length;
  const items: DayScheduleContribution[] = [];

  live.forEach(({ view, start }, i) => {
    if (items.length >= DAY_SCHEDULE_MAX_ITEMS) return;
    const dayId = idx.dayIdByPos[start - 1];
    if (dayId === undefined) return;

    items.push({
      id: `seg-${view.id}-start`,
      dayId,
      position: 'start',
      tone: view.tone,
      label: `${safeLabel(view.name, view.index)} begins - leg ${i + 1} of ${total}, ${plural(view.effLength, 'day', 'days')}`,
    });
  });

  live.forEach(({ view, start, end }) => {
    if (items.length >= DAY_SCHEDULE_MAX_ITEMS) return;
    // A one-day leg already says everything in its start banner.
    if (end === start) return;
    const dayId = idx.dayIdByPos[end - 1];
    if (dayId === undefined) return;

    items.push({
      id: `seg-${view.id}-end`,
      dayId,
      position: 'end',
      tone: view.tone,
      label: `${safeLabel(view.name, view.index)} ends`,
    });
  });

  return items;
}

export async function getSchedule(tripId: number, ctx: PluginContext): Promise<DayScheduleContribution[]> {
  try {
    await ensureSchema(ctx);

    // Segments first: most trips have none, and this way they cost one query
    // rather than also pulling the whole day list.
    const rows = await listSegments(ctx, tripId);
    if (rows.length === 0) return [];

    const idx = buildDayIndex(await ctx.trips.getDays(tripId));
    return buildItems(resolveAll(rows, idx), idx);
  } catch (err) {
    // A throw here contributes nothing and is never surfaced, so log it or it
    // is invisible.
    ctx.log.warn('dayScheduleProvider failed', {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
