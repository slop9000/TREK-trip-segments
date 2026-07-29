import { isTone } from './palette';
import { MAX_SEGMENTS_PER_TRIP, MAX_TRIP_DAYS, NAME_MAX } from './limits';
import type { SegmentInput, SegmentRow } from './types';

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
  | 'tone_invalid'
  | 'range_invalid'
  | 'range_out_of_bounds'
  | 'overlap'
  | 'limit_reached';

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
}

export function validateSegmentInput(input: SegmentInput, opts: ValidateOptions): IssueCode[] {
  const issues: IssueCode[] = [];

  const name = normalizeName(input.name);
  if (name.length === 0) issues.push('name_required');
  else if (name.length > NAME_MAX) issues.push('name_too_long');

  if (!isTone(input.tone)) issues.push('tone_invalid');

  const start = input.start_day;
  const end = input.end_day;
  const rangeWellFormed =
    Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= MAX_TRIP_DAYS;

  if (!rangeWellFormed) {
    issues.push('range_invalid');
  } else if (end > opts.dayCount) {
    // Drift is tolerated after the fact (a shortened trip clips a leg), but
    // creating one that already points past the end is just a mistake.
    issues.push('range_out_of_bounds');
  } else if (findOverlap({ start_day: start, end_day: end }, opts.existing, opts.editingId)) {
    issues.push('overlap');
  }

  if (opts.editingId === undefined && opts.existing.length >= MAX_SEGMENTS_PER_TRIP) {
    issues.push('limit_reached');
  }

  return issues;
}
