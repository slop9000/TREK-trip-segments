"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/server/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// src/server/schema.ts
var MIGRATION_ID = "001-segments";
var COLOR_MIGRATION_ID = "002-segment-color";
var SQL_PROBE_COLOR = "SELECT color FROM segments LIMIT 0";
var MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4F46E5',
  tone       TEXT NOT NULL DEFAULT 'default',
  start_day  INTEGER NOT NULL,
  end_day    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_day >= 1),
  CHECK (end_day >= start_day),
  CHECK (tone IN ('default','success','warn','danger'))
);
CREATE INDEX IF NOT EXISTS idx_segments_trip ON segments(trip_id, start_day);
`;
var COLOR_MIGRATION_SQL = `
ALTER TABLE segments ADD COLUMN color TEXT;
UPDATE segments
SET color = CASE tone
  WHEN 'success' THEN '#10B981'
  WHEN 'warn' THEN '#F59E0B'
  WHEN 'danger' THEN '#EF4444'
  ELSE '#4F46E5'
END
WHERE color IS NULL;
`;
var pending = null;
function ensureSchema(ctx) {
  if (!pending) {
    pending = (async () => {
      await ctx.db.migrate(MIGRATION_ID, MIGRATION_SQL);
      try {
        await ctx.db.query(SQL_PROBE_COLOR);
      } catch {
        await ctx.db.migrate(COLOR_MIGRATION_ID, COLOR_MIGRATION_SQL);
      }
    })().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

// src/shared/drift.ts
function buildDayIndex(days) {
  const posByDayId = /* @__PURE__ */ new Map();
  const dayIdByPos = [];
  const dateByPos = [];
  days.forEach((day, i) => {
    posByDayId.set(day.id, i + 1);
    dayIdByPos.push(day.id);
    dateByPos.push(day.date ?? null);
  });
  return { count: days.length, posByDayId, dayIdByPos, dateByPos };
}
function resolveSegment(row, dayCount, index, dateByPos) {
  const start = Math.max(1, row.start_day);
  if (dayCount === 0 || start > dayCount) {
    return {
      ...row,
      index,
      status: "out_of_range",
      effStart: null,
      effEnd: null,
      effLength: 0,
      startDate: null,
      endDate: null
    };
  }
  const effEnd = Math.min(row.end_day, dayCount);
  return {
    ...row,
    index,
    status: row.end_day > dayCount ? "clipped" : "ok",
    effStart: start,
    effEnd,
    effLength: effEnd - start + 1,
    startDate: dateByPos?.[start - 1] ?? null,
    endDate: dateByPos?.[effEnd - 1] ?? null
  };
}
function resolveAll(rows2, idx) {
  return [...rows2].sort((a, b) => a.start_day - b.start_day || a.id - b.id).map((row, i) => resolveSegment(row, idx.count, i, idx.dateByPos));
}
function spanTouches(lo, hi, view) {
  return view.effStart !== null && view.effEnd !== null && lo <= view.effEnd && hi >= view.effStart;
}
function uncoveredRanges(views, dayCount) {
  const covered = [];
  for (const v of views) {
    if (v.effStart !== null && v.effEnd !== null) covered.push([v.effStart, v.effEnd]);
  }
  covered.sort((a, b) => a[0] - b[0]);
  const out = [];
  let cursor = 1;
  for (const [lo, hi] of covered) {
    if (lo > cursor) out.push([cursor, lo - 1]);
    cursor = Math.max(cursor, hi + 1);
  }
  if (cursor <= dayCount) out.push([cursor, dayCount]);
  return out;
}
function coveredDayCount(views, dayCount) {
  return dayCount - uncoveredRanges(views, dayCount).reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
}

// src/shared/limits.ts
var MAX_SEGMENTS_PER_TRIP = 40;
var NAME_MAX = 60;
var MAX_TRIP_DAYS = 3650;
var DAY_SCHEDULE_MAX_ITEMS = 60;
var MAP_POLYLINE_VERTEX_BUDGET = 7800;
var MAP_FEATURE_VERTEX_MAX = 2e3;
var MAP_CIRCLE_RADIUS_M = 2e3;
var MAP_POLYLINE_WIDTH = 4;
var MAP_POLYLINE_OPACITY = 0.85;
var PDF_MAX_ROWS = 50;
var TRIP_CARD_MAX_TRIPS = 60;
var TRIP_CARD_NAME_PREVIEW = 3;
var DAY_TINT_MAX = 2e3;

// src/shared/palette.ts
var HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
var HEX_BY_TONE = {
  default: "#4F46E5",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444"
};
function isTone(value) {
  return value === "default" || value === "success" || value === "warn" || value === "danger";
}
function isHexColor(value) {
  return typeof value === "string" && HEX_PATTERN.test(value);
}
function normalizeHexColor(value) {
  return isHexColor(value) ? value.toUpperCase() : null;
}
function hexForTone(tone) {
  return HEX_BY_TONE[tone] ?? HEX_BY_TONE.default;
}
function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function toneForColor(color) {
  const normalized = normalizeHexColor(color) ?? HEX_BY_TONE.default;
  const [r, g, b] = rgb(normalized);
  let best = "default";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tone of ["default", "success", "warn", "danger"]) {
    const [tr, tg, tb] = rgb(HEX_BY_TONE[tone]);
    const distance = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (distance < bestDistance) {
      best = tone;
      bestDistance = distance;
    }
  }
  return best;
}

// src/shared/knock-on.ts
var RESOLUTIONS = ["push", "take", "give", "pull", "gap"];
function isResolution(value) {
  return typeof value === "string" && RESOLUTIONS.includes(value);
}
function sameUpdates(a, b) {
  if (a.length !== b.length) return false;
  return a.every((u) => b.some((v) => v.id === u.id && v.start_day === u.start_day && v.end_day === u.end_day));
}
function byPosition(a, b) {
  return a.start_day - b.start_day || a.id - b.id;
}
function byFrom(a, b) {
  return a.from[0] - b.from[0] || a.id - b.id;
}
function option(resolution, legs, dayCount, next) {
  const changes = [];
  let blockedBy = null;
  legs.forEach((leg, i) => {
    const raw = next(leg, i);
    const moved = raw[0] !== leg.start_day || raw[1] !== leg.end_day;
    const to = moved ? [raw[0], Math.min(raw[1], dayCount)] : raw;
    const gone = to[1] < to[0] || to[1] < 1 || to[0] > dayCount;
    if (gone && !blockedBy) blockedBy = { id: leg.id, name: leg.name };
    if (moved) {
      changes.push({ id: leg.id, name: leg.name, color: leg.color, from: [leg.start_day, leg.end_day], to });
    }
  });
  changes.sort(byFrom);
  return { resolution, changes, blockedBy, sameAs: null };
}
function choice(side, kind, span, shift, neighbour, options) {
  for (const [i, o] of options.entries()) {
    const twin = options.slice(0, i).find((earlier) => sameChanges(earlier.changes, o.changes));
    o.sameAs = twin?.resolution ?? null;
  }
  return {
    side,
    kind,
    days: span[1] - span[0] + 1,
    span,
    shift,
    neighbour: {
      id: neighbour.id,
      name: neighbour.name,
      color: neighbour.color,
      range: [neighbour.start_day, neighbour.end_day]
    },
    options,
    recommended: options.find((o) => !o.blockedBy)?.resolution ?? null
  };
}
function sameChanges(a, b) {
  return a.length === b.length && a.every((c, i) => c.id === b[i]?.id && c.to[0] === b[i]?.to[0] && c.to[1] === b[i]?.to[1]);
}
function planEnd(old, edited, later, dayCount) {
  const [oldStart, oldEnd] = old;
  const [newStart, newEnd] = edited;
  if (later.length === 0) return null;
  const inWay = later.filter((leg) => leg.end_day >= newStart);
  const hit = inWay[0];
  if (newEnd > oldEnd && hit && hit.start_day <= newEnd) {
    const d = newEnd - hit.start_day + 1;
    const lastHit = Math.max(...inWay.filter((leg) => leg.start_day <= newEnd).map((leg) => leg.end_day));
    const span = [Math.max(newStart, hit.start_day), Math.min(newEnd, lastHit)];
    return choice("end", "grow", span, d, hit, [
      option("push", inWay, dayCount, (leg) => [leg.start_day + d, leg.end_day + d]),
      option("take", [hit], dayCount, (leg) => [newEnd + 1, leg.end_day])
    ]);
  }
  const next = later[0];
  if (newEnd < oldEnd && next.start_day === oldEnd + 1) {
    const freedFrom = Math.max(newEnd + 1, oldStart);
    const d = oldEnd - freedFrom + 1;
    const last = later.length - 1;
    return choice("end", "shrink", [freedFrom, oldEnd], d, next, [
      option("give", [next], dayCount, (leg) => [freedFrom, leg.end_day]),
      option("pull", later, dayCount, (leg, i) => [leg.start_day - d, i === last ? leg.end_day : leg.end_day - d]),
      option("gap", [], dayCount, (leg) => [leg.start_day, leg.end_day])
    ]);
  }
  return null;
}
function planStart(old, edited, earlier, dayCount) {
  const [oldStart, oldEnd] = old;
  const [newStart, newEnd] = edited;
  if (earlier.length === 0) return null;
  const inWay = earlier.filter((leg) => leg.start_day <= newEnd);
  const hit = inWay[0];
  if (newStart < oldStart && hit && hit.end_day >= newStart) {
    const d = hit.end_day - newStart + 1;
    const firstHit = Math.min(...inWay.filter((leg) => leg.end_day >= newStart).map((leg) => leg.start_day));
    const span = [Math.max(newStart, firstHit), Math.min(newEnd, hit.end_day)];
    return choice("start", "grow", span, d, hit, [
      option("take", [hit], dayCount, (leg) => [leg.start_day, newStart - 1]),
      option("push", inWay, dayCount, (leg) => [Math.max(leg.start_day - d, 1), leg.end_day - d])
    ]);
  }
  const prev = earlier[0];
  if (newStart > oldStart && prev.end_day === oldStart - 1) {
    const freedTo = Math.min(newStart - 1, oldEnd);
    const d = freedTo - oldStart + 1;
    const first = earlier.length - 1;
    return choice("start", "shrink", [oldStart, freedTo], d, prev, [
      option("give", [prev], dayCount, (leg) => [leg.start_day, freedTo]),
      option("pull", earlier, dayCount, (leg, i) => [i === first ? leg.start_day : leg.start_day + d, leg.end_day + d]),
      option("gap", [], dayCount, (leg) => [leg.start_day, leg.end_day])
    ]);
  }
  return null;
}
function planKnockOn(edited, rows2, dayCount) {
  const original = rows2.find((r) => r.id === edited.id);
  if (!original) return { choices: [] };
  const others = rows2.filter((r) => r.id !== edited.id).sort(byPosition);
  const inTrip = others.filter((r) => r.start_day <= dayCount);
  const later = inTrip.filter((r) => r.start_day > original.end_day);
  const earlier = inTrip.filter((r) => r.end_day < original.start_day).reverse();
  const old = [original.start_day, original.end_day];
  const range = [edited.start_day, edited.end_day];
  const choices = [];
  const start = planStart(old, range, earlier, dayCount);
  if (start) choices.push(start);
  const end = planEnd(old, range, later, dayCount);
  if (end) choices.push(end);
  return { choices };
}
function pickedOption(c, pick) {
  const wanted = c.options.find((o) => o.resolution === pick && !o.blockedBy);
  if (wanted) return wanted;
  return c.options.find((o) => o.resolution === c.recommended) ?? null;
}
function toRangeUpdates(changes) {
  return changes.map((c) => ({ id: c.id, start_day: c.to[0], end_day: c.to[1] }));
}
function plannedChanges(plan, picks, mode = "strict") {
  const out = [];
  for (const c of plan.choices) {
    const pick = picks[c.side];
    if (pick === void 0 && mode === "strict") continue;
    const picked = mode === "lenient" ? pickedOption(c, pick) : c.options.find((o) => o.resolution === pick && !o.blockedBy);
    if (!picked) return { ok: false, side: c.side, resolution: pick ?? null };
    out.push(...picked.changes);
  }
  return { ok: true, changes: out.sort(byFrom) };
}

// src/shared/validate.ts
function isControl(codePoint) {
  return codePoint < 32 || codePoint === 127;
}
function normalizeName(raw) {
  let out = "";
  for (const ch of String(raw ?? "")) {
    out += isControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo <= bHi && aHi >= bLo;
}
function findOverlap(input, existing, editingId) {
  for (const row of existing) {
    if (editingId !== void 0 && row.id === editingId) continue;
    if (rangesOverlap(input.start_day, input.end_day, row.start_day, row.end_day)) return row;
  }
  return null;
}
function applyRangeUpdates(existing, others) {
  const byId = new Map(others.map((u) => [u.id, u]));
  return existing.map((row) => {
    const update = byId.get(row.id);
    return update ? { ...row, start_day: update.start_day, end_day: update.end_day } : row;
  });
}
function movedOverlap(world, others, editingId) {
  const legs = world.filter((r) => r.id !== editingId);
  return others.some((u) => findOverlap(u, legs, u.id) !== null);
}
function validateSegmentInput(input, opts) {
  const issues = [];
  const name = normalizeName(input.name);
  if (name.length === 0) issues.push("name_required");
  else if (name.length > NAME_MAX) issues.push("name_too_long");
  if (!isHexColor(input.color)) issues.push("color_invalid");
  const start = input.start_day;
  const end = input.end_day;
  const others = opts.others ?? [];
  const world = others.length > 0 ? applyRangeUpdates(opts.existing, others) : opts.existing;
  const rangeWellFormed = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= MAX_TRIP_DAYS;
  if (!rangeWellFormed) {
    issues.push("range_invalid");
  } else if (end > opts.dayCount) {
    issues.push("range_out_of_bounds");
  } else if (findOverlap({ start_day: start, end_day: end }, world, opts.editingId) || movedOverlap(world, others, opts.editingId)) {
    issues.push("overlap");
  }
  if (opts.editingId === void 0 && opts.existing.length >= MAX_SEGMENTS_PER_TRIP) {
    issues.push("limit_reached");
  }
  return issues;
}

// src/shared/filter.ts
function dedupeAccommodations(rows2) {
  const byId = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const existing = byId.get(row.id);
    if (existing) {
      if (row.reservation_title && !existing.bookingTitles.includes(row.reservation_title)) {
        existing.bookingTitles.push(row.reservation_title);
      }
      continue;
    }
    byId.set(row.id, {
      ...row,
      bookingTitles: row.reservation_title ? [row.reservation_title] : []
    });
  }
  return [...byId.values()];
}
function isStayPartnerBooking(reservation) {
  return reservation.accommodation_id != null;
}
function reservationSpan(reservation, idx) {
  if (reservation.day_id == null) return null;
  const start = idx.posByDayId.get(reservation.day_id);
  if (start === void 0) return null;
  const rawEnd = reservation.end_day_id == null ? start : idx.posByDayId.get(reservation.end_day_id);
  const end = rawEnd ?? start;
  return { lo: Math.min(start, end), hi: Math.max(start, end) };
}
function accommodationSpan(stay, idx) {
  const start = idx.posByDayId.get(stay.start_day_id);
  const end = idx.posByDayId.get(stay.end_day_id);
  const lo = start ?? end;
  const hi = end ?? start;
  if (lo === void 0 || hi === void 0) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}
function usableBookings(reservations) {
  return reservations.filter((r) => !isStayPartnerBooking(r));
}
function countsForSegment(view, days, reservations, accommodations, idx) {
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

// src/shared/format.ts
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var EN_DASH = "\u2013";
function shortDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}
function dayRangeLabel(from, to) {
  return from === to ? `Day ${from}` : `Day ${from}${EN_DASH}${to}`;
}
function dateRangeLabel(from, to) {
  const a = shortDate(from);
  const b = shortDate(to);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b || a === b) return a;
  return `${a} ${EN_DASH} ${b}`;
}
function rangesToText(ranges) {
  return ranges.map(([lo, hi]) => lo === hi ? String(lo) : `${lo}${EN_DASH}${hi}`).join(", ");
}
function nightsBetween(lo, hi) {
  return Math.max(0, hi - lo);
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function safeLabel(name, index) {
  const stripped = stripEmojiLike(name).trim().slice(0, 60);
  return stripped.length > 0 ? stripped : `Leg ${index + 1}`;
}
var INVISIBLE_CODE_POINTS = /* @__PURE__ */ new Set([65038, 65039, 8205, 8419, 8203]);
function stripEmojiLike(text) {
  let out = "";
  for (const ch of text) {
    if (!INVISIBLE_CODE_POINTS.has(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.replace(/[\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, "").replace(/[ \t]+/g, " ");
}

// src/server/repo.ts
var COLUMNS = "id, trip_id, name, color, tone, start_day, end_day, created_at, updated_at";
var SQL_LIST = `SELECT ${COLUMNS} FROM segments WHERE trip_id = ? ORDER BY start_day ASC, id ASC`;
var SQL_GET = `SELECT ${COLUMNS} FROM segments WHERE trip_id = ? AND id = ?`;
var SQL_COUNT = "SELECT COUNT(*) AS n FROM segments WHERE trip_id = ?";
var SQL_DELETE = "DELETE FROM segments WHERE trip_id = ? AND id = ?";
var SQL_INSERT_IF_FREE = `INSERT INTO segments (trip_id, name, color, tone, start_day, end_day)
SELECT ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM segments WHERE trip_id = ?) < ?
  AND NOT EXISTS (SELECT 1 FROM segments WHERE trip_id = ? AND start_day <= ? AND end_day >= ?)
