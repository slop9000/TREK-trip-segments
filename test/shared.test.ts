import { describe, expect, it } from 'vitest';
import { buildDayIndex, coveredDayCount, resolveAll, resolveSegment, spanTouches, uncoveredRanges } from '../src/shared/drift';
import {
  accommodationSpan,
  dedupeAccommodations,
  isStayPartnerBooking,
  reservationSpan,
  usableBookings,
} from '../src/shared/filter';
import { dateRangeLabel, dayRangeLabel, nightsBetween, rangesToText, safeLabel, shortDate } from '../src/shared/format';
import {
  PALETTE,
  hexForTone,
  isHexColor,
  isTone,
  normalizeHexColor,
  toneChipClass,
  toneForColor,
} from '../src/shared/palette';
import { findOverlap, normalizeName, rangesOverlap, validateSegmentInput } from '../src/shared/validate';
import { makeDays } from './helpers';
import type { HostAccommodation, HostDay, HostReservation } from '../src/shared/host-types';
import type { SegmentInput, SegmentRow } from '../src/shared/types';

const row = (id: number, start: number, end: number): SegmentRow => ({
  id,
  trip_id: 1,
  name: `Leg ${id}`,
  color: '#4F46E5',
  tone: 'default',
  start_day: start,
  end_day: end,
  created_at: 'x',
  updated_at: 'x',
});

const input = (start: number, end: number, over: Partial<SegmentInput> = {}): SegmentInput => ({
  name: 'Leg',
  color: '#4F46E5',
  start_day: start,
  end_day: end,
  ...over,
});

describe('day index', () => {
  /**
   * The whole anchoring decision in one test. `DaysService.remove()` is a bare
   * DELETE with no renumber, so a trip that lost its third day has day_numbers
   * 1, 2, 4 — while the planner still labels those days 1, 2, 3. Anchoring to
   * day_number would silently shift every segment by one.
   */
  it('uses array position, not day_number, even when day_number has gaps', () => {
    const days: HostDay[] = [
      { id: 101, trip_id: 1, day_number: 1, date: '2026-04-10', assignments: [], notes_items: [] },
      { id: 102, trip_id: 1, day_number: 2, date: '2026-04-11', assignments: [], notes_items: [] },
      { id: 104, trip_id: 1, day_number: 4, date: '2026-04-13', assignments: [], notes_items: [] },
    ];

    const idx = buildDayIndex(days);

    expect(idx.count).toBe(3);
    expect(idx.posByDayId.get(104)).toBe(3); // NOT 4
    expect(idx.dayIdByPos).toEqual([101, 102, 104]);
    expect(idx.dateByPos).toEqual(['2026-04-10', '2026-04-11', '2026-04-13']);
  });

  it('tolerates a trip with no dates set', () => {
    const idx = buildDayIndex(makeDays(3, { startDate: null }));
    expect(idx.dateByPos).toEqual([null, null, null]);
  });

  it('handles an empty trip', () => {
    const idx = buildDayIndex([]);
    expect(idx.count).toBe(0);
    expect(idx.dayIdByPos).toEqual([]);
  });
});

describe('drift resolution', () => {
  const idx = buildDayIndex(makeDays(12, { startDate: '2026-04-10' }));

  it('marks a range inside the trip as ok and fills in dates', () => {
    const view = resolveSegment(row(1, 3, 7), idx.count, 0, idx.dateByPos);
    expect(view).toMatchObject({
      status: 'ok',
      effStart: 3,
      effEnd: 7,
      effLength: 5,
      startDate: '2026-04-12',
      endDate: '2026-04-16',
    });
  });

  it('clips a range that outlives the trip', () => {
    const view = resolveSegment(row(1, 10, 30), idx.count, 0, idx.dateByPos);
    expect(view).toMatchObject({ status: 'clipped', effStart: 10, effEnd: 12, effLength: 3, endDate: '2026-04-21' });
  });

  it('marks a range that starts past the end as out_of_range with no days', () => {
    const view = resolveSegment(row(1, 40, 45), idx.count, 0, idx.dateByPos);
    expect(view).toMatchObject({ status: 'out_of_range', effStart: null, effEnd: null, effLength: 0 });
  });

  it('treats every segment as out_of_range on a trip with no days', () => {
    expect(resolveSegment(row(1, 1, 5), 0, 0).status).toBe('out_of_range');
  });

  it('clamps a start day below 1', () => {
    expect(resolveSegment({ ...row(1, 1, 5), start_day: 0 }, 12, 0).effStart).toBe(1);
  });

  it('sorts by start day and numbers the legs in that order', () => {
    const views = resolveAll([row(3, 20, 25), row(1, 1, 5), row(2, 6, 9)], idx);
    expect(views.map((v) => v.id)).toEqual([1, 2, 3]);
    expect(views.map((v) => v.index)).toEqual([0, 1, 2]);
  });
});

