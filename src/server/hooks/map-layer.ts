import { buildDayIndex, resolveAll } from '../../shared/drift';
import {
  MAP_CIRCLE_RADIUS_M,
  MAP_FEATURE_VERTEX_MAX,
  MAP_POLYLINE_OPACITY,
  MAP_POLYLINE_VERTEX_BUDGET,
  MAP_POLYLINE_WIDTH,
} from '../../shared/limits';
import { safeLabel } from '../../shared/format';
import { allocateBudget, cleanPath, decimate } from '../geometry';
import { listSegments } from '../repo';
import { ensureSchema } from '../schema';
import type { HostDay, MapLayerContribution, MapLayerFeature, PluginContext } from '../../shared/host-types';
import type { SegmentView } from '../../shared/types';

/** The stops of one leg, in visiting order, as raw coordinate pairs. */
function legPoints(days: readonly HostDay[], start: number, end: number): Array<[unknown, unknown]> {
  const raw: Array<[unknown, unknown]> = [];
  for (let pos = start; pos <= end; pos++) {
    const day = days[pos - 1];
    if (!day) continue;
    for (const assignment of day.assignments ?? []) {
      raw.push([assignment.place?.lat, assignment.place?.lng]);
    }
  }
  return raw;
}

/**
 * One coloured line per leg, following its stops in visiting order.
 *
 * Everything is pre-clipped so the host can never refuse a feature: it drops an
 * oversized shape whole rather than truncating it, and its 8000-vertex budget is
 * a running total, so one long leg could otherwise erase every leg after it.
 * With at most 40 legs sharing 7800 vertices plus one vertex per fallback
 * circle, the total stays under the cap by construction.
 */
export function buildFeatures(views: readonly SegmentView[], days: readonly HostDay[]): MapLayerFeature[] {
  const live: Array<{ view: SegmentView; path: ReturnType<typeof cleanPath> }> = [];
  for (const view of views) {
    if (view.effStart === null || view.effEnd === null) continue;
    live.push({ view, path: cleanPath(legPoints(days, view.effStart, view.effEnd)) });
  }

  const allowance = allocateBudget(
    live.map((l) => l.path.length),
    MAP_POLYLINE_VERTEX_BUDGET,
    MAP_FEATURE_VERTEX_MAX,
  );

  const features: MapLayerFeature[] = [];

  live.forEach(({ view, path }, i) => {
    const label = safeLabel(view.name, view.index).slice(0, 80);
    const points = decimate(path, allowance[i] ?? 0);

    if (points.length >= 2) {
      features.push({
        type: 'polyline',
        points,
        tone: view.tone,
        width: MAP_POLYLINE_WIDTH,
        opacity: MAP_POLYLINE_OPACITY,
        dash: 'solid',
        label,
      });
      return;
    }

    // A leg with a single located stop cannot be a line; mark it instead. Costs
    // one vertex against the host's budget.
    const only = path[0];
    if (only) {
      features.push({
        type: 'circle',
        center: only,
        radiusM: MAP_CIRCLE_RADIUS_M,
        tone: view.tone,
        opacity: MAP_POLYLINE_OPACITY,
        fill: true,
        label,
      });
    }
  });

  return features;
}

export async function getLayers(tripId: number, ctx: PluginContext): Promise<MapLayerContribution[]> {
  try {
    await ensureSchema(ctx);

    const rows = await listSegments(ctx, tripId);
    if (rows.length === 0) return [];

    const days = await ctx.trips.getDays(tripId);
    const features = buildFeatures(resolveAll(rows, buildDayIndex(days)), days);
    if (features.length === 0) return [];

    return [{ id: 'segments', name: 'Trip segments', features }];
  } catch (err) {
    ctx.log.warn('mapLayerProvider failed', {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