RETURNING ${COLUMNS}`;
var SQL_UPDATE_IF_FREE = `UPDATE segments
SET name = ?, color = ?, tone = ?, start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ?
  AND NOT EXISTS (SELECT 1 FROM segments WHERE trip_id = ? AND id <> ? AND start_day <= ? AND end_day >= ?)
RETURNING ${COLUMNS}`;
var SQL_UPDATE_EDITED = `UPDATE segments
SET name = ?, color = ?, tone = ?, start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ? AND start_day = ? AND end_day = ?
RETURNING ${COLUMNS}`;
var SQL_UPDATE_RANGE = `UPDATE segments
SET start_day = ?, end_day = ?, updated_at = datetime('now')
WHERE id = ? AND trip_id = ? AND start_day = ? AND end_day = ?`;
function sqlAbortIfLayoutBroken(touched) {
  const planned = new Array(touched).fill("(id = ? AND start_day = ? AND end_day = ?)").join(" OR ");
  return `INSERT INTO segments (trip_id, name, color, tone, start_day, end_day)
SELECT ?, '', '#000000', 'default', 1, 0
WHERE EXISTS (
    SELECT 1 FROM segments a JOIN segments b
      ON b.trip_id = a.trip_id AND b.id > a.id AND a.start_day <= b.end_day AND a.end_day >= b.start_day
    WHERE a.trip_id = ?
  )
  OR (SELECT COUNT(*) FROM segments WHERE trip_id = ? AND (${planned})) <> ?`;
}
var ABORT_MESSAGE = /CHECK constraint failed/i;
function sqlListForTrips(count) {
  const placeholders = new Array(count).fill("?").join(", ");
  return `SELECT trip_id, name, color, tone, start_day, end_day FROM segments WHERE trip_id IN (${placeholders}) ORDER BY trip_id ASC, start_day ASC, id ASC`;
}
function toSegmentRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const id = Number(r["id"]);
  const tripId = Number(r["trip_id"]);
  const startDay = Number(r["start_day"]);
  const endDay = Number(r["end_day"]);
  if (!Number.isInteger(id) || !Number.isInteger(tripId)) return null;
  if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) return null;
  const tone = isTone(r["tone"]) ? r["tone"] : "default";
  return {
    id,
    trip_id: tripId,
    name: String(r["name"] ?? ""),
    color: normalizeHexColor(r["color"]) ?? hexForTone(tone),
    tone,
    start_day: startDay,
    end_day: endDay,
    created_at: String(r["created_at"] ?? ""),
    updated_at: String(r["updated_at"] ?? "")
  };
}
function rows(raw) {
  const out = [];
  for (const r of raw) {
    const row = toSegmentRow(r);
    if (row) out.push(row);
  }
  return out;
}
async function listSegments(ctx, tripId) {
  return rows(await ctx.db.query(SQL_LIST, tripId));
}
async function getSegment(ctx, tripId, id) {
  const found = rows(await ctx.db.query(SQL_GET, tripId, id));
  return found[0] ?? null;
}
async function countSegments(ctx, tripId) {
  const result = await ctx.db.query(SQL_COUNT, tripId);
  return Number(result[0]?.n ?? 0);
}
async function insertSegmentIfFree(ctx, tripId, input) {
  const created = await ctx.db.query(
    SQL_INSERT_IF_FREE,
    tripId,
    input.name,
    input.color,
    toneForColor(input.color),
    input.start_day,
    input.end_day,
    tripId,
    MAX_SEGMENTS_PER_TRIP,
    tripId,
    input.end_day,
    input.start_day
  );
  return rows(created)[0] ?? null;
}
async function updateSegmentIfFree(ctx, tripId, id, input) {
  const updated = await ctx.db.query(
    SQL_UPDATE_IF_FREE,
    input.name,
    input.color,
    toneForColor(input.color),
    input.start_day,
    input.end_day,
    id,
    tripId,
    tripId,
    id,
    input.end_day,
    input.start_day
  );
  return rows(updated)[0] ?? null;
}
async function updateSegmentWithOthers(ctx, tripId, edited, input, moves) {
  const touched = [{ ...edited, to: [input.start_day, input.end_day] }, ...moves];
  const ops = [
    {
      sql: SQL_UPDATE_EDITED,
      args: [
        input.name,
        input.color,
        toneForColor(input.color),
        input.start_day,
        input.end_day,
        edited.id,
        tripId,
        ...edited.from
      ]
    },
    ...moves.map((m) => ({ sql: SQL_UPDATE_RANGE, args: [...m.to, m.id, tripId, ...m.from] })),
    {
      sql: sqlAbortIfLayoutBroken(touched.length),
      args: [tripId, tripId, tripId, ...touched.flatMap((t) => [t.id, ...t.to]), touched.length]
    }
  ];
  let result;
  try {
    result = await ctx.db.tx(ops);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!ABORT_MESSAGE.test(message)) throw err;
    ctx.log.info("knock-on save refused", { tripId, touched: touched.length });
    return null;
  }
  return rows(result.results[0]?.rows ?? [])[0] ?? null;
}
async function deleteSegment(ctx, tripId, id) {
  const { changes } = await ctx.db.exec(SQL_DELETE, tripId, id);
  return changes > 0;
}
async function listSegmentsForTrips(ctx, tripIds) {
  if (tripIds.length === 0) return [];
  const raw = await ctx.db.query(sqlListForTrips(tripIds.length), ...tripIds);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item;
    const tripId = Number(r["trip_id"]);
    if (!Number.isInteger(tripId)) continue;
    out.push({ trip_id: tripId, name: String(r["name"] ?? "") });
  }
  return out;
}

// src/server/read-model.ts
async function withTrip(ctx, tripId, fn) {
  let trip;
  try {
    trip = await ctx.trips.getById(tripId);
  } catch {
    return null;
  }
  if (!trip) return null;
  return fn(trip);
}
async function buildOverview(ctx, tripId, trip) {
  const [days, reservations, accommodations, segmentRows] = await Promise.all([
    ctx.trips.getDays(tripId),
    ctx.trips.getReservations(tripId),
    ctx.trips.getAccommodations(tripId),
    listSegments(ctx, tripId)
  ]);
  const idx = buildDayIndex(days);
  const segments = resolveAll(segmentRows, idx).map((view) => ({
    ...view,
    counts: countsForSegment(view, days, reservations, accommodations, idx)
  }));
  const overviewDays = days.map((day, i) => ({
    id: day.id,
    pos: i + 1,
    date: day.date ?? null,
    title: day.title ?? null,
    assignmentCount: day.assignments?.length ?? 0
  }));
  const orphanBookings = usableBookings(reservations).filter((r) => reservationSpan(r, idx) === null).length;
  const orphanStays = dedupeAccommodations(accommodations).filter((a) => accommodationSpan(a, idx) === null).length;
  return {
    trip: {
      id: trip.id,
      title: trip.title ?? null,
      start_date: trip.start_date ?? null,
      end_date: trip.end_date ?? null
    },
    dayCount: idx.count,
    days: overviewDays,
    segments,
    uncovered: uncoveredRanges(segments, idx.count),
    unassigned: { bookings: orphanBookings, stays: orphanStays }
  };
}
async function buildDetail(ctx, tripId, segmentId) {
  const [days, reservations, accommodations, segmentRows] = await Promise.all([
    ctx.trips.getDays(tripId),
    ctx.trips.getReservations(tripId),
    ctx.trips.getAccommodations(tripId),
    listSegments(ctx, tripId)
  ]);
  const idx = buildDayIndex(days);
  const views = resolveAll(segmentRows, idx);
  const segment = views.find((v) => v.id === segmentId);
  if (!segment) return null;
  const detailDays = segment.effStart === null || segment.effEnd === null ? [] : days.slice(segment.effStart - 1, segment.effEnd).map((day, offset) => ({
    id: day.id,
    pos: segment.effStart + offset,
    date: day.date ?? null,
    title: day.title ?? null,
    places: (day.assignments ?? []).map((a) => ({
      name: a.place?.name ?? null,
      time: a.assignment_time ?? a.place?.place_time ?? null,
      categoryName: a.place?.category?.name ?? null,
      categoryColor: a.place?.category?.color ?? null
    })),
    notes: (day.notes_items ?? []).map((n) => ({ text: n.text, time: n.time ?? null }))
  }));
  const bookings = [];
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
      spansLegs: views.some((v) => v.id !== segment.id && spanTouches(span.lo, span.hi, v))
    });
  }
  const stays = [];
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
      bookingTitles: stay.bookingTitles
    });
  }
  return { segment, dayCount: idx.count, days: detailDays, bookings, stays };
}

// src/server/respond.ts
function json(status, body) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
var badRequest = (detail) => json(400, { error: "bad_request", detail });
var notFound = () => json(404, { error: "not_found" });
var conflict = (detail) => json(409, { error: "conflict", detail });
var unprocessable = (issues) => json(422, { error: "invalid", issues });
function guard(handler) {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      ctx.log.error("route failed", {
        path: req.path,
        method: req.method,
        message: err instanceof Error ? err.message : String(err)
      });
      return json(500, { error: "internal" });
    }
  };
}
function firstValue(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}
function queryInt(query, key) {
  const raw = firstValue(query[key]);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function bodyObject(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body === "string" && body.trim() !== "") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}
function bodyInt(body, key) {
  const raw = body[key];
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}
async function announceChange(ctx, tripId) {
  try {
    await ctx.ws.broadcastToTrip(tripId, "changed", {});
  } catch (err) {
    ctx.log.warn("broadcast failed", { tripId, message: err instanceof Error ? err.message : String(err) });
  }
}

// src/server/routes.ts
function parseSegmentInput(body) {
  const missing = [];
  const rawName = body["name"];
  if (typeof rawName !== "string") missing.push("name");
  const rawColor = body["color"];
  const rawTone = body["tone"];
  const color = rawColor === void 0 ? isTone(rawTone) ? hexForTone(rawTone) : null : normalizeHexColor(rawColor);
  if (!color) missing.push("color");
  const startDay = bodyInt(body, "start_day");
  if (startDay === null) missing.push("start_day");
  const endDay = bodyInt(body, "end_day");
  if (endDay === null) missing.push("end_day");
  return {
    input: {
      name: normalizeName(rawName),
      color: color ?? hexForTone("default"),
      start_day: startDay ?? 0,
      end_day: endDay ?? 0
    },
    missing
  };
}
function parseExpected(raw) {
  if (raw === void 0) return null;
  if (!Array.isArray(raw) || raw.length > MAX_SEGMENTS_PER_TRIP) return "invalid";
  const out = [];
  for (const item of raw) {
    const entry = bodyObject(item);
    const id = entry ? bodyInt(entry, "id") : null;
    const start = entry ? bodyInt(entry, "start_day") : null;
    const end = entry ? bodyInt(entry, "end_day") : null;
    if (id === null || start === null || end === null) return "invalid";
    out.push({ id, start_day: start, end_day: end });
  }
  return out;
}
function parseKnockOn(body) {
  const rawStart = body["resolve_start"];
  const rawEnd = body["resolve_end"];
  const expected = parseExpected(body["expect_moved"]);
  if (expected === "invalid") return { kind: "invalid", detail: "expect_moved must be a list of legs" };
  if (rawStart === void 0 && rawEnd === void 0) {
    return expected === null ? { kind: "none" } : { kind: "invalid", detail: "expect_moved needs a resolve_* field" };
  }
  if (rawStart !== void 0 && !isResolution(rawStart)) return { kind: "invalid", detail: "resolve_start is invalid" };
  if (rawEnd !== void 0 && !isResolution(rawEnd)) return { kind: "invalid", detail: "resolve_end is invalid" };
  const picks = {};
  if (rawStart !== void 0) picks.start = rawStart;
  if (rawEnd !== void 0) picks.end = rawEnd;
  return { kind: "picks", picks, expected };
}
function fieldIssues(input, dayCount) {
  return validateSegmentInput(input, { dayCount, existing: [] });
}
async function loadDayIndex(ctx, tripId) {
  return buildDayIndex(await ctx.trips.getDays(tripId));
}
async function saveWithOthers(ctx, tripId, id, input, idx, request) {
  const rows2 = await listSegments(ctx, tripId);
  const original = rows2.find((r) => r.id === id);
  if (!original) return notFound();
  const plan = planKnockOn({ id, start_day: input.start_day, end_day: input.end_day }, rows2, idx.count);
  const planned = plannedChanges(plan, request.picks);
  const others = planned.ok ? toRangeUpdates(planned.changes) : [];
  if (request.expected && (!planned.ok || !sameUpdates(others, request.expected))) {
    return conflict("the legs changed meanwhile");
  }
  if (!planned.ok) return unprocessable([`resolve_${planned.side}_unavailable`]);
  if (others.length === 0) return null;
  const issues = validateSegmentInput(input, { dayCount: idx.count, existing: rows2, editingId: id, others });
  if (issues.length > 0) return unprocessable(issues);
  const updated = await updateSegmentWithOthers(
    ctx,
    tripId,
    { id, from: [original.start_day, original.end_day], to: [input.start_day, input.end_day] },
    input,
    planned.changes
  );
  if (!updated) {
    const existing = await getSegment(ctx, tripId, id);
    return existing ? conflict("the legs changed meanwhile") : notFound();
  }
  await announceChange(ctx, tripId);
  return json(200, { segment: resolveSegment(updated, idx.count, 0, idx.dateByPos), moved: others });
}
var routes = [
  {
    method: "GET",
    path: "/overview",
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, "tripId");
      if (tripId === null) return badRequest("tripId is required");
      await ensureSchema(ctx);
      const payload = await withTrip(ctx, tripId, (trip) => buildOverview(ctx, tripId, trip));
      return payload ? json(200, payload) : notFound();
    })
  },
  {
    method: "GET",
    path: "/segment-detail",
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, "tripId");
      if (tripId === null) return badRequest("tripId is required");
      const id = queryInt(req.query, "id");
      if (id === null) return badRequest("id is required");
      await ensureSchema(ctx);
      const result = await withTrip(ctx, tripId, () => buildDetail(ctx, tripId, id));
      return result ? json(200, result) : notFound();
    })
  },
  {
    method: "POST",
    path: "/segments",
    auth: true,
    handler: guard(async (req, ctx) => {
      const body = bodyObject(req.body);
      if (!body) return badRequest("a JSON object body is required");
      const tripId = bodyInt(body, "tripId");
      if (tripId === null) return badRequest("tripId is required");
      const { input, missing } = parseSegmentInput(body);
      if (missing.length > 0) return badRequest(`missing or invalid: ${missing.join(", ")}`);
      await ensureSchema(ctx);
      const result = await withTrip(ctx, tripId, async () => {
        const idx = await loadDayIndex(ctx, tripId);
        const issues = fieldIssues(input, idx.count);
        if (issues.length > 0) return unprocessable(issues);
        const created = await insertSegmentIfFree(ctx, tripId, input);
        if (!created) {
          const total = await countSegments(ctx, tripId);
          ctx.log.info("segment insert refused", { tripId, total });
          return conflict(
            total >= MAX_SEGMENTS_PER_TRIP ? "segment limit reached" : "overlaps an existing segment"
          );
        }
        await announceChange(ctx, tripId);
        return json(200, { segment: resolveSegment(created, idx.count, 0, idx.dateByPos) });
      });
      return result ?? notFound();
    })
  },
  {
    method: "PUT",
    path: "/segments",
    auth: true,
    handler: guard(async (req, ctx) => {
      const body = bodyObject(req.body);
      if (!body) return badRequest("a JSON object body is required");
      const tripId = bodyInt(body, "tripId");
      if (tripId === null) return badRequest("tripId is required");
      const id = bodyInt(body, "id");
      if (id === null) return badRequest("id is required");
      const { input, missing } = parseSegmentInput(body);
      if (missing.length > 0) return badRequest(`missing or invalid: ${missing.join(", ")}`);
      const knockOn = parseKnockOn(body);
      if (knockOn.kind === "invalid") return badRequest(knockOn.detail);
      await ensureSchema(ctx);
      const result = await withTrip(ctx, tripId, async () => {
        const idx = await loadDayIndex(ctx, tripId);
        const issues = fieldIssues(input, idx.count);
        if (issues.length > 0) return unprocessable(issues);
        if (knockOn.kind !== "none") {
          const moved = await saveWithOthers(ctx, tripId, id, input, idx, knockOn);
          if (moved) return moved;
        }
        const updated = await updateSegmentIfFree(ctx, tripId, id, input);
        if (!updated) {
          const existing = await getSegment(ctx, tripId, id);
          return existing ? conflict("overlaps an existing segment") : notFound();
        }
        await announceChange(ctx, tripId);
        return json(200, { segment: resolveSegment(updated, idx.count, 0, idx.dateByPos) });
      });
      return result ?? notFound();
    })
  },
  {
    method: "DELETE",
    path: "/segments",
    auth: true,
    handler: guard(async (req, ctx) => {
      const tripId = queryInt(req.query, "tripId");
      if (tripId === null) return badRequest("tripId is required");
      const id = queryInt(req.query, "id");
      if (id === null) return badRequest("id is required");
      await ensureSchema(ctx);
      const result = await withTrip(ctx, tripId, async () => {
        const removed = await deleteSegment(ctx, tripId, id);
        if (!removed) return notFound();
        await announceChange(ctx, tripId);
        return json(200, { deleted: true });
      });
      return result ?? notFound();
    })
  }
];

// src/server/mcp-tools.ts
var TRIP_ID = {
  type: "integer",
  minimum: 1,
  description: "The TREK trip id. The calling user must be a member of the trip."
};
var SEGMENT_ID = {
  type: "integer",
  minimum: 1,
  description: "The segment id returned by list_trip_segments."
};
var SEGMENT_PROPERTIES = {
  name: {
    type: "string",
    minLength: 1,
    maxLength: NAME_MAX,
    description: "A short destination or leg name, such as Tokyo or Patagonia."
  },
  color: {
    type: "string",
    pattern: "^#[0-9a-fA-F]{6}$",
    description: "The segment colour as #rrggbb. Presets include #4F46E5, #10B981, #F59E0B and #EF4444."
  },
  start_day: {
    type: "integer",
    minimum: 1,
    maximum: MAX_TRIP_DAYS,
    description: "The inclusive 1-based position of the first trip day in the segment."
  },
  end_day: {
    type: "integer",
    minimum: 1,
    maximum: MAX_TRIP_DAYS,
    description: "The inclusive 1-based position of the last trip day in the segment."
  }
};
var RESOLVE_PROPERTIES = {
  resolve_end: {
    type: "string",
    enum: RESOLUTIONS,
    description: "When end_day moves. Into the next segment: push moves every later segment later by the overlap (the last one is cut at the final trip day), take shortens only the next segment. Away from a directly following segment: give extends the next segment back, pull moves every later segment earlier (the last keeps its end), gap leaves the days uncovered. Without it the behaviour is unchanged: an overlap is refused and freed days are left uncovered."
  },
  resolve_start: {
    type: "string",
    enum: RESOLUTIONS,
    description: "The same for start_day and the segments before: push moves every earlier segment earlier (the first is cut at day 1), take shortens only the previous one; give, pull and gap as for resolve_end."
  }
};
var READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
var WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};
function route(method, path) {
  const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`missing internal route ${method} ${path}`);
  return found;
}
function responseBody(response) {
  let body = response.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { data: body };
    }
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body : { data: body ?? null };
}
function refusal(path, status, payload) {
  const issues = Array.isArray(payload["issues"]) ? ` (${payload["issues"].join(", ")})` : "";
  const detail = typeof payload["detail"] === "string" ? `: ${payload["detail"]}` : "";
  const what = STATUS_TEXT[status] ?? "failed";
  return new Error(`${path} ${what} [${status}]${detail}${issues}`);
}
var STATUS_TEXT = {
  400: "rejected a malformed request",
  404: "found no such trip or segment visible to this user",
  409: "conflicts with the current segments; list them again and retry",
  422: "rejected invalid values",
  500: "failed inside the plugin"
};
async function invoke(method, path, input, ctx) {
  const query = {};
  if (method === "GET" || method === "DELETE") {
    for (const [key, value] of Object.entries(input)) query[key] = String(value);
  }
  const request = {
    method,
    path,
    query,
    body: method === "GET" || method === "DELETE" ? null : input,
    headers: {},
    // Authentication has already happened at the MCP boundary. The acting
    // user is carried by ctx, which is what ctx.trips uses for membership.
    user: null
  };
  const response = await route(method, path).handler(request, ctx);
  const payload = responseBody(response);
  if (response.status < 200 || response.status >= 300) throw refusal(`${method} ${path}`, response.status, payload);
  return { ok: true, ...payload };
}
var mcpTools = [
  {
    name: "list_trip_segments",
    description: "List a trip\u2019s segments and its ordered days. Use before creating or changing a segment to choose valid, non-overlapping day positions.",
    inputSchema: {
      type: "object",
      properties: { tripId: TRIP_ID },
      required: ["tripId"],
      additionalProperties: false
    },
    annotations: READ_ANNOTATIONS,
    handler: (input, ctx) => invoke("GET", "/overview", input, ctx)
  },
  {
    name: "get_trip_segment",
    description: "Get one trip segment with the days, bookings and accommodation stays that fall within it.",
    inputSchema: {
      type: "object",
      properties: { tripId: TRIP_ID, id: SEGMENT_ID },
      required: ["tripId", "id"],
      additionalProperties: false
    },
    annotations: READ_ANNOTATIONS,
    handler: (input, ctx) => invoke("GET", "/segment-detail", input, ctx)
  },
  {
    name: "create_trip_segment",
    description: "Create a non-overlapping segment over an inclusive range of trip-day positions. Call list_trip_segments first.",
    inputSchema: {
      type: "object",
      properties: { tripId: TRIP_ID, ...SEGMENT_PROPERTIES },
      required: ["tripId", "name", "color", "start_day", "end_day"],
      additionalProperties: false
    },
    annotations: WRITE_ANNOTATIONS,
    handler: (input, ctx) => invoke("POST", "/segments", input, ctx)
  },
  {
    name: "update_trip_segment",
    description: "Replace the name, colour and inclusive day range of an existing trip segment. All editable fields are required. Pass resolve_end or resolve_start to move neighbouring segments in the same atomic save; without them an overlap is refused as before.",
    inputSchema: {
      type: "object",
      properties: { tripId: TRIP_ID, id: SEGMENT_ID, ...SEGMENT_PROPERTIES, ...RESOLVE_PROPERTIES },
      required: ["tripId", "id", "name", "color", "start_day", "end_day"],
      additionalProperties: false
    },
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    handler: (input, ctx) => invoke("PUT", "/segments", input, ctx)
  },
  {
    name: "delete_trip_segment",
    description: "Permanently delete one segment. This only removes the segment; it does not delete trip days, bookings or stays.",
    inputSchema: {
      type: "object",
      properties: { tripId: TRIP_ID, id: SEGMENT_ID },
      required: ["tripId", "id"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    handler: (input, ctx) => invoke("DELETE", "/segments", input, ctx)
  }
];
var mcpToolProvider = {
  tools: mcpTools.map((tool) => tool.name),
  async callTool(call, ctx) {
    const tool = mcpTools.find((candidate) => candidate.name === call.name);
    if (!tool) throw new Error(`unknown tool ${call.name}`);
    const args = call.args;
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    return tool.handler(input, ctx);
  }
};

// src/server/hooks/day-schedule.ts
function liveSegments(views) {
  const out = [];
  for (const view of views) {
    if (view.effStart === null || view.effEnd === null) continue;
    out.push({ view, start: view.effStart, end: view.effEnd });
  }
  return out;
}
function buildItems(views, idx) {
  const live = liveSegments(views);
  const total = live.length;
  const items = [];
  live.forEach(({ view, start }, i) => {
    if (items.length >= DAY_SCHEDULE_MAX_ITEMS) return;
    const dayId = idx.dayIdByPos[start - 1];
    if (dayId === void 0) return;
    items.push({
      id: `seg-${view.id}-start`,
      dayId,
      position: "start",
      tone: view.tone,
      label: `${safeLabel(view.name, view.index)} begins - leg ${i + 1} of ${total}, ${plural(view.effLength, "day", "days")}`
    });
  });
  live.forEach(({ view, start, end }) => {
    if (items.length >= DAY_SCHEDULE_MAX_ITEMS) return;
    if (end === start) return;
    const dayId = idx.dayIdByPos[end - 1];
    if (dayId === void 0) return;
    items.push({
      id: `seg-${view.id}-end`,
      dayId,
      position: "end",
      tone: view.tone,
      label: `${safeLabel(view.name, view.index)} ends`
    });
  });
  return items;
}
async function getSchedule(tripId, ctx) {
  try {
    await ensureSchema(ctx);
    const rows2 = await listSegments(ctx, tripId);
    if (rows2.length === 0) return [];
    const idx = buildDayIndex(await ctx.trips.getDays(tripId));
    return buildItems(resolveAll(rows2, idx), idx);
  } catch (err) {
    ctx.log.warn("dayScheduleProvider failed", {
      tripId,
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/shared/types.ts
var DEFAULT_TINT_MODE = "header-badge";
function coerceTintMode(value) {
  return value === "full-day" || value === "header-badge" || value === "badge-only" || value === "off" ? value : DEFAULT_TINT_MODE;
}

// src/server/hooks/day-tint.ts
function buildTints(views, idx, mode = DEFAULT_TINT_MODE) {
  if (mode === "off") return [];
  const out = [];
  for (const view of views) {
    if (view.effStart === null || view.effEnd === null) continue;
    const label = safeLabel(view.name, view.index).slice(0, 60);
    for (let pos = view.effStart; pos <= view.effEnd; pos++) {
      if (out.length >= DAY_TINT_MAX) return out;
      const dayId = idx.dayIdByPos[pos - 1];
      if (dayId === void 0) continue;
      out.push(
        mode === "full-day" ? { dayId, color: view.color, label } : mode === "badge-only" ? { dayId, badgeColor: view.color, label } : { dayId, headerColor: view.color, badgeColor: view.color, label }
      );
    }
  }
  return out;
}
async function readTintMode(ctx) {
  try {
    return coerceTintMode(await ctx.settings?.get("tintMode"));
  } catch {
    return DEFAULT_TINT_MODE;
  }
}
async function getDayTints(tripId, ctx) {
  try {
    await ensureSchema(ctx);
    const rows2 = await listSegments(ctx, tripId);
    if (rows2.length === 0) return [];
    const mode = await readTintMode(ctx);
    if (mode === "off") return [];
    const idx = buildDayIndex(await ctx.trips.getDays(tripId));
    return buildTints(resolveAll(rows2, idx), idx, mode);
  } catch (err) {
    ctx.log.warn("dayTintProvider failed", {
      tripId,
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/server/geometry.ts
function isFiniteLatLng(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
function cleanPath(raw) {
  const out = [];
  for (const [lat, lng] of raw) {
    if (!isFiniteLatLng(lat, lng)) continue;
    const point = [lat, lng];
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push(point);
  }
  return out;
}
function decimate(points, max) {
  if (max <= 0) return [];
  if (points.length <= max) return [...points];
  if (max === 1) return [points[0]];
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
function allocateBudget(counts, total, perFeature) {
  const capped = counts.map((c) => Math.max(0, Math.min(c, perFeature)));
  const sum = capped.reduce((a, b) => a + b, 0);
  if (sum <= total) return capped;
  const out = capped.map((c) => c === 0 ? 0 : Math.max(2, Math.floor(c * total / sum)));
  let used = out.reduce((a, b) => a + b, 0);
  while (used > total) {
    let largest = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > 2 && (largest < 0 || out[i] > out[largest])) largest = i;
    }
    if (largest < 0) break;
    out[largest] -= 1;
    used -= 1;
  }
  for (let i = out.length - 1; i >= 0 && used > total; i--) {
    used -= out[i];
    out[i] = 0;
  }
  return out.map((v, i) => Math.min(v, capped[i]));
}

// src/server/hooks/map-layer.ts
function legPoints(days, start, end) {
  const raw = [];
  for (let pos = start; pos <= end; pos++) {
    const day = days[pos - 1];
    if (!day) continue;
    for (const assignment of day.assignments ?? []) {
      raw.push([assignment.place?.lat, assignment.place?.lng]);
    }
  }
  return raw;
}
function buildFeatures(views, days) {
  const live = [];
  for (const view of views) {
    if (view.effStart === null || view.effEnd === null) continue;
    live.push({ view, path: cleanPath(legPoints(days, view.effStart, view.effEnd)) });
  }
  const allowance = allocateBudget(
    live.map((l) => l.path.length),
    MAP_POLYLINE_VERTEX_BUDGET,
    MAP_FEATURE_VERTEX_MAX
  );
  const features = [];
  live.forEach(({ view, path }, i) => {
    const label = safeLabel(view.name, view.index).slice(0, 80);
    const points = decimate(path, allowance[i] ?? 0);
    if (points.length >= 2) {
      features.push({
        type: "polyline",
        points,
        tone: view.tone,
        width: MAP_POLYLINE_WIDTH,
        opacity: MAP_POLYLINE_OPACITY,
        dash: "solid",
        label
      });
      return;
    }
    const only = path[0];
    if (only) {
      features.push({
        type: "circle",
        center: only,
        radiusM: MAP_CIRCLE_RADIUS_M,
        tone: view.tone,
        opacity: MAP_POLYLINE_OPACITY,
        fill: true,
        label
      });
    }
  });
  return features;
}
async function getLayers(tripId, ctx) {
  try {
    await ensureSchema(ctx);
    const rows2 = await listSegments(ctx, tripId);
    if (rows2.length === 0) return [];
    const days = await ctx.trips.getDays(tripId);
    const features = buildFeatures(resolveAll(rows2, buildDayIndex(days)), days);
    if (features.length === 0) return [];
    return [{ id: "segments", name: "Trip segments", features }];
  } catch (err) {
    ctx.log.warn("mapLayerProvider failed", {
      tripId,
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/server/hooks/pdf-section.ts
function buildSections(views, dayCount, counts) {
  if (views.length === 0) return [];
  const covered = coveredDayCount(views, dayCount);
  const gaps = uncoveredRanges(views, dayCount);
  const drifted = views.filter((v) => v.status !== "ok");
  const paragraphs = [
    `This trip is split into ${plural(views.length, "leg", "legs")}, covering ${covered} of ${plural(dayCount, "day", "days")}.`
  ];
  if (gaps.length > 0) {
    paragraphs.push(`Days not in any leg: ${rangesToText(gaps)}.`);
  }
  if (drifted.length > 0) {
    paragraphs.push(
      `${plural(drifted.length, "leg", "legs")} no longer fit the trip's current length and are shown shortened or omitted.`
    );
  }
  const rows2 = views.slice(0, PDF_MAX_ROWS).map((view) => {
    const c = counts.get(view.id) ?? { places: 0, stays: 0, bookings: 0 };
    const days = view.effStart === null || view.effEnd === null ? "not in this trip" : dayRangeLabel(view.effStart, view.effEnd).replace("Day ", "");
    return [
      safeLabel(view.name, view.index),
      days,
      dateRangeLabel(view.startDate, view.endDate) ?? "-",
      String(c.places),
      String(c.stays),
      String(c.bookings)
    ];
  });
  return [
    {
      title: "Trip segments",
      paragraphs,
      table: {
        headers: ["Leg", "Days", "Dates", "Places", "Stays", "Bookings"],
        rows: rows2
      }
    }
  ];
}
async function getSections(tripId, ctx) {
  try {
    await ensureSchema(ctx);
    const rows2 = await listSegments(ctx, tripId);
    if (rows2.length === 0) return [];
    const [days, reservations, accommodations] = await Promise.all([
      ctx.trips.getDays(tripId),
      ctx.trips.getReservations(tripId),
      ctx.trips.getAccommodations(tripId)
    ]);
    const idx = buildDayIndex(days);
    const views = resolveAll(rows2, idx);
    const counts = new Map(views.map((v) => [v.id, countsForSegment(v, days, reservations, accommodations, idx)]));
    return buildSections(views, idx.count, counts);
  } catch (err) {
    ctx.log.warn("pdfSectionProvider failed", {
      tripId,
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/server/hooks/trip-card.ts
function buildCards(rows2) {
  const namesByTrip = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const names = namesByTrip.get(row.trip_id);
    if (names) names.push(row.name);
    else namesByTrip.set(row.trip_id, [row.name]);
  }
  const cards = [];
  for (const [tripId, names] of namesByTrip) {
    const preview = names.slice(0, TRIP_CARD_NAME_PREVIEW).map((n, i) => safeLabel(n, i));
    const extra = names.length - preview.length;
    cards.push({
      tripId,
      id: "segments",
      label: plural(names.length, "leg", "legs"),
      value: (preview.join(", ") + (extra > 0 ? ` +${extra}` : "")).slice(0, 256),
      icon: "Route",
      tone: "default"
    });
  }
  return cards;
}
async function getCards(tripIds, ctx) {
  try {
    if (!Array.isArray(tripIds) || tripIds.length === 0) return [];
    const ids = tripIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, TRIP_CARD_MAX_TRIPS);
    if (ids.length === 0) return [];
    await ensureSchema(ctx);
    return buildCards(await listSegmentsForTrips(ctx, ids));
  } catch (err) {
    ctx.log.warn("tripCardProvider failed", {
      count: tripIds?.length ?? 0,
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

// src/server/index.ts
var plugin = {
  async onLoad(ctx) {
    await ensureSchema(ctx);
    ctx.log.info("trip-segments loaded");
  },
  routes,
  /**
   * Each of these needs its matching permission in trek-plugin.json.
   * Without it the plugin still installs and activates, and the hook is simply
   * never called — no error, no log, nothing. test/plugin.test.ts asserts the
   * two lists agree, with no exceptions.
   */
  hooks: {
    dayScheduleProvider: { getSchedule },
    dayTintProvider: { getDayTints },
    mapLayerProvider: { getLayers },
    pdfSectionProvider: { getSections },
    tripCardProvider: { getCards },
    mcpToolProvider
  }
};
var index_default = plugin;
