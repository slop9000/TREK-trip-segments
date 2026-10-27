import { describe, expect, it } from 'vitest';
import {
  changesFor,
  explicitChanges,
  planKnockOn,
  toRangeUpdates,
} from '../src/shared/knock-on';
import { validateSegmentInput } from '../src/shared/validate';
import type { KnockOnChoice, KnockOnPicks, KnockOnPlan, Resolution } from '../src/shared/knock-on';
import type { SegmentRow } from '../src/shared/types';

const leg = (id: number, start: number, end: number, name = `Leg ${id}`): SegmentRow => ({
  id,
  trip_id: 1,
  name,
  color: '#4F46E5',
  tone: 'default',
  start_day: start,
  end_day: end,
  created_at: 'x',
  updated_at: 'x',
});

/** Four legs tiling a 20-day trip. */
const TILED = [leg(1, 1, 5, 'Tokyo'), leg(2, 6, 10, 'Kyoto'), leg(3, 11, 15, 'Osaka'), leg(4, 16, 20, 'Hiroshima')];

function only(plan: KnockOnPlan, side: KnockOnChoice['side']): KnockOnChoice {
  const found = plan.choices.find((c) => c.side === side);
  if (!found) throw new Error(`no ${side} choice`);
  return found;
}

/** `{ id: [start, end] }` for one option, the easiest shape to read in a test. */
function ranges(c: KnockOnChoice, resolution: Resolution): Record<number, [number, number]> {
  const option = c.options.find((o) => o.resolution === resolution);
  if (!option) throw new Error(`no ${resolution} option`);
  return Object.fromEntries(option.changes.map((ch) => [ch.id, ch.to]));
}

function blocked(c: KnockOnChoice, resolution: Resolution): string | null {
  return c.options.find((o) => o.resolution === resolution)?.blockedBy?.name ?? null;
}

describe('growing the last day into the next leg', () => {
  const plan = planKnockOn({ id: 1, start_day: 1, end_day: 7 }, TILED, 20);
  const end = only(plan, 'end');

  it('asks once, about exactly the overlapping days', () => {
    expect(plan.choices).toHaveLength(1);
    expect(end).toMatchObject({ kind: 'grow', days: 2, span: [6, 7], neighbour: { id: 2, name: 'Kyoto' } });
  });

  it('recommends pushing every later leg back by the overlap', () => {
    expect(end.recommended).toBe('push');
    expect(end.options.map((o) => o.resolution)).toEqual(['push', 'take']);
    expect(ranges(end, 'push')).toEqual({ 2: [8, 12], 3: [13, 17], 4: [18, 20] });
  });

  it('cuts the last leg at the last day of the trip instead of running past it', () => {
    const change = end.options[0]!.changes.find((c) => c.id === 4)!;
    expect(change.from).toEqual([16, 20]);
    expect(change.to).toEqual([18, 20]);
  });

  it('can take the days from the neighbour alone', () => {
    expect(ranges(end, 'take')).toEqual({ 2: [8, 10] });
  });

  it('pushes by the overlap, not by how far the day moved, when a gap comes first', () => {
    const rows = [leg(1, 1, 5), leg(2, 8, 10), leg(3, 11, 12)];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 9 }, rows, 20), 'end');

    expect(c.days).toBe(2);
    expect(ranges(c, 'push')).toEqual({ 2: [10, 12], 3: [13, 14] });
  });

  it('keeps gaps between the later legs as they are', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 8), leg(3, 12, 14)];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 6 }, rows, 20), 'end');

    expect(ranges(c, 'push')).toEqual({ 2: [7, 9], 3: [13, 15] });
  });

  it('raises nothing when the longer leg only fills a gap', () => {
    const rows = [leg(1, 1, 5), leg(2, 8, 10)];
    expect(planKnockOn({ id: 1, start_day: 1, end_day: 7 }, rows, 20).choices).toEqual([]);
  });

  it('refuses to push a leg off the end of the trip, and says which', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 10, 'Kyoto'), leg(3, 19, 20, 'Nara')];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 9 }, rows, 20), 'end');

    expect(blocked(c, 'push')).toBe('Nara');
    expect(c.recommended).toBe('take');
    expect(ranges(c, 'take')).toEqual({ 2: [10, 10] });
  });

  it('refuses to take every day of the neighbour', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 10, 'Kyoto'), leg(3, 11, 12)];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 10 }, rows, 20), 'end');

    expect(blocked(c, 'take')).toBe('Kyoto');
    expect(c.recommended).toBe('push');
    expect(ranges(c, 'push')).toEqual({ 2: [11, 15], 3: [16, 17] });
  });

  it('has no usable option when both would empty a leg', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 7, 'Kyoto'), leg(3, 8, 10, 'Nara')];
    const plan2 = planKnockOn({ id: 1, start_day: 1, end_day: 8 }, rows, 10);
    const c = only(plan2, 'end');

    expect(blocked(c, 'take')).toBe('Kyoto');
    expect(blocked(c, 'push')).toBe('Nara');
    expect(c.recommended).toBeNull();
    expect(changesFor(plan2, {})).toBeNull();
  });

  it('marks push as the same as take when the only later leg ends the trip', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 20)];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 7 }, rows, 20), 'end');

    expect(c.options.find((o) => o.resolution === 'push')?.sameAs).toBeNull();
    expect(c.options.find((o) => o.resolution === 'take')?.sameAs).toBe('push');
  });
});

