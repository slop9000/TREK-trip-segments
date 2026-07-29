import { el, clear } from '../dom';
import { hexForTone } from '../../src/shared/palette';
import { segmentRangeLabel } from '../../src/shared/format';
import type { SegmentView } from '../../src/shared/types';

export interface StripBar {
  id: number;
  hex: string;
  leftPct: number;
  widthPct: number;
  label: string;
  faded: boolean;
}

/**
 * One absolutely-positioned bar per LEG, not one cell per day.
 *
 * A six-month trip is the whole point of this plugin, and 180 day cells is both
 * unreadable and a lot of DOM. Bars keep the node count proportional to the
 * number of legs (at most 40) no matter how long the trip is, and the gaps
 * between them show through as uncovered days.
 */
export function stripGeometry(views: readonly SegmentView[], dayCount: number): StripBar[] {
  if (dayCount <= 0) return [];

  const bars: StripBar[] = [];
  for (const view of views) {
    if (view.effStart === null || view.effEnd === null) continue;
    bars.push({
      id: view.id,
      hex: hexForTone(view.tone),
      leftPct: ((view.effStart - 1) / dayCount) * 100,
      widthPct: (view.effLength / dayCount) * 100,
      label: `${view.name} - ${segmentRangeLabel(view.effStart, view.effEnd, view.startDate, view.endDate)}`,
      faded: view.status === 'clipped',
    });
  }
  return bars;
}

/** Pick a tick spacing that keeps the axis readable at any trip length. */
export function tickStride(dayCount: number, maxTicks = 12): number {
  for (const stride of [1, 2, 5, 10, 15, 20, 30, 50, 100]) {
    if (dayCount / stride <= maxTicks) return stride;
  }
  return Math.ceil(dayCount / maxTicks);
}

export function renderStrip(
  node: HTMLElement,
  views: readonly SegmentView[],
  dayCount: number,
  onSelect: (id: number) => void,
): void {
  clear(node);
  if (dayCount <= 0) return;

  const track = el('div', { class: 'seg-strip-track' });
  for (const bar of stripGeometry(views, dayCount)) {
    track.append(
      el('button', {
        class: `seg-strip-bar${bar.faded ? ' seg-strip-bar--clipped' : ''}`,
        title: bar.label,
        attrs: { type: 'button', 'aria-label': bar.label },
        style: {
          left: `${bar.leftPct}%`,
          width: `${Math.max(bar.widthPct, 0.6)}%`,
          backgroundColor: bar.hex,
        },
        on: { click: () => onSelect(bar.id) },
      }),
    );
  }

  const ticks = el('div', { class: 'seg-strip-ticks' });
  const stride = tickStride(dayCount);
  for (let day = 1; day <= dayCount; day += stride) {
    ticks.append(
      el('span', {
        class: 'seg-tick trek-faint',
        text: String(day),
        style: { left: `${((day - 1) / dayCount) * 100}%` },
      }),
    );
  }

  node.append(track, ticks);
}
