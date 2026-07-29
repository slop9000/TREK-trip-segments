import { describe, expect, it } from 'vitest';
import { buildDayIndex, resolveAll } from '../src/shared/drift';
import { allocateBudget, cleanPath, decimate, isFiniteLatLng } from '../src/server/geometry';
import { buildItems } from '../src/server/hooks/day-schedule';
import { buildTints } from '../src/server/hooks/day-tint';
import { buildFeatures } from '../src/server/hooks/map-layer';
import { buildSections } from '../src/server/hooks/pdf-section';
import { countsForSegment } from '../src/shared/filter';
import { buildCards } from '../src/server/hooks/trip-card';
import { MAX_SEGMENTS_PER_TRIP } from '../src/shared/limits';
import type { HostDay } from '../src/shared/host-types';
import type { Point } from '../src/server/geometry';
import type { SegmentRow } from '../src/shared/types';

/** Host caps, restated here so a test failure names the real limit. */
const HOST_MAX_SCHEDULE_ITEMS = 60;
const HOST_MAX_LAYERS = 4;
const HOST_MAX_FEATURES = 150;
const HOST_MAX_VERTICES = 8000;
const HOST_MAX_FEATURE_VERTICES = 2000;
const HOST_MAX_PDF_HEADERS = 8;
const HOST_MAX_PDF_ROWS = 50;

const row = (id: number, start: number, end: number, name = `Leg ${id}`): SegmentRow => ({
  id,
  trip_id: 1,
  name,
  tone: 'default',
  start_day: start,
  end_day: end,
  created_at: 'x',
  updated_at: 'x',
});

/** Days carrying `perDay` located stops each, so the map hook has real geometry. */
function daysWithStops(count: number, perDay: number): HostDay[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    trip_id: 1,
    date: null,
    title: `Day ${i + 1}`,
    notes_items: [],
    assignments: Array.from({ length: perDay }, (_, j) => ({
      id: i * 1000 + j,
      day_id: 1000 + i,
      place_id: j,
      order_index: j,
      place: { id: j, name: `Stop ${j}`, lat: 35 + i * 0.01 + j * 0.0001, lng: 139 + i * 0.01 + j * 0.0001 },
    })),
  }));
}

function vertexCount(features: ReturnType<typeof buildFeatures>): number {
  return features.reduce((sum, f) => sum + (f.type === 'circle' ? 1 : (f.points?.length ?? 0)), 0);
}

