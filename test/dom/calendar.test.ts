// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMonths, renderCalendar, renderLegend, segmentByPosition } from '../../client-src/views/calendar';
import { colorFill, hexForTone } from '../../src/shared/palette';
import type { OverviewDay, OverviewPayload, SegmentView } from '../../src/shared/types';
import type { Tone } from '../../src/shared/host-types';

function view(id: number, start: number, end: number, tone: Tone = 'default', name = `Leg ${id}`): SegmentView {
  return {
    id,
    trip_id: 1,
    name,
    color: hexForTone(tone),
    tone,
    start_day: start,
    end_day: end,
    created_at: 'x',
    updated_at: 'x',
    index: id - 1,
    status: 'ok',
    effStart: start,
    effEnd: end,
    effLength: end - start + 1,
    startDate: null,
    endDate: null,
  };
}

/** `count` days starting at `startDate`, or undated when it is null. */
function makeDays(count: number, startDate: string | null): OverviewDay[] {
  return Array.from({ length: count }, (_, i) => {
    let date: string | null = null;
    if (startDate) {
      const [y, m, d] = startDate.split('-').map(Number);
      const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
      dt.setUTCDate(dt.getUTCDate() + i);
      date = dt.toISOString().slice(0, 10);
    }
    return { id: 100 + i, pos: i + 1, date, title: `Day ${i + 1}`, assignmentCount: i % 3 };
  });
}

function overview(days: OverviewDay[], segments: SegmentView[]): OverviewPayload {
  return {
    trip: { id: 1, title: 'Japan', start_date: null, end_date: null },
    dayCount: days.length,
    days,
    segments,
    uncovered: [],
    unassigned: { bookings: 0, stays: 0 },
  };
}

let node: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  node = document.createElement('div');
  document.body.append(node);
});

describe('day ownership', () => {
  it('maps every covered position to its leg', () => {
    const owner = segmentByPosition([view(1, 1, 3), view(2, 5, 6)], 7);
    expect(owner.map((s) => s?.id ?? null)).toEqual([1, 1, 1, null, 2, 2, null]);
  });

  it('ignores legs that fall outside the trip', () => {
    const gone = { ...view(9, 40, 45), effStart: null, effEnd: null, status: 'out_of_range' as const };
    expect(segmentByPosition([gone], 3).every((s) => s === null)).toBe(true);
  });
});

describe('month layout', () => {
  it('pads the first week so dates land under the right weekday', () => {
    // 1 April 2026 is a Wednesday, so Monday-first leaves two blanks.
    const months = buildMonths(overview(makeDays(18, '2026-04-10'), [view(1, 1, 5)]));

    expect(months).toHaveLength(1);
    expect(months[0]?.label).toBe('April 2026');
    expect(months[0]?.cells.slice(0, 2).every((c) => c.date === null)).toBe(true);
    expect(months[0]?.cells[2]).toMatchObject({ date: 1, pos: null });
    expect(months[0]?.cells).toHaveLength(2 + 30);
  });

  it('renders whole months, marking dates outside the trip', () => {
    const months = buildMonths(overview(makeDays(18, '2026-04-10'), []));
    const inTrip = months[0]?.cells.filter((c) => c.pos !== null) ?? [];
    const outside = months[0]?.cells.filter((c) => c.date !== null && c.pos === null) ?? [];

    expect(inTrip).toHaveLength(18);
    expect(outside).toHaveLength(12); // 1–9 and 28–30 April
    expect(inTrip[0]).toMatchObject({ date: 10, pos: 1 });
  });

  it('splits a trip that crosses a month boundary', () => {
    const months = buildMonths(overview(makeDays(30, '2026-04-20'), [view(1, 1, 30)]));
    expect(months.map((m) => m.label)).toEqual(['April 2026', 'May 2026']);
  });

  it('attaches each day to the leg that owns it', () => {
    const months = buildMonths(overview(makeDays(10, '2026-04-10'), [view(1, 1, 5), view(2, 6, 10)]));
    const byPos = new Map((months[0]?.cells ?? []).filter((c) => c.pos).map((c) => [c.pos, c.segment?.id]));

    expect(byPos.get(1)).toBe(1);
    expect(byPos.get(5)).toBe(1);
    expect(byPos.get(6)).toBe(2);
  });

  /** `days.date` is nullable in TREK, so a calendar cannot always be laid out. */
  it('returns nothing for a trip with no dates', () => {
    expect(buildMonths(overview(makeDays(5, null), [view(1, 1, 5)]))).toEqual([]);
  });
});

