import type { DayRange, RangeUpdate, SegmentRow } from './types';

/**
 * Knock-on planning: what happens to the OTHER legs when one leg's range is
 * edited so that it runs into a neighbour, or gives back days a neighbour could
 * take.
 *
 * Without this, making one leg longer means editing every later leg first, by
 * hand, from the far end of the trip backwards — the overlap guard refuses any
 * other order. The planner works out each sensible way to make room, and the
 * exact range every affected leg ends up with, so the editor can show the
 * choice and the server can apply it in one transaction.
 *
 * Pure and position-based, like everything else in `src/shared/`: it runs in
 * the editor while the user picks days, and again on the server, which plans
 * from its own fresh rows. The editor only sends which option was picked; the
 * ranges are always the server's.
 *
 * The two ends of the edited leg are handled independently and symmetrically.
 * Only legs AFTER the leg's original range can be touched by a change of its
 * last day, and only legs BEFORE it by a change of its first day, so the two
 * sides never fight over a leg and their changes can simply be combined.
 */

/** Which end of the edited leg moved. */
export type KnockOnSide = 'start' | 'end';

/**
 * What to do about it.
 *
 * Growing into a neighbour:
 *   `push` — every leg on that side moves out of the way by the overlap, the
 *            outermost one is cut at the trip's edge;
 *   `take` — only the neighbour gives the days up.
 * Shrinking away from a neighbour that followed directly:
 *   `give` — the neighbour takes the freed days;
 *   `pull` — every leg on that side moves in by the freed days, the outermost
 *            one keeps its far edge and so grows;
 *   `gap`  — nothing else changes.
 */
export type Resolution = 'push' | 'take' | 'give' | 'pull' | 'gap';

export const RESOLUTIONS: readonly Resolution[] = ['push', 'take', 'give', 'pull', 'gap'];

export function isResolution(value: unknown): value is Resolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value);
}

/** One other leg's range before and after an option is applied. */
export interface RangeChange {
  id: number;
  name: string;
  color: string;
  from: DayRange;
  to: DayRange;
}

export interface KnockOnOption {
  resolution: Resolution;
  /** Exactly the other legs this option changes, in day order. Empty for `gap`. */
  changes: RangeChange[];
  /**
   * Set when the option would leave a leg with no days at all, which is never
   * done silently: a leg the user did not touch must not disappear. Names the
   * first such leg so the editor can say which one.
   */
  blockedBy: { id: number; name: string } | null;
  /**
   * Set when an earlier option has exactly the same outcome. With a single leg
   * on that side, "pull" always equals "give", and "push" equals "take" when
   * the neighbour already reaches the trip's edge. The editor hides these so
   * the user is not left looking for a difference; an API caller that names
   * one still gets it, since the result is the same.
   */
  sameAs: Resolution | null;
}

export interface KnockOnChoice {
  side: KnockOnSide;
  /** `grow` runs into the neighbour; `shrink` frees days next to it. */
  kind: 'grow' | 'shrink';
  /**
   * Days of overlap with other legs (grow) or days that were in this leg and no
   * longer are (shrink). Always at least 1.
   */
  days: number;
  /** Exactly those days, for the editor to name. */
  span: DayRange;
  /**
   * How far `push` or `pull` moves the legs on this side. Usually `days`; more
   * when the leg jumped INTO its neighbour, because the neighbour then has to
   * clear the whole new range, not just the days it shares with it.
   */
  shift: number;
  /** The leg directly next to the edited one on this side, in its current range. */
  neighbour: { id: number; name: string; color: string; range: DayRange };
  /** In display order, the default first. */
  options: KnockOnOption[];
  /** The first option that is not blocked, or null when every one is. */
  recommended: Resolution | null;
}

export interface KnockOnPlan {
  /** In the order the editor shows them: the first day before the last. */
  choices: KnockOnChoice[];
}

/** The edited leg as it will be saved. Only the range matters here. */
export interface EditedRange {
  id: number;
  start_day: number;
  end_day: number;
}

type Leg = Pick<SegmentRow, 'id' | 'name' | 'color' | 'start_day' | 'end_day'>;

/** A per-side pick. A side the plan has no choice for is ignored. */
export type KnockOnPicks = Partial<Record<KnockOnSide, Resolution>>;

/**
 * What the editor sends with a save that raised a choice: the picks, and the
 * other legs' ranges it showed for them. The server plans the picks again from
 * its own rows and refuses the save when the result differs — the user agreed
 * to those exact changes, not to whatever the picks mean by now.
 */
export interface KnockOnSave {
  picks: KnockOnPicks;
  expected: RangeUpdate[];
}