describe('coverage gaps', () => {
  const idx = buildDayIndex(makeDays(12));

  it('reports the whole trip when nothing is covered', () => {
    expect(uncoveredRanges([], 12)).toEqual([[1, 12]]);
  });

  it('reports gaps between and after legs', () => {
    const views = resolveAll([row(1, 1, 3), row(2, 6, 8)], idx);
    expect(uncoveredRanges(views, 12)).toEqual([
      [4, 5],
      [9, 12],
    ]);
    expect(coveredDayCount(views, 12)).toBe(6);
  });

  it('reports nothing when legs tile the trip', () => {
    const views = resolveAll([row(1, 1, 6), row(2, 7, 12)], idx);
    expect(uncoveredRanges(views, 12)).toEqual([]);
  });

  it('ignores out_of_range legs when computing coverage', () => {
    const views = resolveAll([row(1, 1, 12), row(2, 50, 60)], idx);
    expect(uncoveredRanges(views, 12)).toEqual([]);
  });

  it('detects whether a span touches a leg', () => {
    const [leg] = resolveAll([row(1, 5, 8)], idx);
    expect(spanTouches(1, 4, leg!)).toBe(false);
    expect(spanTouches(1, 5, leg!)).toBe(true);
    expect(spanTouches(8, 12, leg!)).toBe(true);
    expect(spanTouches(9, 12, leg!)).toBe(false);
  });
});

describe('validation', () => {
  const opts = { dayCount: 12, existing: [] as SegmentRow[] };

  it('requires a name that is not just whitespace', () => {
    expect(validateSegmentInput(input(1, 5, { name: '   ' }), opts)).toContain('name_required');
    expect(normalizeName('  Tokyo   east  ')).toBe('Tokyo east');
  });

  it('rejects a name over the limit', () => {
    expect(validateSegmentInput(input(1, 5, { name: 'x'.repeat(61) }), opts)).toContain('name_too_long');
  });

  it('rejects anything other than a six-digit hex colour', () => {
    expect(validateSegmentInput(input(1, 5, { color: 'neon' }), opts)).toContain('color_invalid');
    expect(validateSegmentInput(input(1, 5, { color: '#12345' }), opts)).toContain('color_invalid');
  });

  it('rejects a backwards or non-integer range', () => {
    expect(validateSegmentInput(input(5, 2), opts)).toContain('range_invalid');
    expect(validateSegmentInput(input(0, 5), opts)).toContain('range_invalid');
    expect(validateSegmentInput(input(1.5, 5), opts)).toContain('range_invalid');
  });

  it('rejects a range past the end of the trip', () => {
    expect(validateSegmentInput(input(1, 13), opts)).toContain('range_out_of_bounds');
  });

  it('accepts a well-formed range', () => {
    expect(validateSegmentInput(input(1, 12), opts)).toEqual([]);
  });

  /** Adjacency is the normal case for legs — it must not read as a collision. */
  it('treats a shared boundary day as overlap but adjacency as legal', () => {
    expect(rangesOverlap(1, 5, 5, 9)).toBe(true);
    expect(rangesOverlap(1, 5, 6, 9)).toBe(false);

    const existing = [row(1, 1, 5)];
    expect(validateSegmentInput(input(5, 9), { ...opts, existing })).toContain('overlap');
    expect(validateSegmentInput(input(6, 9), { ...opts, existing })).toEqual([]);
  });

  it('does not let a segment collide with itself while being edited', () => {
    const existing = [row(1, 1, 5), row(2, 6, 9)];
    expect(findOverlap({ start_day: 1, end_day: 5 }, existing, 1)).toBeNull();
    expect(findOverlap({ start_day: 1, end_day: 6 }, existing, 1)?.id).toBe(2);
  });

  it('reports the limit only when creating', () => {
    const existing = Array.from({ length: 40 }, (_, i) => row(i + 1, i + 1, i + 1));
    expect(validateSegmentInput(input(1, 1), { dayCount: 60, existing })).toContain('limit_reached');
    expect(validateSegmentInput(input(1, 1), { dayCount: 60, existing, editingId: 1 })).not.toContain('limit_reached');
  });
});

