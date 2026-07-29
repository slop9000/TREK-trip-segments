import type { DayRange } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Monday-first weekday initials, matching the calendar grid. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** `April 2026`. */
export function monthLabel(year: number, month1: number): string {
  return `${MONTHS_LONG[month1 - 1] ?? ''} ${year}`;
}

/**
 * Weekday index with MONDAY as 0.
 *
 * Built through Date.UTC deliberately: `new Date('2026-04-12')` is parsed as UTC
 * midnight and then read back in local time, which lands on the previous day for
 * anyone west of Greenwich and would shift the whole grid by a column.
 */
export function mondayIndex(year: number, month1: number, day: number): number {
  return (new Date(Date.UTC(year, month1 - 1, day)).getUTCDay() + 6) % 7;
}

/** Days in a month, without tripping over leap years. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Split `2026-04-12` into parts, or null when absent/malformed. */
export function dateParts(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

const EN_DASH = '–';
const MIDDLE_DOT = '·';

/**
 * `2026-04-12` -> `Apr 12`. Parsed by string rather than through `new Date()`:
 * a bare ISO date is interpreted as UTC midnight and then rendered in local
 * time, which shifts the day backwards for anyone west of Greenwich.
 */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

/** `Day 3` or `Day 3–7`. */
export function dayRangeLabel(from: number, to: number): string {
  return from === to ? `Day ${from}` : `Day ${from}${EN_DASH}${to}`;
}

/** `Apr 12 – Apr 16`, `Apr 12`, or null when the trip has no dates yet. */
export function dateRangeLabel(from: string | null, to: string | null): string | null {
  const a = shortDate(from);
  const b = shortDate(to);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b || a === b) return a;
  return `${a} ${EN_DASH} ${b}`;
}

/** `Day 3–7 · Apr 12 – Apr 16`, collapsing gracefully when dates are missing. */
export function segmentRangeLabel(from: number, to: number, fromDate: string | null, toDate: string | null): string {
  const dates = dateRangeLabel(fromDate, toDate);
  return dates ? `${dayRangeLabel(from, to)} ${MIDDLE_DOT} ${dates}` : dayRangeLabel(from, to);
}

/** `12–14, 60, 71–90` — run-length text for a set of day ranges. */
export function rangesToText(ranges: readonly DayRange[]): string {
  return ranges.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}${EN_DASH}${hi}`)).join(', ');
}

export function totalDays(ranges: readonly DayRange[]): number {
  return ranges.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
}

/** A stay covering positions 1..5 is four nights. */
export function nightsBetween(lo: number, hi: number): number {
  return Math.max(0, hi - lo);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every host-rendered string is emoji-stripped, and an item whose label becomes
 * empty is DROPPED entirely (day-schedule.controller.ts:57). A leg named only
 * with a flag emoji would therefore vanish from the day plan with no warning, so
 * hooks route names through here first.
 */
export function safeLabel(name: string, index: number): string {
  const stripped = stripEmojiLike(name).trim().slice(0, 60);
  return stripped.length > 0 ? stripped : `Leg ${index + 1}`;
}

/**
 * Variation selectors, ZWJ and the keycap combiner. Listed by code point so no
 * invisible characters end up in this source file.
 */
const INVISIBLE_CODE_POINTS = new Set([0xfe0e, 0xfe0f, 0x200d, 0x20e3, 0x200b]);

/** Mirrors the host's stripEmoji closely enough to predict an empty result. */
export function stripEmojiLike(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!INVISIBLE_CODE_POINTS.has(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out
    .replace(/[\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '')
    .replace(/[ \t]+/g, ' ');
}
