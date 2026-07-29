import { buildDayIndex, resolveAll, spanTouches, uncoveredRanges } from '../shared/drift';
import {
  accommodationSpan,
  countsForSegment,
  dedupeAccommodations,
  reservationSpan,
  usableBookings,
} from '../shared/filter';
import { nightsBetween } from '../shared/format';
import { listSegments } from './repo';
import type { HostTrip, PluginContext } from '../shared/host-types';
import type {
  DetailBooking,
  DetailDay,
  DetailPayload,
  DetailStay,
  OverviewDay,
  OverviewPayload,
} from '../shared/types';

/**
 * The only file that calls `ctx.trips.*`.
 *
 * Every one of those methods THROWS `ForbiddenResource` when the acting user
 * cannot see the trip (rpc-host.ts:1167) — none of them return null for it. A
 * throw inside a route handler becomes a 502, so access checking has to be an
 * explicit try/catch, not a null check.
 */
export async function withTrip<T>(
  ctx: PluginContext,
  tripId: number,
  fn: (trip: HostTrip) => Promise<T>,
): Promise<T | null> {
  let trip: HostTrip | null;
  try {
    trip = await ctx.trips.getById(tripId);
  } catch {
    return null; // not a member, or the trip is gone
  }
  if (!trip) return null;
  return fn(trip);
}

/**
 * Everything the segments tab needs in one round trip.
 *
 * Costs 4 `ctx.trips.*` reads plus 1 `db.query`, issued concurrently — well
 * inside the 16-in-flight cap and the 20/s sustained limit.
 */
export async function buildOverview(ctx: PluginContext, tripId: number, trip: HostTrip): Promise<OverviewPayload> {
  const [days, reservations, accommodations, segmentRows] = await Promise.all([
    ctx.trips.getDays(tripId),
    ctx.trips.getReservations(tripId),
    ctx.trips.getAccommodations(tripId),
    listSegments(ctx, tripId),
  ]);

  const idx = buildDayIndex(days);
  // Counts ride along on each leg so the cards can say what is inside them
  // without a second request per leg.
  const segments = resolveAll(segmentRows, idx).map((view) => ({
    ...view,
    counts: countsForSegment(view, days, reservations, accommodations, idx),
  }));

  const overviewDays: OverviewDay[] = days.map((day, i) => ({
    id: day.id,
    pos: i + 1,
    date: day.date ?? null,
    title: day.title ?? null,
    assignmentCount: day.assignments?.length ?? 0,
  }));

  // Anything we cannot place on the timeline is counted and surfaced, never
  // silently omitted — a booking that vanishes from every leg is the failure
  // mode that makes the whole tab untrustworthy.
  const orphanBookings = usableBookings(reservations).filter((r) => reservationSpan(r, idx) === null).length;
  const orphanStays = dedupeAccommodations(accommodations).filter((a) => accommodationSpan(a, idx) === null).length;

  return {
    trip: {
      id: trip.id,
      title: trip.title ?? null,
      start_date: trip.start_date ?? null,
      end_date: trip.end_date ?? null,
    },
    dayCount: idx.count,
    days: overviewDays,
    segments,
    uncovered: uncoveredRanges(segments, idx.count),
    unassigned: { bookings: orphanBookings, stays: orphanStays },
  };
}

/**
 * One leg's slice of the trip: its days, the bookings that fall inside it, and
 * the stays that overlap it. Returns null when the segment is not on this trip.
 *
 * Costs the same 4 reads plus 1 query as the overview.
 */
export async function buildDetail(
  ctx: PluginContext,
  tripId: number,
  segmentId: number,
): Promise<DetailPayload | null> {
  const [days, reservations, accommodations, segmentRows] = await Promise.all([
    ctx.trips.getDays(tripId),
    ctx.trips.getReservations(tripId),
    ctx.trips.getAccommodations(tripId),
    listSegments(ctx, tripId),
  ]);

  const idx = buildDayIndex(days);
  const views = resolveAll(segmentRows, idx);
  const segment = views.find((v) => v.id === segmentId);
  if (!segment) return null;

  const detailDays: DetailDay[] =
    segment.effStart === null || segment.effEnd === null
      ? []
      : days.slice(segment.effStart - 1, segment.effEnd).map((day, offset) => ({
          id: day.id,
          pos: segment.effStart! + offset,
          date: day.date ?? null,
          title: day.title ?? null,
          places: (day.assignments ?? []).map((a) => ({
            name: a.place?.name ?? null,
            time: a.assignment_time ?? a.place?.place_time ?? null,
            categoryName: a.place?.category?.name ?? null,
            categoryColor: a.place?.category?.color ?? null,
          })),
          notes: (day.notes_items ?? []).map((n) => ({ text: n.text, time: n.time ?? null })),
        }));

  const bookings: DetailBooking[] = [];
  for (const reservation of usableBookings(reservations)) {
    const span = reservationSpan(reservation, idx);
    if (!span || !spanTouches(span.lo, span.hi, segment)) continue;

    bookings.push({
      id: reservation.id,
      title: reservation.title,
      type: reservation.type ?? null,
      status: reservation.status ?? null,
      time: reservation.reservation_time ?? null,
      confirmation: reservation.confirmation_number ?? null,
      fromPos: span.lo,
      toPos: span.hi,
      // A booking crossing a boundary really does belong to both legs; saying so
      // is better than letting the same row look like a duplicate.
      spansLegs: views.some((v) => v.id !== segment.id && spanTouches(span.lo, span.hi, v)),
    });
  }

  const stays: DetailStay[] = [];
  for (const stay of dedupeAccommodations(accommodations)) {
    const span = accommodationSpan(stay, idx);
    if (!span || !spanTouches(span.lo, span.hi, segment)) continue;

    stays.push({
      id: stay.id,
      placeName: stay.place_name ?? null,
      address: stay.place_address ?? null,
      checkIn: stay.check_in ?? null,
      checkOut: stay.check_out ?? null,
      confirmation: stay.confirmation ?? null,
      fromPos: span.lo,
      toPos: span.hi,
      nights: nightsBetween(span.lo, span.hi),
      bookingTitles: stay.bookingTitles,
    });
  }

  return { segment, dayCount: idx.count, days: detailDays, bookings, stays };
}