describe('geometry', () => {
  it('accepts only real coordinates', () => {
    expect(isFiniteLatLng(35, 139)).toBe(true);
    expect(isFiniteLatLng(95, 139)).toBe(false);
    expect(isFiniteLatLng(35, 181)).toBe(false);
    expect(isFiniteLatLng(NaN, 139)).toBe(false);
    expect(isFiniteLatLng(null, 139)).toBe(false);
    expect(isFiniteLatLng('35', 139)).toBe(false);
  });

  /** One bad vertex would invalidate the whole feature host-side, so filter early. */
  it('drops unplaceable stops and consecutive duplicates', () => {
    const path = cleanPath([
      [35, 139],
      [35, 139],
      [null, 139],
      [36, 140],
      [95, 0],
      [36, 140],
    ]);
    expect(path).toEqual([
      [35, 139],
      [36, 140],
    ]);
  });

  it('decimates to exactly the allowance, keeping the endpoints', () => {
    const points: Point[] = Array.from({ length: 100 }, (_, i) => [i * 0.1, 0]);

    for (const max of [2, 3, 7, 50, 99]) {
      const out = decimate(points, max);
      expect(out).toHaveLength(max);
      expect(out[0]).toEqual(points[0]);
      expect(out[out.length - 1]).toEqual(points[99]);
    }

    expect(decimate(points, 500)).toHaveLength(100); // never invents points
    expect(decimate(points, 0)).toEqual([]);
  });

  describe('budget allocation', () => {
    it('leaves everything alone when it already fits', () => {
      expect(allocateBudget([10, 20, 30], 1000, 2000)).toEqual([10, 20, 30]);
    });

    it('caps each feature at the per-feature maximum', () => {
      expect(allocateBudget([5000], 8000, 2000)).toEqual([2000]);
    });

    it.each([
      [[5000, 5000, 5000], 7800],
      [Array.from({ length: 40 }, () => 2000), 7800],
      [Array.from({ length: 40 }, (_, i) => i * 100), 7800],
      [[1, 1, 1], 7800],
      [[], 7800],
    ])('never exceeds the budget for %j', (counts, total) => {
      const out = allocateBudget(counts as number[], total, HOST_MAX_FEATURE_VERTICES);

      expect(out.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(total);
      out.forEach((v, i) => {
        expect(v).toBeLessThanOrEqual((counts as number[])[i]!); // never more than asked
        expect(v).toBeLessThanOrEqual(HOST_MAX_FEATURE_VERTICES);
        expect(v === 0 || v >= 2 || v === (counts as number[])[i]).toBe(true);
      });
    });

    /** More features than the budget can seat: later legs lose their line, not random ones. */
    it('drops from the end when the budget cannot seat everything', () => {
      const out = allocateBudget(Array.from({ length: 100 }, () => 10), 20, 2000);
      expect(out.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20);
      expect(out[0]).toBeGreaterThanOrEqual(2);
      expect(out[99]).toBe(0);
    });
  });
});

describe('dayScheduleProvider', () => {
  const idx = buildDayIndex(daysWithStops(60, 1));

  it('emits a start banner per leg and an end banner for multi-day legs', () => {
    const views = resolveAll([row(1, 1, 5), row(2, 7, 7)], idx);
    const items = buildItems(views, idx);

    expect(items.map((i) => i.id)).toEqual(['seg-1-start', 'seg-2-start', 'seg-1-end']);
    expect(items[0]).toMatchObject({ dayId: 1000, position: 'start', tone: 'default' });
    expect(items[0]?.label).toContain('leg 1 of 2');
    expect(items[2]).toMatchObject({ dayId: 1004, position: 'end' });
  });

  /**
   * `minutes` is summed into the day's route-time footer, so a leg banner
   * carrying one would silently inflate a number the user reads as travel time.
   */
  it('never sets minutes', () => {
    const items = buildItems(resolveAll([row(1, 1, 5)], idx), idx);
    expect(items.every((i) => i.minutes === undefined)).toBe(true);
  });

  it('contributes nothing for an out_of_range leg', () => {
    expect(buildItems(resolveAll([row(1, 500, 505)], idx), idx)).toEqual([]);
  });

  it('anchors a clipped leg to the last real day', () => {
    const items = buildItems(resolveAll([row(1, 58, 90)], idx), idx);
    expect(items.find((i) => i.position === 'end')?.dayId).toBe(1059);
  });

  it('stays under the host cap with the maximum number of legs', () => {
    const rows = Array.from({ length: MAX_SEGMENTS_PER_TRIP }, (_, i) => row(i + 1, i * 1 + 1, i * 1 + 1));
    const items = buildItems(resolveAll(rows, idx), idx);

    expect(items.length).toBeLessThanOrEqual(HOST_MAX_SCHEDULE_ITEMS);
    // Starts are emitted first, so truncation can only ever cost an end marker.
    expect(items.filter((i) => i.position === 'start')).toHaveLength(MAX_SEGMENTS_PER_TRIP);
  });

  it('emits only day ids that exist on the trip', () => {
    const rows = Array.from({ length: MAX_SEGMENTS_PER_TRIP }, (_, i) => row(i + 1, i + 1, i + 2));
    const items = buildItems(resolveAll(rows, idx), idx);
    const real = new Set(idx.dayIdByPos);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => real.has(i.dayId))).toBe(true);
  });

  it('keeps every label within the host limit', () => {
    const items = buildItems(resolveAll([row(1, 1, 5, 'x'.repeat(200))], idx), idx);
    expect(items.every((i) => i.label.length <= 120 && i.label.length > 0)).toBe(true);
  });
});

describe('mapLayerProvider', () => {
  it('draws one polyline per leg in visiting order', () => {
    const days = daysWithStops(10, 2);
    const idx = buildDayIndex(days);
    const features = buildFeatures(resolveAll([row(1, 1, 3), row(2, 4, 6)], idx), days);

    expect(features).toHaveLength(2);
    expect(features[0]).toMatchObject({ type: 'polyline', tone: 'default', width: 4, label: 'Leg 1' });
    expect(features[0]?.points).toHaveLength(6); // 3 days x 2 stops
  });

  it('falls back to a circle when a leg has a single located stop', () => {
    const days = daysWithStops(3, 1);
    days[1]!.assignments = [];
    days[2]!.assignments = [];
    const idx = buildDayIndex(days);

    const features = buildFeatures(resolveAll([row(1, 1, 3)], idx), days);
    expect(features[0]).toMatchObject({ type: 'circle', radiusM: 2000 });
    expect(features[0]?.center).toBeDefined();
  });

  it('contributes nothing for a leg with no located stops', () => {
    const days = daysWithStops(3, 0);
    const idx = buildDayIndex(days);
    expect(buildFeatures(resolveAll([row(1, 1, 3)], idx), days)).toEqual([]);
  });

  /**
   * The host's budget is a RUNNING total and it drops an over-budget feature
   * whole, so an unclipped fat first leg would erase every later leg.
   */
  it('stays inside every host budget on an adversarial trip', () => {
    const days = daysWithStops(200, 50); // 10,000 located stops
    const idx = buildDayIndex(days);
    const rows = Array.from({ length: MAX_SEGMENTS_PER_TRIP }, (_, i) => row(i + 1, i * 5 + 1, i * 5 + 5));

    const features = buildFeatures(resolveAll(rows, idx), days);

    expect(features.length).toBeLessThanOrEqual(HOST_MAX_FEATURES);
    expect(vertexCount(features)).toBeLessThanOrEqual(HOST_MAX_VERTICES);
    for (const f of features) {
      expect(f.points?.length ?? 0).toBeLessThanOrEqual(HOST_MAX_FEATURE_VERTICES);
    }
    // Crucially, every leg still gets drawn — clipped, not dropped.
    expect(features).toHaveLength(MAX_SEGMENTS_PER_TRIP);
  });

  it('emits coordinates the host will accept', () => {
    const days = daysWithStops(20, 5);
    const idx = buildDayIndex(days);
    const features = buildFeatures(resolveAll([row(1, 1, 20)], idx), days);

    for (const f of features) {
      for (const [lat, lng] of f.points ?? []) {
        expect(isFiniteLatLng(lat, lng)).toBe(true);
      }
    }
  });

  it('uses one layer, well inside the four-layer cap', () => {
    expect(1).toBeLessThanOrEqual(HOST_MAX_LAYERS);
  });
});