describe('bookings and stays', () => {
  const idx = buildDayIndex(makeDays(12)); // ids 101..112

  const booking = (over: Partial<HostReservation>): HostReservation => ({
    id: 1,
    trip_id: 1,
    title: 'Something',
    ...over,
  });

  it('spans from day_id to end_day_id', () => {
    expect(reservationSpan(booking({ day_id: 105, end_day_id: 106 }), idx)).toEqual({ lo: 5, hi: 6 });
  });

  it('treats a booking with no end day as single-day', () => {
    expect(reservationSpan(booking({ day_id: 105 }), idx)).toEqual({ lo: 5, hi: 5 });
  });

  it('normalizes an inverted span rather than dropping it', () => {
    expect(reservationSpan(booking({ day_id: 106, end_day_id: 105 }), idx)).toEqual({ lo: 5, hi: 6 });
  });

  it('collapses a dangling end_day_id to the anchor day', () => {
    expect(reservationSpan(booking({ day_id: 105, end_day_id: 9999 }), idx)).toEqual({ lo: 5, hi: 5 });
  });

  it('returns null for a booking with no day, so it can be surfaced not dropped', () => {
    expect(reservationSpan(booking({ day_id: null }), idx)).toBeNull();
    expect(reservationSpan(booking({ day_id: 9999 }), idx)).toBeNull();
  });

  /** Every stay auto-creates a partner hotel reservation; counting both double-counts. */
  it('excludes the auto-created partner booking of a stay', () => {
    const rows = [booking({ id: 1, day_id: 101 }), booking({ id: 2, day_id: 101, accommodation_id: 601 })];
    expect(isStayPartnerBooking(rows[1]!)).toBe(true);
    expect(usableBookings(rows).map((r) => r.id)).toEqual([1]);
  });

  it('a booking crossing a boundary belongs to both legs', () => {
    const views = resolveAll([row(1, 1, 5), row(2, 6, 9)], idx);
    const span = reservationSpan(booking({ day_id: 105, end_day_id: 106 }), idx)!;
    expect(views.filter((v) => spanTouches(span.lo, span.hi, v)).map((v) => v.id)).toEqual([1, 2]);
  });

  const stay = (over: Partial<HostAccommodation>): HostAccommodation => ({
    id: 601,
    trip_id: 1,
    start_day_id: 101,
    end_day_id: 105,
    ...over,
  });

  /**
   * listAccommodations LEFT JOINs reservations, so a stay with two linked
   * bookings comes back twice. Last-wins dedupe would silently discard a title.
   */
  it('folds duplicate join rows into one stay, keeping every booking title', () => {
    const stays = dedupeAccommodations([
      stay({ reservation_title: 'Hotel Gracery' }),
      stay({ reservation_title: 'Late checkout' }),
      stay({ id: 602, start_day_id: 105, end_day_id: 109, reservation_title: null }),
    ]);

    expect(stays).toHaveLength(2);
    expect(stays[0]?.bookingTitles).toEqual(['Hotel Gracery', 'Late checkout']);
    expect(stays[1]?.bookingTitles).toEqual([]);
  });

  it('does not repeat an identical title', () => {
    const stays = dedupeAccommodations([stay({ reservation_title: 'Same' }), stay({ reservation_title: 'Same' })]);
    expect(stays[0]?.bookingTitles).toEqual(['Same']);
  });

  it('spans a stay across its day range', () => {
    expect(accommodationSpan(stay({}), idx)).toEqual({ lo: 1, hi: 5 });
    expect(accommodationSpan(stay({ start_day_id: 9999, end_day_id: 9999 }), idx)).toBeNull();
  });

  it('counts nights, not days', () => {
    expect(nightsBetween(1, 5)).toBe(4);
    expect(nightsBetween(3, 3)).toBe(0);
  });
});

