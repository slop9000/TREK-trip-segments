/**
 * Every magic number in one auditable place. The host-imposed ones cite where
 * they are enforced; exceeding them is silent, so we stay strictly under.
 */

/** Our own cap. Chosen so 40 "leg begins" banners still fit the host's 60-item day-schedule budget. */
export const MAX_SEGMENTS_PER_TRIP = 40;

/** Our own cap, well under the host's 120-char day-schedule label limit once decorated. */
export const NAME_MAX = 60;

/** Refuse absurd ranges even on a trip that legitimately has many days. */
export const MAX_TRIP_DAYS = 3650;

/** day-schedule.controller.ts:39 — MAX_ITEMS, per provider, across the whole trip. */
export const DAY_SCHEDULE_MAX_ITEMS = 60;

/**
 * map-layers.controller.ts:48 caps a provider at 8000 vertices. We budget 7800
 * for polylines and leave headroom for one circle per segment (1 vertex each),
 * so the running total can never reach the host's limit — where it would start
 * dropping whole features.
 */
export const MAP_POLYLINE_VERTEX_BUDGET = 7800;

/** map-layers.controller.ts:49 — MAX_FEATURE_POINTS. An oversized feature is dropped whole. */
export const MAP_FEATURE_VERTEX_MAX = 2000;

/** Radius of the marker circle drawn for a leg's first stop, in metres. */
export const MAP_CIRCLE_RADIUS_M = 2000;

export const MAP_POLYLINE_WIDTH = 4;
export const MAP_POLYLINE_OPACITY = 0.85;

/** pdf-sections.controller.ts:38 — MAX_ROWS. */
export const PDF_MAX_ROWS = 50;

/** trip-card-contributions.controller.ts:29 — MAX_TRIP_IDS. */
export const TRIP_CARD_MAX_TRIPS = 60;

/** How many leg names to list in the trip-card badge before collapsing to "+N". */
export const TRIP_CARD_NAME_PREVIEW = 3;

/**
 * day-tints.controller.ts:41 — MAX_RAW_TINTS. A trip has one tint per day and
 * 2000 days is five and a half years, so this only ever bounds a bug.
 */
export const DAY_TINT_MAX = 2000;
