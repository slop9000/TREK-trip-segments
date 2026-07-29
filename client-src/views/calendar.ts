import { clear, el } from '../dom';
import { hexForTone, toneFill } from '../../src/shared/palette';
import { WEEKDAYS, dateParts, daysInMonth, mondayIndex, monthLabel, plural, shortDate } from '../../src/shared/format';
import type { OverviewDay, OverviewPayload, SegmentView } from '../../src/shared/types';

/**
 * The calendar is where a leg's colour finally lands on individual days.
 *
 * TREK's day plan cannot be tinted from a plugin — the only hook that reaches it
 * renders a fixed row and the tone just colours an icon — so this tab is the one
 * surface where "which leg is this day in?" can be answered at a glance.
 */

export interface CalendarCell {
  /** Day-of-month, or null for the blanks that align the first week. */
  date: number | null;
  /** 1-based trip day position, or null when the date is outside the trip. */
  pos: number | null;
  segment: SegmentView | null;
  day: OverviewDay | null;
}

export interface CalendarMonth {
  key: string;
  label: string;
  cells: CalendarCell[];
}

/** Which leg owns each day position. */
export function segmentByPosition(segments: readonly SegmentView[], dayCount: number): Array<SegmentView | null> {
  const owner: Array<SegmentView | null> = new Array(dayCount).fill(null);
  for (const view of segments) {
    if (view.effStart === null || view.effEnd === null) continue;
    for (let pos = view.effStart; pos <= view.effEnd; pos++) owner[pos - 1] = view;
  }
  return owner;
}

/**
 * Lay the trip out as whole calendar months.
 *
 * Every date of each touched month gets a cell — not just the trip's own days —
 * so the grid reads like a real calendar and it is obvious where the trip starts
 * and ends within the month. Returns [] when the trip has no dates at all, which
 * is legal in TREK (`days.date` is nullable) and handled by the ordinal
 * fallback.
 */
export function buildMonths(data: OverviewPayload): CalendarMonth[] {
  const owner = segmentByPosition(data.segments, data.dayCount);

  const byDate = new Map<string, { day: OverviewDay; segment: SegmentView | null }>();
  for (const day of data.days) {
    if (!day.date) continue;
    byDate.set(day.date.slice(0, 10), { day, segment: owner[day.pos - 1] ?? null });
  }
  if (byDate.size === 0) return [];

  const months = new Map<string, { y: number; m: number }>();
  for (const key of byDate.keys()) {
    const parts = dateParts(key);
    if (!parts) continue;
    months.set(`${parts.y}-${String(parts.m).padStart(2, '0')}`, { y: parts.y, m: parts.m });
  }

  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, { y, m }]) => {
      const cells: CalendarCell[] = [];
      for (let i = 0; i < mondayIndex(y, m, 1); i++) cells.push({ date: null, pos: null, segment: null, day: null });

      for (let date = 1; date <= daysInMonth(y, m); date++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
        const hit = byDate.get(iso);
        cells.push({
          date,
          pos: hit ? hit.day.pos : null,
          segment: hit ? hit.segment : null,
          day: hit ? hit.day : null,
        });
      }
      return { key, label: monthLabel(y, m), cells };
    });
}