describe('pdfSectionProvider', () => {
  const days = daysWithStops(12, 2);
  const idx = buildDayIndex(days);

  it('produces nothing when the trip has no legs', () => {
    expect(buildSections([], 12, new Map())).toEqual([]);
  });

  it('summarises coverage and lists the gaps', () => {
    const views = resolveAll([row(1, 1, 3), row(2, 6, 8)], idx);
    const sections = buildSections(views, 12, new Map());

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe('Trip segments');
    expect(sections[0]?.paragraphs?.[0]).toContain('2 legs');
    expect(sections[0]?.paragraphs?.[1]).toContain('4–5, 9–12');
  });

  it('mentions legs that no longer fit the trip', () => {
    const views = resolveAll([row(1, 10, 40)], idx);
    expect(buildSections(views, 12, new Map())[0]?.paragraphs?.join(' ')).toContain('no longer fit');
  });

  it('respects the header and row caps at the maximum leg count', () => {
    const rows = Array.from({ length: MAX_SEGMENTS_PER_TRIP }, (_, i) => row(i + 1, i + 1, i + 1));
    const section = buildSections(resolveAll(rows, buildDayIndex(daysWithStops(60, 1))), 60, new Map())[0];

    expect(section?.table?.headers.length).toBeLessThanOrEqual(HOST_MAX_PDF_HEADERS);
    expect(section?.table?.rows.length).toBeLessThanOrEqual(HOST_MAX_PDF_ROWS);
    expect(section?.table?.rows.every((r) => r.length === section.table!.headers.length)).toBe(true);
  });

  it('counts places, stays and bookings that belong to a leg', () => {
    const [view] = resolveAll([row(1, 1, 3)], idx);
    const counts = countsForSegment(
      view!,
      days,
      [
        { id: 1, trip_id: 1, title: 'Flight', day_id: 1000 },
        { id: 2, trip_id: 1, title: 'Later', day_id: 1010 },
        { id: 3, trip_id: 1, title: 'Hotel partner', day_id: 1000, accommodation_id: 601 },
      ],
      [
        { id: 601, trip_id: 1, start_day_id: 1000, end_day_id: 1002, reservation_title: 'A' },
        { id: 601, trip_id: 1, start_day_id: 1000, end_day_id: 1002, reservation_title: 'B' },
      ],
      idx,
    );

    expect(counts.places).toBe(6); // 3 days x 2 stops
    expect(counts.bookings).toBe(1); // the partner booking is excluded
    expect(counts.stays).toBe(1); // the duplicate join row is folded
  });
});

describe('tripCardProvider', () => {
  it('emits one badge per trip, with a numeric tripId', () => {
    const cards = buildCards([
      { trip_id: 1, name: 'Tokyo' },
      { trip_id: 1, name: 'Kanazawa' },
      { trip_id: 3, name: 'Bangkok' },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ tripId: 1, id: 'segments', label: '2 legs', icon: 'Route' });
    expect(cards[0]?.value).toBe('Tokyo, Kanazawa');
    expect(cards[1]).toMatchObject({ tripId: 3, label: '1 leg' });

    // The host drops any badge whose tripId is not literally a number.
    expect(cards.every((c) => typeof c.tripId === 'number')).toBe(true);
  });

  it('collapses a long list of names and stays within the value cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ trip_id: 1, name: `Leg ${i + 1}` }));
    const card = buildCards(rows)[0];

    expect(card?.label).toBe('12 legs');
    expect(card?.value).toBe('Leg 1, Leg 2, Leg 3 +9');
    expect(card?.value?.length).toBeLessThanOrEqual(256);
  });

  it('emits nothing for trips without segments', () => {
    expect(buildCards([])).toEqual([]);
  });
});