describe('shrinking the last day away from the next leg', () => {
  const plan = planKnockOn({ id: 1, start_day: 1, end_day: 3 }, TILED, 20);
  const end = only(plan, 'end');

  it('names the freed days and recommends giving them to the neighbour', () => {
    expect(end).toMatchObject({ kind: 'shrink', days: 2, span: [4, 5] });
    expect(end.options.map((o) => o.resolution)).toEqual(['give', 'pull', 'gap']);
    expect(end.recommended).toBe('give');
    expect(ranges(end, 'give')).toEqual({ 2: [4, 10] });
  });

  it('pulls every later leg forward, and the last one keeps its end and grows', () => {
    expect(ranges(end, 'pull')).toEqual({ 2: [4, 8], 3: [9, 13], 4: [14, 20] });
  });

  it('can leave a gap and change nothing else', () => {
    expect(ranges(end, 'gap')).toEqual({});
  });

  it('asks nothing when a gap already separated the legs', () => {
    const rows = [leg(1, 1, 5), leg(2, 7, 10)];
    expect(planKnockOn({ id: 1, start_day: 1, end_day: 3 }, rows, 20).choices).toEqual([]);
  });

  it('marks pull as the same as give when only one leg follows', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 10)];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 3 }, rows, 20), 'end');
    expect(c.options.find((o) => o.resolution === 'pull')?.sameAs).toBe('give');
  });

  it('asks nothing for the last leg of the trip', () => {
    expect(planKnockOn({ id: 4, start_day: 16, end_day: 18 }, TILED, 20).choices).toEqual([]);
  });
});

describe('moving the first day', () => {
  const rows = [leg(1, 1, 3, 'Tokyo'), leg(2, 4, 6, 'Kyoto'), leg(3, 7, 10, 'Osaka'), leg(4, 11, 20, 'Nara')];

  it('growing into the previous leg recommends taking from it', () => {
    const c = only(planKnockOn({ id: 3, start_day: 5, end_day: 10 }, rows, 20), 'start');

    expect(c).toMatchObject({ kind: 'grow', days: 2, span: [5, 6], neighbour: { name: 'Kyoto' } });
    expect(c.options.map((o) => o.resolution)).toEqual(['take', 'push']);
    expect(c.recommended).toBe('take');
    expect(ranges(c, 'take')).toEqual({ 2: [4, 4] });
  });

  it('can move every earlier leg earlier, cutting the first at day 1', () => {
    const c = only(planKnockOn({ id: 3, start_day: 5, end_day: 10 }, rows, 20), 'start');
    expect(ranges(c, 'push')).toEqual({ 1: [1, 1], 2: [2, 4] });
  });

  it('refuses to move an earlier leg off the start of the trip', () => {
    const tight = [leg(1, 1, 1, 'Tokyo'), leg(2, 2, 6, 'Kyoto'), leg(3, 7, 10)];
    const c = only(planKnockOn({ id: 3, start_day: 5, end_day: 10 }, tight, 20), 'start');

    expect(blocked(c, 'push')).toBe('Tokyo');
    expect(blocked(c, 'take')).toBeNull();
  });

  it('refuses to take every day of the previous leg', () => {
    const c = only(planKnockOn({ id: 3, start_day: 4, end_day: 10 }, rows, 20), 'start');
    expect(blocked(c, 'take')).toBe('Kyoto');
  });

  it('shrinking gives the days back, pulls the earlier legs later, or leaves a gap', () => {
    const c = only(planKnockOn({ id: 3, start_day: 9, end_day: 10 }, rows, 20), 'start');

    expect(c).toMatchObject({ kind: 'shrink', days: 2, span: [7, 8] });
    expect(c.recommended).toBe('give');
    expect(ranges(c, 'give')).toEqual({ 2: [4, 8] });
    // The first leg keeps its start, so it grows.
    expect(ranges(c, 'pull')).toEqual({ 1: [1, 5], 2: [6, 8] });
    expect(ranges(c, 'gap')).toEqual({});
  });
});

