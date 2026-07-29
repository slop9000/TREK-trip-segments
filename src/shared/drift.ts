import type { HostDay } from './host-types';
import type { DayIndex, DayRange, SegmentRow, SegmentView } from './types';

/**
 * Build the ordinal index for a trip's days.
 *
 * Positions are 1-based array positions, deliberately NOT `day_number`:
 * `DaysService.remove()` is a bare DELETE with no renumber, so day_number
 * develops permanent gaps, while the planner labels each day by its array index
 * + 1. Anchoring to positions is therefore both stable and the same "Day N" the
 * user reads on screen.
 *
 * `days` must be the array from `ctx.trips.getDays()`, which is ordered by
 * day_number ascending.
 */
export function buildDayIndex(days: HostDay[]): DayIndex {
  const posByDayId = new Map<number, number>();
  const dayIdByPos: number[] = [];
  const dateByPos: Array<string | null> = [];

  days.forEach((day, i) => {
    posByDayId.set(day.id, i + 1);
    dayIdByPos.push(day.id);
    dateByPos.push(day.date ?? null);
  });

  return { count: days.length, posByDayId, dayIdByPos, dateByPos };
}

/** Resolve one stored row against the trip's current length. */
export function resolveSegment(row: SegmentRow, dayCount: number, index: number, dateByPos?: Array<string | null>): SegmentView {
  const start = Math.max(1, row.start_day);

  if (dayCount === 0 || start > dayCount) {
    return {
      ...row,
      index,
      status: 'out_of_range',
      effStart: null,
      effEnd: null,
      effLength: 0,
      startDate: null,
      endDate: null,
    };
  }

  const effEnd = Math.min(row.end_day, dayCount);
  return {
    ...row,
    index,
    status: row.end_day > dayCount ? 'clipped' : 'ok',
    effStart: start,
    effEnd,
    effLength: effEnd - start + 1,
    startDate: dateByPos?.[start - 1] ?? null,
    endDate: dateByPos?.[effEnd - 1] ?? null,
  };
}

/**
 * Sort by start day (id as a stable tiebreak) and resolve each row. Sorting here
 * rather than relying on SQL keeps the "leg N of M" numbering consistent for
 * every caller, including the hooks that must emit their most important entries
 * first because the host's caps truncate in array order.
 */
export function resolveAll(rows: SegmentRow[], idx: DayIndex): SegmentView[] {
  return [...rows]
    .sort((a, b) => a.start_day - b.start_day || a.id - b.id)
    .map((row, i) => resolveSegment(row, idx.count, i, idx.dateByPos));
}

/** Does an inclusive `[lo, hi]` day-position span touch this segment? */
export function spanTouches(lo: number, hi: number, view: SegmentView): boolean {
  return view.effStart !== null && view.effEnd !== null && lo <= view.effEnd && hi >= view.effStart;
}

/**
 * Day positions covered by no segment, as inclusive ranges. Gaps between legs
 * are legal, so this is a hint rather than an error — but leaving it invisible
 * is how days quietly go unplanned.
 */
export function uncoveredRanges(views: readonly SegmentView[], dayCount: number): DayRange[] {
  const covered: DayRange[] = [];
  for (const v of views) {
    if (v.effStart !== null && v.effEnd !== null) covered.push([v.effStart, v.effEnd]);
  }
  covered.sort((a, b) => a[0] - b[0]);

  const out: DayRange[] = [];
  let cursor = 1;
  for (const [lo, hi] of covered) {
    if (lo > cursor) out.push([cursor, lo - 1]);
    cursor = Math.max(cursor, hi + 1);
  }
  if (cursor <= dayCount) out.push([cursor, dayCount]);
  return out;
}

/** Total day positions covered by at least one segment. */
export function coveredDayCount(views: readonly SegmentView[], dayCount: number): number {
  return dayCount - uncoveredRanges(views, dayCount).reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
}