describe('calendar rendering', () => {
  it('tints a covered day with its leg colour and makes it clickable', () => {
    const onOpen = vi.fn();
    renderCalendar(node, overview(makeDays(10, '2026-04-10'), [view(1, 1, 5, 'success')]), null, onOpen);

    const covered = node.querySelectorAll('.seg-cal-cell--in:not(.seg-cal-cell--bare)');
    expect(covered).toHaveLength(5);
    expect((covered[0] as HTMLElement).style.backgroundColor).toBe(colorFill('#10B981', 0.18));

    (covered[0] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('marks trip days that belong to no leg as unclaimed, not merely empty', () => {
    renderCalendar(node, overview(makeDays(10, '2026-04-10'), [view(1, 1, 5)]), null, vi.fn());
    expect(node.querySelectorAll('.seg-cal-cell--bare')).toHaveLength(5);
  });

  it('shows the day ordinal alongside the date', () => {
    renderCalendar(node, overview(makeDays(3, '2026-04-10'), [view(1, 1, 3)]), null, vi.fn());
    const first = node.querySelector('.seg-cal-cell--in');
    expect(first?.querySelector('.seg-cal-date')?.textContent).toBe('10');
    expect(first?.querySelector('.seg-cal-pos')?.textContent).toBe('D1');
  });

  it('labels a cell with the leg, day and date for hovering', () => {
    renderCalendar(node, overview(makeDays(3, '2026-04-10'), [view(1, 1, 3, 'default', 'Tokyo')]), null, vi.fn());
    const title = node.querySelector('.seg-cal-cell--in')?.getAttribute('title') ?? '';
    expect(title).toContain('Tokyo');
    expect(title).toContain('Day 1');
    expect(title).toContain('Apr 10');
  });

  it('falls back to an ordinal grid when the trip has no dates', () => {
    renderCalendar(node, overview(makeDays(9, null), [view(1, 1, 9)]), null, vi.fn());

    expect(node.textContent).toContain('no dates yet');
    expect(node.querySelectorAll('.seg-cal-month')).toHaveLength(0);
    expect(node.querySelectorAll('.seg-cal-cell--in')).toHaveLength(9);
  });

  it('says so when the trip has no days at all', () => {
    renderCalendar(node, overview([], []), null, vi.fn());
    expect(node.textContent).toContain('no days yet');
  });

  /** A six-month trip must stay a fixed number of months, not explode. */
  it('handles a six-month trip', () => {
    const months = buildMonths(overview(makeDays(180, '2026-04-10'), [view(1, 1, 180)]));
    expect(months.map((m) => m.label)).toEqual([
      'April 2026', 'May 2026', 'June 2026', 'July 2026', 'August 2026', 'September 2026', 'October 2026',
    ]);
  });
});

describe('legend', () => {
  it('lists each leg with its colour and length, and opens it', () => {
    const onOpen = vi.fn();
    renderLegend(node, [view(1, 1, 5, 'default', 'Tokyo'), view(2, 6, 9, 'success', 'Kanazawa')], null, onOpen);

    const items = node.querySelectorAll('.seg-legend-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Tokyo');
    expect(items[0]?.textContent).toContain('5d');

    (items[1] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it('omits legs that no longer fit the trip', () => {
    const gone = { ...view(9, 40, 45), effStart: null, effEnd: null, status: 'out_of_range' as const };
    renderLegend(node, [gone], null, vi.fn());
    expect(node.querySelectorAll('.seg-legend-item')).toHaveLength(0);
  });
});

describe('selection', () => {
  it('rings the open leg and recedes the others', () => {
    renderCalendar(node, overview(makeDays(10, '2026-04-10'), [view(1, 1, 5), view(2, 6, 10)]), 1, vi.fn());

    expect(node.querySelectorAll('.seg-cal-cell--sel')).toHaveLength(5);
    expect(node.querySelectorAll('.seg-cal-cell--dim')).toHaveLength(5);
  });

  it('rings nothing when no leg is open', () => {
    renderCalendar(node, overview(makeDays(10, '2026-04-10'), [view(1, 1, 5)]), null, vi.fn());

    expect(node.querySelectorAll('.seg-cal-cell--sel')).toHaveLength(0);
    expect(node.querySelectorAll('.seg-cal-cell--dim')).toHaveLength(0);
  });

  it('marks the open leg in the legend', () => {
    renderLegend(node, [view(1, 1, 5, 'default', 'Tokyo'), view(2, 6, 9)], 2, vi.fn());
    const on = node.querySelectorAll('.seg-legend-item--on');
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toContain('Leg 2');
  });
});
