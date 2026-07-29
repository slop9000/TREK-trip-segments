import { button, chip, clear, el, muted, toneDot } from '../dom';
import { renderDetailPanel } from './detail';
import { hexForTone, toneChipClass } from '../../src/shared/palette';
import { plural, rangesToText, segmentRangeLabel } from '../../src/shared/format';
import type { DetailPayload, OverviewPayload, SegmentView } from '../../src/shared/types';

export interface OverviewActions {
  onCreate: () => void;
  onEdit: (view: SegmentView) => void;
  onDelete: (view: SegmentView) => void;
  /** Expand this leg in place, or collapse it if it is already open. */
  onToggle: (view: SegmentView) => void;
  onClose: () => void;
}

export interface ExpandedState {
  id: number | null;
  detail: DetailPayload | null;
}

/** The chip that explains why a leg is not showing what the user expects. */
function statusChip(view: SegmentView): HTMLElement | null {
  if (view.status === 'clipped') return chip('shortened', toneChipClass('warn'));
  if (view.status === 'out_of_range') return chip('outside the trip', toneChipClass('danger'));
  return null;
}

/** What is actually inside a leg — the reason to open it. */
function countsLine(view: SegmentView): HTMLElement | null {
  const c = view.counts;
  if (!c) return null;

  return el('div', {
    class: 'trek-faint seg-card-counts',
    text: [
      plural(c.places, 'place', 'places'),
      plural(c.bookings, 'booking', 'bookings'),
      plural(c.stays, 'stay', 'stays'),
    ].join(' · '),
  });
}

function segmentCard(view: SegmentView, expanded: ExpandedState, actions: OverviewActions): HTMLElement {
  const isOpen = expanded.id === view.id;
  const range =
    view.effStart === null || view.effEnd === null
      ? `Days ${view.start_day}-${view.end_day}, no longer in this trip`
      : segmentRangeLabel(view.effStart, view.effEnd, view.startDate, view.endDate);

  const card = el(
    'div',
    {
      class: [
        'trek-card seg-card',
        view.status === 'out_of_range' ? 'seg-card--muted' : '',
        isOpen ? 'seg-card--open' : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
    [
      // A colour rail rather than a dot alone: it ties the card to its calendar cells.
      el('span', { class: 'seg-card-rail', style: { backgroundColor: hexForTone(view.tone) } }),
      el('div', { class: 'seg-card-top' }, [
        el('div', { class: 'seg-card-main' }, [
          el('div', { class: 'seg-card-head' }, [
            toneDot(hexForTone(view.tone)),
            el('span', { class: 'trek-title seg-card-name', text: view.name }),
            statusChip(view),
          ]),
          el('div', { class: 'trek-faint seg-card-meta', text: range }),
          countsLine(view),
        ]),
        el('div', { class: 'trek-cluster seg-card-actions' }, [
          view.status === 'out_of_range'
            ? null
            : button(isOpen ? 'Hide' : 'Details', {
                // Secondary, not ghost: this is the card's primary action and a
                // ghost button reads as plain text.
                variant: 'secondary',
                onClick: () => actions.onToggle(view),
              }),
          button('Edit', { variant: 'ghost', onClick: () => actions.onEdit(view) }),
          button('Delete', { variant: 'ghost', onClick: () => actions.onDelete(view) }),
        ]),
      ]),
    ],
  );

  if (isOpen) {
    const panel = el('div', { class: 'seg-card-panel' });
    renderDetailPanel(panel, view, expanded.detail, actions.onClose);
    card.append(panel);
  }

  return card;
}

/**
 * Hints about things the user cannot see from the leg list alone. Both are the
 * failure modes that would otherwise make the tab quietly wrong: days that
 * belong to no leg, and bookings we could not place on the timeline at all.
 */
function hints(data: OverviewPayload): HTMLElement[] {
  const out: HTMLElement[] = [];

  if (data.dayCount > 0 && data.uncovered.length > 0) {
    const days = data.uncovered.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
    out.push(
      el('p', {
        class: 'trek-muted seg-hint',
        text: `${plural(days, 'day is', 'days are')} not in any leg: ${rangesToText(data.uncovered)}.`,
      }),
    );
  }

  const { bookings, stays } = data.unassigned;
  if (bookings > 0 || stays > 0) {
    const parts: string[] = [];
    if (bookings > 0) parts.push(plural(bookings, 'booking', 'bookings'));
    if (stays > 0) parts.push(plural(stays, 'stay', 'stays'));

    const one = bookings + stays === 1;
    out.push(
      el('p', {
        class: 'trek-muted seg-hint',
        text: `${parts.join(' and ')} ${one ? 'is' : 'are'} not attached to a day, so ${
          one ? 'it' : 'they'
        } cannot belong to any leg.`,
      }),
    );
  }

  return out;
}

export function renderOverview(
  node: HTMLElement,
  data: OverviewPayload,
  expanded: ExpandedState,
  actions: OverviewActions,
): void {
  clear(node);

  if (data.segments.length === 0) {
    node.append(
      el('div', { class: 'seg-empty' }, [
        el('div', { class: 'trek-title', text: 'No legs yet' }),
        muted(
          data.dayCount === 0
            ? 'Add some days to the trip first, then split them into legs.'
            : 'Split this trip into legs to see its schedule, bookings and stays one destination at a time.',
        ),
        data.dayCount === 0 ? null : button('Add the first leg', { variant: 'primary', onClick: actions.onCreate }),
      ]),
    );
    return;
  }

  node.append(...hints(data));

  const list = el('div', { class: 'trek-stack seg-list' });
  for (const view of data.segments) list.append(segmentCard(view, expanded, actions));
  node.append(list);
}