function cellNode(cell: CalendarCell, selectedId: number | null, onOpen: (id: number) => void): HTMLElement {
  if (cell.date === null) return el('div', { class: 'seg-cal-cell seg-cal-cell--pad' });

  // A date inside a month the trip touches, but not itself part of the trip.
  if (cell.pos === null) {
    return el('div', { class: 'seg-cal-cell seg-cal-cell--outside' }, [
      el('span', { class: 'seg-cal-date', text: String(cell.date) }),
    ]);
  }

  const { segment } = cell;
  const title = [
    segment ? segment.name : 'Not in any leg',
    `Day ${cell.pos}`,
    shortDate(cell.day?.date ?? null),
    cell.day?.title,
    cell.day?.assignmentCount ? plural(cell.day.assignmentCount, 'place', 'places') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // With a leg open, its days are ringed and the rest recede — so the panel
  // below is unambiguously about the highlighted days.
  const selected = segment !== null && segment.id === selectedId;
  const dimmed = selectedId !== null && !selected;

  const node = el(segment ? 'button' : 'div', {
    class: [
      'seg-cal-cell seg-cal-cell--in',
      segment ? '' : 'seg-cal-cell--bare',
      selected ? 'seg-cal-cell--sel' : '',
      dimmed ? 'seg-cal-cell--dim' : '',
    ]
      .filter(Boolean)
      .join(' '),
    title,
    ...(segment ? { attrs: { type: 'button', 'aria-label': title } } : {}),
    ...(segment
      ? { style: { backgroundColor: toneFill(segment.tone, 0.18), borderColor: hexForTone(segment.tone) } }
      : {}),
    ...(segment ? { on: { click: () => onOpen(segment.id) } } : {}),
  }, [
    el('span', { class: 'seg-cal-date', text: String(cell.date) }),
    el('span', { class: 'seg-cal-pos', text: `D${cell.pos}` }),
    cell.day?.assignmentCount
      ? el('span', {
          class: 'seg-cal-dots',
          text: '•'.repeat(Math.min(cell.day.assignmentCount, 4)),
        })
      : null,
  ]);

  return node;
}

/** Colour key, so a cell's tint is readable without hovering. */
export function renderLegend(
  node: HTMLElement,
  segments: readonly SegmentView[],
  selectedId: number | null,
  onOpen: (id: number) => void,
): void {
  clear(node);
  for (const view of segments) {
    if (view.effStart === null) continue;
    node.append(
      el('button', {
        class: `seg-legend-item${view.id === selectedId ? ' seg-legend-item--on' : ''}`,
        attrs: { type: 'button' },
        title: `Open ${view.name}`,
        on: { click: () => onOpen(view.id) },
      }, [
        el('span', { class: 'seg-legend-dot', style: { backgroundColor: hexForTone(view.tone) } }),
        el('span', { text: view.name }),
        el('span', { class: 'trek-faint', text: `${view.effLength}d` }),
      ]),
    );
  }
}

/**
 * Fallback for a trip whose days have no dates yet: a plain seven-across grid of
 * ordinals. Still answers "which leg is day 34 in", which is the point.
 */
function renderOrdinalGrid(
  node: HTMLElement,
  data: OverviewPayload,
  selectedId: number | null,
  onOpen: (id: number) => void,
): void {
  const owner = segmentByPosition(data.segments, data.dayCount);
  const grid = el('div', { class: 'seg-cal-grid' });

  for (let pos = 1; pos <= data.dayCount; pos++) {
    const segment = owner[pos - 1] ?? null;
    grid.append(
      cellNode({ date: pos, pos, segment, day: data.days[pos - 1] ?? null }, selectedId, onOpen),
    );
  }

  node.append(
    el('p', { class: 'trek-faint seg-hint', text: 'This trip has no dates yet, so days are shown by number.' }),
    grid,
  );
}

export function renderCalendar(
  node: HTMLElement,
  data: OverviewPayload,
  selectedId: number | null,
  onOpen: (id: number) => void,
): void {
  clear(node);

  if (data.dayCount === 0) {
    node.append(el('p', { class: 'trek-muted', text: 'This trip has no days yet.' }));
    return;
  }

  const months = buildMonths(data);
  if (months.length === 0) {
    renderOrdinalGrid(node, data, selectedId, onOpen);
    return;
  }

  for (const month of months) {
    const head = el('div', { class: 'seg-cal-month-head' }, [
      el('span', { class: 'trek-title', text: month.label }),
    ]);

    const weekdays = el('div', { class: 'seg-cal-grid seg-cal-weekdays' });
    for (const name of WEEKDAYS) weekdays.append(el('span', { class: 'trek-faint', text: name }));

    const grid = el('div', { class: 'seg-cal-grid' });
    for (const cell of month.cells) grid.append(cellNode(cell, selectedId, onOpen));

    node.append(el('div', { class: 'seg-cal-month' }, [head, weekdays, grid]));
  }
}