/** Whether two sets of range updates are the same, ignoring order. */
export function sameUpdates(a: readonly RangeUpdate[], b: readonly RangeUpdate[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((u) => b.some((v) => v.id === u.id && v.start_day === u.start_day && v.end_day === u.end_day));
}

function byPosition(a: Leg, b: Leg): number {
  return a.start_day - b.start_day || a.id - b.id;
}

/** Changes in day order, by where each leg was. */
function byFrom(a: RangeChange, b: RangeChange): number {
  return a.from[0] - b.from[0] || a.id - b.id;
}

/**
 * Builds an option from a function that maps each affected leg to its new
 * range. A leg is "gone" when the new range has no day inside the trip, and the
 * option is then blocked by the first such leg in the direction of travel.
 *
 * A leg that moves never keeps a last day past the end of the trip: whatever
 * moved it is cut at the trip's last day, as a push is. Moved legs are
 * bounds-checked when saved, and a stored range nobody can see is not worth
 * preserving — it would only make every save of the option fail.
 */
function option(
  resolution: Resolution,
  legs: readonly Leg[],
  dayCount: number,
  next: (leg: Leg, i: number) => DayRange,
): KnockOnOption {
  const changes: RangeChange[] = [];
  let blockedBy: KnockOnOption['blockedBy'] = null;

  legs.forEach((leg, i) => {
    const raw = next(leg, i);
    const moved = raw[0] !== leg.start_day || raw[1] !== leg.end_day;
    const to: DayRange = moved ? [raw[0], Math.min(raw[1], dayCount)] : raw;
    const gone = to[1] < to[0] || to[1] < 1 || to[0] > dayCount;
    if (gone && !blockedBy) blockedBy = { id: leg.id, name: leg.name };
    if (moved) {
      changes.push({ id: leg.id, name: leg.name, color: leg.color, from: [leg.start_day, leg.end_day], to });
    }
  });

  changes.sort(byFrom);
  return { resolution, changes, blockedBy, sameAs: null };
}

function choice(
  side: KnockOnSide,
  kind: KnockOnChoice['kind'],
  span: DayRange,
  shift: number,
  neighbour: Leg,
  options: KnockOnOption[],
): KnockOnChoice {
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
      range: [neighbour.start_day, neighbour.end_day],
    },
    options,
    recommended: options.find((o) => !o.blockedBy)?.resolution ?? null,
  };
}

function sameChanges(a: readonly RangeChange[], b: readonly RangeChange[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.id === b[i]?.id && c.to[0] === b[i]?.to[0] && c.to[1] === b[i]?.to[1])
  );
}

/**
 * The last day moved. `later` are the legs after the leg's ORIGINAL range, in
 * day order, so index 0 is the neighbour and the last one ends the trip.
 */
function planEnd(old: DayRange, edited: DayRange, later: readonly Leg[], dayCount: number): KnockOnChoice | null {
  const [oldStart, oldEnd] = old;
  const [newStart, newEnd] = edited;
  if (later.length === 0) return null;

  // The legs still in the way: a leg the new range has jumped clean over ends
  // up before it and is left where it is.
  const inWay = later.filter((leg) => leg.end_day >= newStart);
  const hit = inWay[0];
  if (newEnd > oldEnd && hit && hit.start_day <= newEnd) {
    // A gap before the first leg in the way is used up first, so pushing moves
    // the legs just far enough for that one to start after the new last day.
    const d = newEnd - hit.start_day + 1;
    const lastHit = Math.max(...inWay.filter((leg) => leg.start_day <= newEnd).map((leg) => leg.end_day));
    const span: DayRange = [Math.max(newStart, hit.start_day), Math.min(newEnd, lastHit)];
    return choice('end', 'grow', span, d, hit, [
      option('push', inWay, dayCount, (leg) => [leg.start_day + d, leg.end_day + d]),
      option('take', [hit], dayCount, (leg) => [newEnd + 1, leg.end_day]),
    ]);
  }

  const next = later[0]!;
  // Shrinking offers a choice only when the freed days were covered right up to
  // the neighbour. With a gap already in between, "give" would leave a hole
  // anyway and "pull" would close a gap the user never asked to close.
  //
  // Freed means "was in this leg": when the whole leg moved earlier, past its
  // own first day, the days between the new and the old range never belonged
  // to it, and handing them to the neighbour would stretch it across a gap.
  if (newEnd < oldEnd && next.start_day === oldEnd + 1) {
    const freedFrom = Math.max(newEnd + 1, oldStart);
    const d = oldEnd - freedFrom + 1;
    const last = later.length - 1;
    return choice('end', 'shrink', [freedFrom, oldEnd], d, next, [
      option('give', [next], dayCount, (leg) => [freedFrom, leg.end_day]),
      option('pull', later, dayCount, (leg, i) => [leg.start_day - d, i === last ? leg.end_day : leg.end_day - d]),
      option('gap', [], dayCount, (leg) => [leg.start_day, leg.end_day]),
    ]);
  }

  return null;
}

/**
 * The mirror image for the first day. `earlier` are the legs before the leg's
 * original range, NEAREST FIRST, so index 0 is the neighbour and the last one
 * is the leg that starts the trip.
 *
 * Growing into the previous leg recommends `take` rather than `push`: starting
 * a leg earlier almost always means leaving the place before it sooner, while
 * moving every earlier leg forward in time would rewrite the start of the trip.
 */