describe('both ends at once', () => {
  it('moving a whole leg later asks about each end and combines the answers', () => {
    const plan = planKnockOn({ id: 2, start_day: 8, end_day: 12 }, TILED, 20);

    expect(plan.choices.map((c) => `${c.side}:${c.kind}`)).toEqual(['start:shrink', 'end:grow']);

    const defaults = changesFor(plan, {});
    expect(Object.fromEntries((defaults ?? []).map((c) => [c.id, c.to]))).toEqual({
      1: [1, 7],
      3: [13, 17],
      4: [18, 20],
    });

    const picked = changesFor(plan, { start: 'gap', end: 'take' });
    expect(Object.fromEntries((picked ?? []).map((c) => [c.id, c.to]))).toEqual({ 3: [13, 15] });
  });
});

describe('robustness', () => {
  it('does not depend on the order legs were created in', () => {
    const shuffled = [TILED[2]!, TILED[0]!, TILED[3]!, TILED[1]!];
    expect(planKnockOn({ id: 1, start_day: 1, end_day: 7 }, shuffled, 20)).toEqual(
      planKnockOn({ id: 1, start_day: 1, end_day: 7 }, TILED, 20),
    );
  });

  it('ignores a leg that already starts past the end of the trip', () => {
    const rows = [leg(1, 1, 5), leg(2, 6, 10), leg(3, 40, 45, 'Ghost')];
    const c = only(planKnockOn({ id: 1, start_day: 1, end_day: 7 }, rows, 12), 'end');

    expect(blocked(c, 'push')).toBeNull();
    expect(ranges(c, 'push')).toEqual({ 2: [8, 12] });
  });

  it('raises nothing for a leg that is not stored yet', () => {
    expect(planKnockOn({ id: 99, start_day: 1, end_day: 7 }, TILED, 20).choices).toEqual([]);
  });

  it('raises nothing when the range is unchanged', () => {
    expect(planKnockOn({ id: 2, start_day: 6, end_day: 10 }, TILED, 20).choices).toEqual([]);
  });

  /**
   * The property the server leans on: whatever the planner offers as usable
   * produces a layout the shared validator accepts. Checked exhaustively over
   * every edit of every leg in a few awkward layouts.
   */
  it('only ever offers layouts the validator accepts', () => {
    const layouts: Array<{ rows: SegmentRow[]; dayCount: number }> = [
      { rows: TILED, dayCount: 20 },
      { rows: [leg(1, 2, 3), leg(2, 5, 5), leg(3, 6, 9), leg(4, 12, 12)], dayCount: 12 },
      { rows: [leg(7, 4, 6), leg(3, 1, 3), leg(5, 7, 8)], dayCount: 8 },
      { rows: [leg(1, 1, 2), leg(2, 3, 9), leg(3, 30, 31)], dayCount: 9 },
    ];

    let checked = 0;
    for (const { rows, dayCount } of layouts) {
      for (const edited of rows.filter((r) => r.start_day <= dayCount)) {
        for (let start = 1; start <= dayCount; start++) {
          for (let end = start; end <= dayCount; end++) {
            const plan = planKnockOn({ id: edited.id, start_day: start, end_day: end }, rows, dayCount);
            // Every combination of usable answers, one per question.
            let combos: KnockOnPicks[] = [{}];
            for (const c of plan.choices) {
              const usable = c.options.filter((o) => !o.blockedBy).map((o) => o.resolution);
              combos = combos.flatMap((picks) => usable.map((r) => ({ ...picks, [c.side]: r })));
            }
            if (plan.choices.length === 0) continue;

            for (const picks of combos) {
              const result = explicitChanges(plan, picks);
              if (!result.ok || plan.choices.some((c) => picks[c.side] === undefined)) continue;
              const issues = validateSegmentInput(
                { name: 'x', color: '#4F46E5', start_day: start, end_day: end },
                { dayCount, existing: rows, editingId: edited.id, others: toRangeUpdates(result.changes) },
              );
              expect(issues, `${edited.id} -> ${start}-${end} ${JSON.stringify(picks)}`).toEqual([]);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('explicit picks, as the API takes them', () => {
  const plan = planKnockOn({ id: 1, start_day: 1, end_day: 7 }, TILED, 20);

  it('applies a named resolution', () => {
    const result = explicitChanges(plan, { end: 'take' });
    expect(result).toMatchObject({ ok: true, changes: [{ id: 2, to: [8, 10] }] });
  });

  it('changes nothing for a side the caller left out', () => {
    expect(explicitChanges(plan, {})).toEqual({ ok: true, changes: [] });
  });

  it('ignores a pick for a side the edit does not touch', () => {
    expect(explicitChanges(plan, { start: 'push', end: 'push' })).toMatchObject({ ok: true });
  });

  it('refuses a resolution that does not fit the edit', () => {
    expect(explicitChanges(plan, { end: 'gap' })).toEqual({ ok: false, side: 'end', resolution: 'gap' });
  });

  it('refuses a blocked resolution instead of substituting another', () => {
    const tight = planKnockOn({ id: 1, start_day: 1, end_day: 10 }, TILED, 20);
    expect(explicitChanges(tight, { end: 'take' })).toEqual({ ok: false, side: 'end', resolution: 'take' });
  });
});

describe('validating the final layout', () => {
  const input = { name: 'Tokyo', color: '#4F46E5', start_day: 1, end_day: 7 };

  it('accepts an edit once the other legs make room', () => {
    expect(validateSegmentInput(input, { dayCount: 20, existing: TILED, editingId: 1 })).toEqual(['overlap']);
    expect(
      validateSegmentInput(input, {
        dayCount: 20,
        existing: TILED,
        editingId: 1,
        others: [{ id: 2, start_day: 8, end_day: 10 }],
      }),
    ).toEqual([]);
  });

  it('rejects other legs that would collide with each other', () => {
    const others = [{ id: 2, start_day: 8, end_day: 12 }];
    expect(validateSegmentInput(input, { dayCount: 20, existing: TILED, editingId: 1, others })).toEqual([
      'others_invalid',
    ]);
  });

  it('rejects another leg moved past the end of the trip', () => {
    const others = [
      { id: 2, start_day: 8, end_day: 12 },
      { id: 3, start_day: 13, end_day: 17 },
      { id: 4, start_day: 18, end_day: 22 },
    ];
    expect(validateSegmentInput(input, { dayCount: 20, existing: TILED, editingId: 1, others })).toEqual([
      'others_invalid',
    ]);
  });

  it('rejects unknown, repeated or self-referencing legs', () => {
    const base = { dayCount: 20, existing: TILED, editingId: 1 };
    expect(validateSegmentInput(input, { ...base, others: [{ id: 9, start_day: 8, end_day: 10 }] })).toContain(
      'others_invalid',
    );
    expect(
      validateSegmentInput(input, {
        ...base,
        others: [
          { id: 2, start_day: 8, end_day: 10 },
          { id: 2, start_day: 8, end_day: 10 },
        ],
      }),
    ).toContain('others_invalid');
    expect(validateSegmentInput(input, { ...base, others: [{ id: 1, start_day: 8, end_day: 10 }] })).toContain(
      'others_invalid',
    );
  });
});