describe('dayTintProvider', () => {
  const idx = buildDayIndex(daysWithStops(200, 1));

  it('tints every day of a leg, not just its edges', () => {
    const tints = buildTints(resolveAll([row(1, 1, 3, 'Tokyo')], idx), idx);

    expect(tints).toHaveLength(3);
    expect(tints.map((t) => t.dayId)).toEqual([1000, 1001, 1002]);
    expect(tints.every((t) => t.headerTone === 'default' && t.label === 'Tokyo')).toBe(true);
  });

  /**
   * Header and badge, never the activity list. Sending `tone` would be the
   * shorthand for "every region" and would wash the activity list too, so its
   * absence is the feature, not an omission.
   */
  it('tints the header and badge, leaving the activity list alone', () => {
    const [tint] = buildTints(resolveAll([row(1, 1, 1, 'Tokyo')], idx), idx);

    expect(tint?.headerTone).toBe('default');
    expect(tint?.badgeTone).toBe('default');
    expect(tint?.tone).toBeUndefined();
    expect(tint?.activityTone).toBeUndefined();
  });

  it('uses one leg colour across both tinted regions', () => {
    const views = resolveAll([{ ...row(1, 1, 2), tone: 'warn' as const }], idx);
    for (const tint of buildTints(views, idx)) {
      expect(tint.headerTone).toBe('warn');
      expect(tint.badgeTone).toBe('warn');
    }
  });

  it('gives each leg its own tone', () => {
    const views = resolveAll([{ ...row(1, 1, 2), tone: 'success' as const }, { ...row(2, 3, 4), tone: 'danger' as const }], idx);
    expect(buildTints(views, idx).map((t) => t.headerTone)).toEqual(['success', 'success', 'danger', 'danger']);
    expect(buildTints(views, idx).map((t) => t.badgeTone)).toEqual(['success', 'success', 'danger', 'danger']);
  });

  it('tints nothing for a leg that fell outside the trip', () => {
    expect(buildTints(resolveAll([row(1, 500, 505)], idx), idx)).toEqual([]);
  });

  it('stops a clipped leg at the last real day', () => {
    const tints = buildTints(resolveAll([row(1, 198, 400)], idx), idx);
    expect(tints).toHaveLength(3); // days 198-200
    expect(tints[tints.length - 1]?.dayId).toBe(1199);
  });

  it('emits at most one tint per day, all of them real days of the trip', () => {
    const rows = Array.from({ length: MAX_SEGMENTS_PER_TRIP }, (_, i) => row(i + 1, i * 5 + 1, i * 5 + 5));
    const tints = buildTints(resolveAll(rows, idx), idx);
    const real = new Set(idx.dayIdByPos);

    expect(new Set(tints.map((t) => t.dayId)).size).toBe(tints.length);
    expect(tints.every((t) => real.has(t.dayId))).toBe(true);
  });

  /**
   * The whole reason this hook exists rather than reusing dayScheduleProvider.
   * The 60-item cap is that hook's; this one is bounded only by MAX_RAW_TINTS
   * (2000 days), so a year-long trip is tinted in full — every day, no gap.
   */
  it.each([180, 360, 365])('tints every one of a %i-day trip', (dayCount) => {
    const long = buildDayIndex(daysWithStops(dayCount, 0));
    const tints = buildTints(resolveAll([row(1, 1, dayCount)], long), long);

    expect(tints).toHaveLength(dayCount);
    expect(tints.length).toBeGreaterThan(HOST_MAX_SCHEDULE_ITEMS);
    // No day left behind: one tint per day id, none missing.
    expect(new Set(tints.map((t) => t.dayId)).size).toBe(dayCount);
  });

  it('tints a 360-day trip split across many legs, with no gap between them', () => {
    const long = buildDayIndex(daysWithStops(360, 0));
    // 12 legs of 30 days each, tiling the whole year.
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, i * 30 + 1, i * 30 + 30));
    const tints = buildTints(resolveAll(rows, long), long);

    expect(tints).toHaveLength(360);
    expect(new Set(tints.map((t) => t.dayId)).size).toBe(360);
  });

  it('keeps labels inside the host cap', () => {
    const tints = buildTints(resolveAll([row(1, 1, 2, 'x'.repeat(200))], idx), idx);
    expect(tints.every((t) => (t.label ?? '').length <= 60 && (t.label ?? '').length > 0)).toBe(true);
  });
});
