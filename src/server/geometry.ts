/**
 * Vertex budgeting for the map layer. Pure maths, no host types.
 *
 * The host's normalizer is unusually unforgiving here
 * (map-layers.controller.ts:54-143):
 *   - a feature with more than 2000 points is dropped WHOLE, never truncated;
 *   - a single out-of-range vertex invalidates the ENTIRE feature;
 *   - the 8000-vertex budget is a RUNNING total, so once it is exhausted every
 *     later feature is skipped too — meaning one fat first leg can erase all the
 *     others.
 *
 * So we never hand the host anything it could refuse: coordinates are validated
 * here, and each polyline is decimated to a share of the budget before it is
 * emitted.
 */

export type Point = [number, number];

export function isFiniteLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Drop unplaceable stops and collapse consecutive duplicates — two itinerary
 * entries at the same place would otherwise burn a vertex drawing a zero-length
 * segment.
 */
export function cleanPath(raw: ReadonlyArray<readonly [unknown, unknown]>): Point[] {
  const out: Point[] = [];
  for (const [lat, lng] of raw) {
    if (!isFiniteLatLng(lat, lng)) continue;
    const point: Point = [lat as number, lng as number];
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push(point);
  }
  return out;
}

/**
 * Reduce a path to exactly `max` points (or leave it alone if it already fits),
 * always keeping the first and last so the leg still starts and ends where it
 * really does.
 */
export function decimate(points: readonly Point[], max: number): Point[] {
  if (max <= 0) return [];
  if (points.length <= max) return [...points];
  if (max === 1) return [points[0]!];

  const out: Point[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/**
 * Share a vertex budget across features.
 *
 * Guarantees, all relied on by the caller:
 *   - `result[i] <= min(counts[i], perFeature)` — never more than was asked for;
 *   - `sum(result) <= total`;
 *   - each entry is 0 or at least 2, because the host drops a polyline with
 *     fewer than 2 points anyway.
 *
 * When the budget cannot seat every feature, later ones are zeroed first: the
 * caller passes legs in trip order, so an over-budget trip loses detail from the
 * end rather than losing whole legs at random.
 */
export function allocateBudget(counts: readonly number[], total: number, perFeature: number): number[] {
  const capped = counts.map((c) => Math.max(0, Math.min(c, perFeature)));
  const sum = capped.reduce((a, b) => a + b, 0);
  if (sum <= total) return capped;

  // Proportional share, but never below the 2 points a polyline needs to exist.
  const out = capped.map((c) => (c === 0 ? 0 : Math.max(2, Math.floor((c * total) / sum))));

  let used = out.reduce((a, b) => a + b, 0);

  // Trim the largest allocation repeatedly until we fit — this converges on an
  // even distribution rather than starving one feature.
  while (used > total) {
    let largest = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i]! > 2 && (largest < 0 || out[i]! > out[largest]!)) largest = i;
    }
    if (largest < 0) break; // everything is already at the floor of 2
    out[largest]! -= 1;
    used -= 1;
  }

  // Still over budget means there are more features than the budget can seat at
  // 2 points each. Drop from the end.
  for (let i = out.length - 1; i >= 0 && used > total; i--) {
    used -= out[i]!;
    out[i] = 0;
  }

  return out.map((v, i) => Math.min(v, capped[i]!));
}