describe('formatting', () => {
  /** A bare ISO date through `new Date()` renders as the previous day west of UTC. */
  it('formats a date without a timezone shift', () => {
    expect(shortDate('2026-01-01')).toBe('Jan 1');
    expect(shortDate('2026-12-31')).toBe('Dec 31');
    expect(shortDate(null)).toBeNull();
    expect(shortDate('nonsense')).toBeNull();
  });

  it('labels day and date ranges, collapsing single days', () => {
    expect(dayRangeLabel(3, 7)).toBe('Day 3–7');
    expect(dayRangeLabel(3, 3)).toBe('Day 3');
    expect(dateRangeLabel('2026-04-12', '2026-04-16')).toBe('Apr 12 – Apr 16');
    expect(dateRangeLabel('2026-04-12', '2026-04-12')).toBe('Apr 12');
    expect(dateRangeLabel(null, null)).toBeNull();
  });

  it('renders uncovered ranges compactly', () => {
    expect(rangesToText([[12, 14], [60, 60]])).toBe('12–14, 60');
    expect(rangesToText([])).toBe('');
  });

  /**
   * The host strips emoji from every label and DROPS an item whose label becomes
   * empty — so a leg named with only a flag would vanish from the day plan with
   * no error anywhere.
   */
  it('falls back to a positional name when a name is all emoji', () => {
    expect(safeLabel('Tokyo', 0)).toBe('Tokyo');
    expect(safeLabel('🇯🇵', 0)).toBe('Leg 1');
    expect(safeLabel('🌸🌸🌸', 4)).toBe('Leg 5');
    expect(safeLabel('   ', 2)).toBe('Leg 3');
    expect(safeLabel('Tokyo 🗼', 0)).toBe('Tokyo');
  });

  it('keeps labels within the host cap', () => {
    expect(safeLabel('x'.repeat(200), 0).length).toBeLessThanOrEqual(60);
  });
});

describe('palette', () => {
  it('offers eight distinct presets', () => {
    expect(PALETTE).toHaveLength(8);
    expect(new Set(PALETTE.map((s) => s.hex)).size).toBe(8);
    expect(hexForTone('default')).toBe('#4F46E5');
    expect(hexForTone('success')).toBe('#10B981');
    expect(hexForTone('warn')).toBe('#F59E0B');
    expect(hexForTone('danger')).toBe('#EF4444');
  });

  it('validates and canonicalises host-safe custom colours', () => {
    expect(isHexColor('#a1b2C3')).toBe(true);
    expect(normalizeHexColor('#a1b2C3')).toBe('#A1B2C3');
    expect(isHexColor('red 50%, url(https://evil.example/x.png)')).toBe(false);
  });

  it('derives a legacy tone without changing the custom colour', () => {
    expect(toneForColor('#0EA5E9')).toBe('success');
    expect(toneForColor('#F97316')).toBe('warn');
  });

  it('recognises only real tones', () => {
    expect(isTone('warn')).toBe(true);
    expect(isTone('warning')).toBe(false);
    expect(isTone(null)).toBe(false);
  });

  /** The host enum says `warn`; the design kit's CSS class says `--warning`. */
  it('maps the warn tone to the kit class that actually exists', () => {
    expect(toneChipClass('warn')).toBe('trek-chip--warning');
    expect(toneChipClass('success')).toBe('trek-chip--success');
  });
});
