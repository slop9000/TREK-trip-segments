import { isHexColor } from './palette';
import { MAX_SEGMENTS_PER_TRIP, MAX_TRIP_DAYS, NAME_MAX } from './limits';
import type { RangeUpdate, SegmentInput, SegmentRow } from './types';

/**
 * One validator, run in BOTH places.
 *
 * The client runs it before enabling the save button, because the iframe bridge
 * throws away a plugin's response body and forwards only the HTTP status code
 * (PluginFrame.tsx:368) — so a precise server-side message can never reach the
 * user. The server runs it again as a backstop, since a route is reachable
 * without our UI.
 */
export type IssueCode =
  | 'name_required'
  | 'name_too_long'
  | 'color_invalid'
  | 'range_invalid'
  | 'range_out_of_bounds'
  | 'overlap'
  | 'limit_reached'
  | 'others_invalid';

/** C0 controls and DEL, tested by code point so no literal ones live in this file. */
function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

/** Collapse whitespace and strip control characters. */
export function normalizeName(raw: unknown): string {
  let out = '';
  for (const ch of String(raw ?? '')) {
    out += isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Inclusive ranges overlap when each starts on or before the other ends. */
export function rangesOverlap(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return aLo <= bHi && aHi >= bLo;
}

/**
 * The first stored segment this range collides with, ignoring the row being
 * edited. Adjacency (`a.end + 1 === b.start`) is deliberately allowed — legs
 * usually butt up against each other.
 */
export function findOverlap(
  input: Pick<SegmentInput, 'start_day' | 'end_day'>,
  existing: readonly SegmentRow[],
  editingId?: number,
): SegmentRow | null {
  for (const row of existing) {
    if (editingId !== undefined && row.id === editingId) continue;
    if (rangesOverlap(input.start_day, input.end_day, row.start_day, row.end_day)) return row;
  }
  return null;
}

export interface ValidateOptions {
  dayCount: number;
  existing: readonly SegmentRow[];
  /** Set when editing, so the row does not collide with itself or count toward the limit. */
  editingId?: number;
  /**
   * New ranges for OTHER legs, saved together with this one (see knock-on.ts).
   * The input is then checked against the trip as it will be AFTER the save,
   * and the moved legs themselves must still fit and not collide with anything.
   */
  others?: readonly RangeUpdate[];
}

/** Integers, at least one day long, inside the hard cap. Says nothing about the trip's length. */
function wellFormedRange(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= MAX_TRIP_DAYS;
}

/** The stored rows with the other legs' new ranges swapped in. */
export function applyRangeUpdates(existing: readonly SegmentRow[], others: readonly RangeUpdate[]): SegmentRow[] {
  const byId = new Map(others.map((u) => [u.id, u]));
  return existing.map((row) => {
    const update = byId.get(row.id);
    return update ? { ...row, start_day: update.start_day, end_day: update.end_day } : row;
  });
}

/**
 * Whether the other legs' new ranges are acceptable as a whole: each names a
 * distinct, existing leg other than the one being edited, lies inside the trip,
 * and collides with no other leg once every update is applied.
 *
 * Only legs that move are bounds-checked. A leg left alone may already run past
 * the end of a trip that lost days, and that is tolerated drift, not something
 * this save introduced.
 */
function othersFit(
  others: readonly RangeUpdate[],
  existing: readonly SegmentRow[],
  dayCount: number,
  editingId: number | undefined,
): boolean {
  const ids = new Set<number>();
  for (const u of others) {
    if (ids.has(u.id) || u.id === editingId || !existing.some((r) => r.id === u.id)) return false;
    ids.add(u.id);
    if (!wellFormedRange(u.start_day, u.end_day) || u.end_day > dayCount) return false;
  }

  const world = applyRangeUpdates(existing, others).filter((r) => r.id !== editingId);
  for (const moved of world) {
    if (!ids.has(moved.id)) continue;
    if (findOverlap(moved, world, moved.id)) return false;
  }
  return true;
}

export function validateSegmentInput(input: SegmentInput, opts: ValidateOptions): IssueCode[] {
  const issues: IssueCode[] = [];

  const name = normalizeName(input.name);
  if (name.length === 0) issues.push('name_required');
  else if (name.length > NAME_MAX) issues.push('name_too_long');

  if (!isHexColor(input.color)) issues.push('color_invalid');

  const start = input.start_day;
  const end = input.end_day;
  const others = opts.others ?? [];
  const world = others.length > 0 ? applyRangeUpdates(opts.existing, others) : opts.existing;

  if (!wellFormedRange(start, end)) {
    issues.push('range_invalid');
  } else if (end > opts.dayCount) {
    // Drift is tolerated after the fact (a shortened trip clips a leg), but
    // creating one that already points past the end is just a mistake.
    issues.push('range_out_of_bounds');
  } else if (findOverlap({ start_day: start, end_day: end }, world, opts.editingId)) {
    issues.push('overlap');
  }

  if (others.length > 0 && !othersFit(others, opts.existing, opts.dayCount, opts.editingId)) {
    issues.push('others_invalid');
  }

  if (opts.editingId === undefined && opts.existing.length >= MAX_SEGMENTS_PER_TRIP) {
    issues.push('limit_reached');
  }

  return issues;
}
