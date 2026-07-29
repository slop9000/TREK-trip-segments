import { button, chip, clear, el, muted } from '../dom';
import { hexForTone, toneChipClass } from '../../src/shared/palette';
import { dayRangeLabel, plural, segmentRangeLabel, shortDate } from '../../src/shared/format';
import type { DetailBooking, DetailDay, DetailPayload, DetailStay, SegmentView } from '../../src/shared/types';

/**
 * A leg's contents, rendered as a panel expanded IN PLACE rather than as its own
 * screen. Replacing the tab meant losing the calendar, the strip and the other
 * legs, with a single quiet link as the way back.
 *
 * Days are collapsed to one row each and their contents built only on expand: a
 * leg of a six-month trip can be 60 days of places and notes.
 */
const expanded = new Set<number>();

function dayRow(day: DetailDay): HTMLElement {
  const isOpen = expanded.has(day.id);

  const summary: string[] = [];
  if (day.places.length > 0) summary.push(plural(day.places.length, 'place', 'places'));
  if (day.notes.length > 0) summary.push(plural(day.notes.length, 'note', 'notes'));

  const heading = el('button', {
    class: 'seg-day-head',
    attrs: { type: 'button', 'aria-expanded': String(isOpen) },
    on: {
      click: (ev) => {
        const row = (ev.currentTarget as HTMLElement).parentElement;
        if (!row) return;
        if (expanded.has(day.id)) expanded.delete(day.id);
        else expanded.add(day.id);
        row.replaceWith(dayRow(day));
      },
    },
  }, [
    el('span', { class: 'seg-day-caret', text: isOpen ? '−' : '+' }),
    el('span', { class: 'seg-day-label', text: `Day ${day.pos}` }),
    el('span', { class: 'trek-faint', text: [shortDate(day.date), day.title].filter(Boolean).join(' · ') }),
    el('span', { class: 'trek-faint seg-day-count', text: summary.join(', ') || 'nothing planned' }),
  ]);

  const row = el('div', { class: 'seg-day' }, [heading]);
  if (!isOpen) return row;

  const contents = el('div', { class: 'seg-day-body' });
  for (const place of day.places) {
    contents.append(
      el('div', { class: 'seg-place' }, [
        el('span', { class: 'trek-faint seg-place-time', text: place.time ?? '' }),
        el('span', { class: 'seg-place-name', text: place.name ?? 'Unnamed place' }),
        place.categoryName ? chip(place.categoryName) : null,
      ]),
    );
  }
  for (const note of day.notes) {
    contents.append(
      el('div', { class: 'seg-note trek-muted' }, [
        el('span', { class: 'trek-faint seg-place-time', text: note.time ?? '' }),
        el('span', { text: note.text }),
      ]),
    );
  }
  if (day.places.length === 0 && day.notes.length === 0) contents.append(muted('Nothing planned for this day.'));

  row.append(contents);
  return row;
}

function bookingRow(booking: DetailBooking): HTMLElement {
  const when = booking.time ? shortDate(booking.time.slice(0, 10)) : null;
  const days =
    booking.fromPos === booking.toPos ? `Day ${booking.fromPos}` : dayRangeLabel(booking.fromPos, booking.toPos);

  return el('div', { class: 'trek-row seg-row' }, [
    el('div', { class: 'seg-row-main' }, [
      el('span', { class: 'seg-row-title', text: booking.title }),
      el('span', { class: 'trek-faint', text: [days, when, booking.confirmation].filter(Boolean).join(' · ') }),
    ]),
    el('div', { class: 'trek-cluster' }, [
      booking.type ? chip(booking.type) : null,
      booking.status === 'confirmed' ? chip('confirmed', toneChipClass('success')) : null,
      booking.status === 'pending' ? chip('pending', toneChipClass('warn')) : null,
      // Explains why the same booking shows up under two legs.
      booking.spansLegs ? chip('also in another leg') : null,
    ]),
  ]);
}

function stayRow(stay: DetailStay): HTMLElement {
  const detail = [
    dayRangeLabel(stay.fromPos, stay.toPos),
    plural(stay.nights, 'night', 'nights'),
    stay.checkIn ? `in ${stay.checkIn}` : null,
    stay.checkOut ? `out ${stay.checkOut}` : null,
    stay.confirmation,
  ]
    .filter(Boolean)
    .join(' · ');

  return el('div', { class: 'trek-row seg-row' }, [
    el('div', { class: 'seg-row-main' }, [
      el('span', { class: 'seg-row-title', text: stay.placeName ?? 'Stay' }),
      el('span', { class: 'trek-faint', text: detail }),
      stay.bookingTitles.length > 0 ? el('span', { class: 'trek-faint', text: stay.bookingTitles.join(', ') }) : null,
    ]),
  ]);
}

function section(heading: string, count: number, rows: HTMLElement[], emptyText: string): HTMLElement {
  return el('div', { class: 'trek-stack seg-section' }, [
    el('div', { class: 'seg-section-head' }, [
      el('span', { class: 'trek-title', text: heading }),
      el('span', { class: 'trek-faint', text: String(count) }),
    ]),
    ...(rows.length > 0 ? rows : [muted(emptyText)]),
  ]);
}

/**
 * @param segment the leg from the overview, so the panel header can render
 *                immediately instead of waiting on the detail request
 * @param data    the loaded contents, or null while in flight
 */
export function renderDetailPanel(
  node: HTMLElement,
  segment: SegmentView,
  data: DetailPayload | null,
  onClose: () => void,
): void {
  clear(node);

  const range =
    segment.effStart === null || segment.effEnd === null
      ? 'This leg is outside the trip.'
      : segmentRangeLabel(segment.effStart, segment.effEnd, segment.startDate, segment.endDate);

  node.append(
    el('div', { class: 'seg-panel-head' }, [
      el('span', { class: 'seg-panel-rail', style: { backgroundColor: hexForTone(segment.tone) } }),
      el('div', { class: 'seg-panel-titles' }, [
        el('span', { class: 'trek-title', text: segment.name }),
        el('span', { class: 'trek-faint', text: range }),
      ]),
      // A real button, not a ghost link: this is the only way to collapse.
      button('Close', { variant: 'secondary', onClick: onClose, title: 'Collapse this leg' }),
    ]),
  );

  if (!data) {
    node.append(muted('Loading this leg...'));
    return;
  }

  node.append(
    section('Schedule', data.days.length, data.days.map(dayRow), 'No days in this leg.'),
    section('Bookings', data.bookings.length, data.bookings.map(bookingRow), 'No bookings fall inside these days.'),
    section('Stays', data.stays.length, data.stays.map(stayRow), 'No stays overlap these days.'),
  );
}

/** Forget which days were expanded when a different leg is opened. */
export function resetDetailExpansion(): void {
  expanded.clear();
}
