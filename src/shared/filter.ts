import { spanTouches } from './drift';
import type { HostAccommodation, HostDay, HostReservation } from './host-types';
import type { DayIndex, SegmentCounts, SegmentView } from './types';

/** An inclusive span of 1-based day positions. */
export interface Span {
  lo: number;
  hi: number;
}

/** An accommodation with its duplicate join rows folded back together. */
export interface StayRow extends HostAccommodation {
  bookingTitles: string[];
}

/**
 * `DaysService.listAccommodations` LEFT JOINs reservations, so a stay with two
 * linked bookings comes back as two rows differing only in `reservation_title`.
 *
 * Group rather than last-wins: `new Map(rows.map(r => [r.id, r]))` would also
 * dedupe, but it would throw away every title but the last, which is the very
 * information the duplicate rows carry.
 */
export function dedupeAccommodations(rows: readonly HostAccommodation[]): StayRow[] {
  const byId = new Map<number, StayRow>();

  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing) {
      if (row.reservation_title && !existing.bookingTitles.includes(row.reservation_title)) {
        existing.bookingTitles.push(row.reservation_title);
      }
      continue;
    }
    byId.set(row.id, {
      ...row,
      bookingTitles: row.reservation_title ? [row.reservation_title] : [],
    });
  }

  return [...byId.values()];
}

/**
 * True for the hotel reservation TREK auto-creates alongside a stay
 * (days.service.ts:562). Counting these as bookings would show every stay
 * twice: once under Stays and again under Bookings.
 */
export function isStayPartnerBooking(reservation: HostReservation): boolean {
  return reservation.accommodation_id != null;
}

/**
 * Which day positions a booking occupies.
 *
 * Uses the `day_id` → `end_day_id` span, which is how core itself decides this
 * (TripPDF.tsx:207, DayPlanSidebar.tsx:335). `day_positions` is NOT used: it is
 * written only when a card is dragged within a day, is incomplete, and is never
 * pruned — it describes layout, not membership.
 *
 * Returns null when the booking is not on the timeline at all, so the caller can
 * surface it rather than drop it.
 */
export function reservationSpan(reservation: HostReservation, idx: DayIndex): Span | null {
  if (reservation.day_id == null) return null;

  const start = idx.posByDayId.get(reservation.day_id);
  if (start === undefined) return null; // a day that is not on this trip

  // A dangling end_day_id (the day was deleted, ON DELETE SET NULL) collapses to
  // the anchor rather than invalidating the booking.
  const rawEnd = reservation.end_day_id == null ? start : idx.posByDayId.get(reservation.end_day_id);
  const end = rawEnd ?? start;

  return { lo: Math.min(start, end), hi: Math.max(start, end) };
}

/**
 * Which day positions a stay occupies. Both columns are NOT NULL in the schema,
 * but a half-resolvable pair still yields a usable single-day span.
 */
export function accommodationSpan(stay: HostAccommodation, idx: DayIndex): Span | null {
  const start = idx.posByDayId.get(stay.start_day_id);
  const end = idx.posByDayId.get(stay.end_day_id);

  const lo = start ?? end;
  const hi = end ?? start;
  if (lo === undefined || hi === undefined) return null;

  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/** Bookings a user should see, in a stable order, with the stay partners removed. */
export function usableBookings(reservations: readonly HostReservation[]): HostReservation[] {
  return reservations.filter((r) => !isStayPartnerBooking(r));
}

/**
 * How much of the trip a leg actually contains. Shared by the overview (card
 * subtitles) and the PDF section, so the two can never disagree.
 *
 * Callers already hold the days/reservations/accommodations, so this adds no
 * round trips.
 */
export function countsForSegment(
  view: SegmentView,
  days: readonly HostDay[],
  reservations: readonly HostReservation[],
  accommodations: readonly HostAccommodation[],
  idx: DayIndex,
): SegmentCounts {
  if (view.effStart === null || view.effEnd === null) return { places: 0, bookings: 0, stays: 0 };

  let places = 0;
  for (let pos = view.effStart; pos <= view.effEnd; pos++) {
    places += days[pos - 1]?.assignments?.length ?? 0;
  }

  const bookings = usableBookings(reservations).filter((r) => {
    const span = reservationSpan(r, idx);
    return span !== null && spanTouches(span.lo, span.hi, view);
  }).length;

  const stays = dedupeAccommodations(accommodations).filter((a) => {
    const span = accommodationSpan(a, idx);
    return span !== null && spanTouches(span.lo, span.hi, view);
  }).length;

  return { places, bookings, stays };
}