function planStart(old: DayRange, edited: DayRange, earlier: readonly Leg[], dayCount: number): KnockOnChoice | null {
  const [oldStart, oldEnd] = old;
  const [newStart, newEnd] = edited;
  if (earlier.length === 0) return null;

  const inWay = earlier.filter((leg) => leg.start_day <= newEnd);
  const hit = inWay[0];
  if (newStart < oldStart && hit && hit.end_day >= newStart) {
    const d = hit.end_day - newStart + 1;
    const firstHit = Math.min(...inWay.filter((leg) => leg.end_day >= newStart).map((leg) => leg.start_day));
    const span: DayRange = [Math.max(newStart, firstHit), Math.min(newEnd, hit.end_day)];
    return choice('start', 'grow', span, d, hit, [
      option('take', [hit], dayCount, (leg) => [leg.start_day, newStart - 1]),
      option('push', inWay, dayCount, (leg) => [Math.max(leg.start_day - d, 1), leg.end_day - d]),
    ]);
  }

  const prev = earlier[0]!;
  if (newStart > oldStart && prev.end_day === oldStart - 1) {
    const freedTo = Math.min(newStart - 1, oldEnd);
    const d = freedTo - oldStart + 1;
    const first = earlier.length - 1;
    return choice('start', 'shrink', [oldStart, freedTo], d, prev, [
      option('give', [prev], dayCount, (leg) => [leg.start_day, freedTo]),
      option('pull', earlier, dayCount, (leg, i) => [i === first ? leg.start_day : leg.start_day + d, leg.end_day + d]),
      option('gap', [], dayCount, (leg) => [leg.start_day, leg.end_day]),
    ]);
  }

  return null;
}

/**
 * Every choice an edit raises, or none.
 *
 * `rows` is the trip's current legs, including the one being edited (found by
 * id) in its stored range. A new leg has no original range to push away from,
 * so creating one never raises a choice: an overlap there stays an error.
 */
export function planKnockOn(edited: EditedRange, rows: readonly Leg[], dayCount: number): KnockOnPlan {
  const original = rows.find((r) => r.id === edited.id);
  if (!original) return { choices: [] };

  const others = rows.filter((r) => r.id !== edited.id).sort(byPosition);
  // A leg that already starts past the end of the trip has no days to move, and
  // an edit that passes validation ends inside the trip, so it can never run
  // into one. Leaving those legs out keeps them from blocking every option.
  const inTrip = others.filter((r) => r.start_day <= dayCount);
  const later = inTrip.filter((r) => r.start_day > original.end_day);
  const earlier = inTrip.filter((r) => r.end_day < original.start_day).reverse();

  const old: DayRange = [original.start_day, original.end_day];
  const range: DayRange = [edited.start_day, edited.end_day];
  const choices: KnockOnChoice[] = [];
  const start = planStart(old, range, earlier, dayCount);
  if (start) choices.push(start);
  const end = planEnd(old, range, later, dayCount);
  if (end) choices.push(end);
  return { choices };
}

/**
 * The picked option for one choice: the explicit pick when it is offered and
 * not blocked, otherwise the recommendation. Null when nothing is usable.
 */
export function pickedOption(c: KnockOnChoice, pick: Resolution | undefined): KnockOnOption | null {
  const wanted = c.options.find((o) => o.resolution === pick && !o.blockedBy);
  if (wanted) return wanted;
  return c.options.find((o) => o.resolution === c.recommended) ?? null;
}

/** What the update route writes for the other legs. */
export function toRangeUpdates(changes: readonly RangeChange[]): RangeUpdate[] {
  return changes.map((c) => ({ id: c.id, start_day: c.to[0], end_day: c.to[1] }));
}

export type PlannedChanges =
  | { ok: true; changes: RangeChange[] }
  | { ok: false; side: KnockOnSide; resolution: Resolution | null };

/**
 * The other legs' new ranges for a set of picks. The two sides touch disjoint
 * legs, so their changes are simply concatenated.
 *
 * `lenient` is the editor's form: a side without a pick (or with one that is
 * no longer usable) takes its recommendation, and it fails only when a side has
 * no usable option at all.
 *
 * The strict form is the API's. A side the caller says nothing about keeps the
 * behaviour that predates knock-on saves: growing into a neighbour stays an
 * overlap (and is refused by validation), shrinking leaves a gap. A side the
 * caller does name must offer that resolution unblocked — nothing is
 * substituted behind the caller's back. A pick for a side the edit does not
 * touch is ignored, so a caller can always send its preference without first
 * working out whether it is needed.
 */
export function plannedChanges(
  plan: KnockOnPlan,
  picks: KnockOnPicks,
  mode: 'strict' | 'lenient' = 'strict',
): PlannedChanges {
  const out: RangeChange[] = [];
  for (const c of plan.choices) {
    const pick = picks[c.side];
    if (pick === undefined && mode === 'strict') continue;

    const picked =
      mode === 'lenient' ? pickedOption(c, pick) : c.options.find((o) => o.resolution === pick && !o.blockedBy);
    if (!picked) return { ok: false, side: c.side, resolution: pick ?? null };
    out.push(...picked.changes);
  }
  return { ok: true, changes: out.sort(byFrom) };
}
