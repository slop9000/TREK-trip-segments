// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEditor } from '../../client-src/views/editor';
import { renderOverview } from '../../client-src/views/overview';
import { stripGeometry, tickStride } from '../../client-src/views/strip';
import { PALETTE } from '../../src/shared/palette';
import type { OverviewPayload, SegmentView } from '../../src/shared/types';
import type { EditorState } from '../../client-src/store';

function view(id: number, start: number, end: number, name = `Leg ${id}`): SegmentView {
  return {
    id,
    trip_id: 1,
    name,
    color: '#4F46E5',
    tone: 'default',
    start_day: start,
    end_day: end,
    created_at: 'x',
    updated_at: 'x',
    index: id - 1,
    status: 'ok',
    effStart: start,
    effEnd: end,
    effLength: end - start + 1,
    startDate: null,
    endDate: null,
  };
}

function overview(segments: SegmentView[] = []): OverviewPayload {
  return {
    trip: { id: 1, title: 'Japan', start_date: '2026-04-10', end_date: '2026-04-21' },
    dayCount: 12,
    days: Array.from({ length: 12 }, (_, i) => ({
      id: 101 + i,
      pos: i + 1,
      date: `2026-04-${String(10 + i).padStart(2, '0')}`,
      title: `Day ${i + 1}`,
      assignmentCount: 1,
    })),
    segments,
    uncovered: [],
    unassigned: { bookings: 0, stays: 0 },
  };
}

const editorState = (over: Partial<EditorState> = {}): EditorState => ({
  mode: 'create',
  draft: { name: '', color: '#4F46E5', start_day: 1, end_day: 1 },
  issues: [],
  ...over,
});

let node: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  node = document.createElement('div');
  document.body.append(node);
});

describe('editor', () => {
  it('builds the whole form without throwing', () => {
    renderEditor(node, editorState(), overview(), { onSave: vi.fn(), onCancel: vi.fn() });

    expect(node.querySelector('input')).not.toBeNull();
    expect(node.querySelectorAll('select')).toHaveLength(2);
    expect(node.querySelectorAll('.seg-swatch')).toHaveLength(PALETTE.length);
    expect(node.querySelectorAll('option')).toHaveLength(24); // 12 days x 2 selects
  });

  it('offers every day as a labelled option', () => {
    renderEditor(node, editorState(), overview(), { onSave: vi.fn(), onCancel: vi.fn() });

    const first = node.querySelector('option');
    expect(first?.textContent).toBe('Day 1 - Apr 10 - Day 1');
    expect((node.querySelector('select') as HTMLSelectElement).value).toBe('1');
  });

  /** The reason the shared validator exists: no round trip, so no lost keystroke. */
  it('blocks saving an overlapping range with a message, before any request', () => {
    const onSave = vi.fn();
    renderEditor(node, editorState(), overview([view(1, 1, 5)]), { onSave, onCancel: vi.fn() });

    const save = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Add leg')!;
    expect(save.disabled).toBe(true);
    expect(node.querySelector('.seg-issues')?.textContent).toContain('already belong to another leg');

    save.click();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('enables saving once the range is free and the name is filled', () => {
    renderEditor(node, editorState({ draft: { name: '', color: '#4F46E5', start_day: 6, end_day: 9 } }), overview([view(1, 1, 5)]), {
      onSave: vi.fn(),
      onCancel: vi.fn(),
    });

    const input = node.querySelector('input') as HTMLInputElement;
    const save = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Add leg')!;

    expect(save.disabled).toBe(true); // no name yet
    input.value = 'Kanazawa';
    input.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(false);
    expect(node.querySelector('.seg-issues')?.textContent).toBe('');
  });

  it('passes the edited values and the id back on save', () => {
    const onSave = vi.fn();
    renderEditor(
      node,
      editorState({ mode: 'edit', id: 1, draft: { name: 'Tokyo', color: '#F59E0B', start_day: 1, end_day: 5 } }),
      overview([view(1, 1, 5)]),
      { onSave, onCancel: vi.fn() },
    );

    const save = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    expect(save.disabled).toBe(false); // editing itself is not an overlap

    save.click();
    expect(onSave).toHaveBeenCalledWith({ name: 'Tokyo', color: '#F59E0B', start_day: 1, end_day: 5 }, 1);
  });

  it('accepts a custom picker colour and canonicalises it before save', () => {
    const onSave = vi.fn();
    renderEditor(
      node,
      editorState({ draft: { name: 'Custom leg', color: '#4F46E5', start_day: 1, end_day: 2 } }),
      overview(),
      { onSave, onCancel: vi.fn() },
    );

    const picker = node.querySelector('input[type="color"]') as HTMLInputElement;
    picker.value = '#12abef';
    picker.dispatchEvent(new Event('input'));
    expect(node.querySelector('.seg-color-value')?.textContent).toBe('#12ABEF');
    expect(node.querySelectorAll('.seg-swatch--on')).toHaveLength(0);

    [...node.querySelectorAll('button')].find((b) => b.textContent === 'Add leg')!.click();
    expect(onSave).toHaveBeenCalledWith({ name: 'Custom leg', color: '#12ABEF', start_day: 1, end_day: 2 }, undefined);
  });

  it('never re-renders the inputs while the same editor is open, so typing is safe', () => {
    const state = editorState();
    const args = [node, state, overview(), { onSave: vi.fn(), onCancel: vi.fn() }] as const;

    renderEditor(...args);
    const input = node.querySelector('input') as HTMLInputElement;
    input.value = 'half typed';

    renderEditor(...args); // a refresh arrives mid-edit

    expect(node.querySelector('input')).toBe(input);
    expect((node.querySelector('input') as HTMLInputElement).value).toBe('half typed');
  });

  it('clears itself when the editor closes', () => {
    renderEditor(node, editorState(), overview(), { onSave: vi.fn(), onCancel: vi.fn() });
    renderEditor(node, null, overview(), { onSave: vi.fn(), onCancel: vi.fn() });
    expect(node.children).toHaveLength(0);
  });
});

describe('overview view', () => {
  const actions = { onCreate: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onToggle: vi.fn(), onClose: vi.fn() };
  const closed = { id: null, detail: null };

  it('renders a card per leg with what is inside it', () => {
    const a = { ...view(1, 1, 5, 'Tokyo'), counts: { places: 7, bookings: 2, stays: 1 } };
    const b = view(2, 6, 9, 'Kanazawa');
    renderOverview(node, overview([a, b]), closed, actions);

    expect(node.querySelectorAll('.seg-card')).toHaveLength(2);
    expect(node.textContent).toContain('Tokyo');
    expect(node.querySelector('.seg-card-counts')?.textContent).toBe('7 places · 2 bookings · 1 stay');
  });

  it('fires details, edit and delete for the right leg', () => {
    const one = view(1, 1, 5, 'Tokyo');
    renderOverview(node, overview([one]), closed, actions);

    for (const label of ['Details', 'Edit', 'Delete']) {
      [...node.querySelectorAll('button')].find((btn) => btn.textContent === label)!.click();
    }
    expect(actions.onToggle).toHaveBeenCalledWith(one);
    expect(actions.onEdit).toHaveBeenCalledWith(one);
    expect(actions.onDelete).toHaveBeenCalledWith(one);
  });

  it('offers a first-leg call to action when the trip has days but no legs', () => {
    renderOverview(node, overview([]), closed, actions);

    const cta = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Add the first leg');
    expect(cta).toBeDefined();
    cta!.click();
    expect(actions.onCreate).toHaveBeenCalled();
  });

  it('explains an empty trip instead of offering a leg it cannot make', () => {
    renderOverview(node, { ...overview([]), dayCount: 0, days: [] }, closed, actions);

    expect(node.textContent).toContain('Add some days to the trip first');
    expect(node.querySelectorAll('button')).toHaveLength(0);
  });

  it('warns about uncovered days and unplaceable bookings', () => {
    const data = {
      ...overview([view(1, 1, 5)]),
      uncovered: [[6, 9] as [number, number]],
      unassigned: { bookings: 1, stays: 0 },
    };
    renderOverview(node, data, closed, actions);

    expect(node.textContent).toContain('4 days are not in any leg: 6–9');
    expect(node.textContent).toContain('1 booking is not attached to a day, so it cannot belong to any leg');
  });
});

describe('day strip', () => {
  it('places bars by percentage of the trip', () => {
    const bars = stripGeometry([view(1, 1, 5), view(2, 7, 12)], 12);

    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ leftPct: 0, widthPct: (5 / 12) * 100 });
    expect(bars[1]?.leftPct).toBeCloseTo((6 / 12) * 100);
  });

  it('skips legs that fall outside the trip', () => {
    const gone = { ...view(1, 40, 45), status: 'out_of_range' as const, effStart: null, effEnd: null, effLength: 0 };
    expect(stripGeometry([gone], 12)).toEqual([]);
  });

  /** A six-month trip must not produce a wall of ticks. */
  it('keeps the axis readable at any trip length', () => {
    for (const dayCount of [3, 12, 40, 180, 400]) {
      expect(Math.ceil(dayCount / tickStride(dayCount))).toBeLessThanOrEqual(12);
    }
  });
});

describe('expanding a leg in place', () => {
  const actions = { onCreate: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onToggle: vi.fn(), onClose: vi.fn() };
  const detail = {
    segment: view(1, 1, 5, 'Tokyo'),
    dayCount: 12,
    days: [{ id: 1, pos: 1, date: '2026-04-10', title: 'Arrival', places: [], notes: [] }],
    bookings: [],
    stays: [],
  };

  /** The whole point of the change: the other legs stay on screen. */
  it('keeps every leg listed while one is expanded', () => {
    renderOverview(node, overview([view(1, 1, 5, 'Tokyo'), view(2, 6, 9, 'Kanazawa')]), { id: 1, detail }, actions);

    expect(node.querySelectorAll('.seg-card')).toHaveLength(2);
    expect(node.querySelectorAll('.seg-card--open')).toHaveLength(1);
    expect(node.textContent).toContain('Kanazawa');
  });

  it('renders the panel inside the expanded card', () => {
    renderOverview(node, overview([view(1, 1, 5, 'Tokyo')]), { id: 1, detail }, actions);

    const panel = node.querySelector('.seg-card--open .seg-card-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Schedule');
    expect(panel?.textContent).toContain('Bookings');
  });

  it('offers a real Close button, not a ghost link', () => {
    renderOverview(node, overview([view(1, 1, 5, 'Tokyo')]), { id: 1, detail }, actions);

    const close = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
    expect(close.className).toContain('trek-btn--secondary');
    close.click();
    expect(actions.onClose).toHaveBeenCalled();
  });

  it('flips the toggle label while open', () => {
    renderOverview(node, overview([view(1, 1, 5, 'Tokyo')]), { id: 1, detail }, actions);
    expect([...node.querySelectorAll('button')].some((b) => b.textContent === 'Hide')).toBe(true);
  });

  it('shows the leg header before its contents have loaded', () => {
    renderOverview(node, overview([view(1, 1, 5, 'Tokyo')]), { id: 1, detail: null }, actions);

    const panel = node.querySelector('.seg-card-panel');
    expect(panel?.textContent).toContain('Tokyo');
    expect(panel?.textContent).toContain('Loading this leg');
  });
});

describe('making room when an edit runs into another leg', () => {
  const legs = () => [view(1, 1, 4, 'Tokyo'), view(2, 5, 8, 'Kyoto'), view(3, 9, 12, 'Osaka')];

  function open(id: number, onSave = vi.fn(), rows = legs()) {
    const leg = rows.find((l) => l.id === id)!;
    renderEditor(
      node,
      editorState({ mode: 'edit', id, draft: { name: leg.name, color: leg.color, start_day: leg.start_day, end_day: leg.end_day } }),
      overview(rows),
      { onSave, onCancel: vi.fn() },
    );
    return onSave;
  }

  const selects = () => node.querySelectorAll('select') as NodeListOf<HTMLSelectElement>;
  const radios = () => [...node.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true');
  const save = () => [...node.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Save'))!;
  const radio = (title: string) => radios().find((r) => r.querySelector('.seg-choice-title')?.textContent === title)!;

  function setDay(which: 0 | 1, day: number): void {
    const select = selects()[which]!;
    select.value = String(day);
    select.dispatchEvent(new Event('change'));
  }

  it('offers a choice instead of the overlap error, defaulting to pushing the later legs back', () => {
    open(1);
    setDay(1, 6);

    expect(node.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(radios().map((r) => r.querySelector('.seg-choice-title')?.textContent)).toEqual([
      'Push the later legs back',
      'Take the days from Kyoto',
    ]);
    expect(checked()).toBe(radios()[0]);
    expect(node.querySelector('.seg-knock .trek-label')?.textContent).toBe('Day 5–6 already belong to Kyoto.');
    expect(node.querySelector('.seg-issues')?.textContent).toBe('');
    expect(save().disabled).toBe(false);
    expect(save().textContent).toBe('Save and change 2 other legs');
  });

  it('lists exactly which legs change, and says when one gets shorter', () => {
    open(1);
    setDay(1, 6);

    const rows = [...radios()[0]!.querySelectorAll('.seg-choice-change')].map((r) => r.textContent);
    expect(rows).toEqual(['KyotoDay 5–8 → Day 7–10', 'OsakaDay 9–12 → Day 11–12(2 days shorter)']);
  });

  it('switches to taking the days from the neighbour and saves exactly that', () => {
    const onSave = open(1);
    setDay(1, 6);

    radio('Take the days from Kyoto').click();
    expect(checked()).toBe(radio('Take the days from Kyoto'));
    expect(radio('Push the later legs back').classList.contains('seg-choice--on')).toBe(false);
    expect(save().textContent).toBe('Save and change 1 other leg');

    save().click();
    expect(onSave).toHaveBeenCalledWith(
      { name: 'Tokyo', color: '#4F46E5', start_day: 1, end_day: 6 },
      1,
      { picks: { end: 'take' }, expected: [{ id: 2, start_day: 7, end_day: 8 }] },
    );
  });

  it('shows an option that would empty a leg as unavailable, with the reason', () => {
    open(1, vi.fn(), legs().slice(0, 2));
    setDay(1, 8);

    const take = radio('Take the days from Kyoto');
    expect(take.disabled).toBe(true);
    expect(take.textContent).toContain('Kyoto would have no days left.');
    expect(checked()).toBe(radio('Push the later legs back'));
  });

  it('falls back to the overlap error when every option would empty a leg', () => {
    open(1);
    setDay(1, 9);

    expect(radios().every((r) => r.disabled)).toBe(true);
    expect(node.querySelector('.seg-knock .trek-label')?.textContent).toBe(
      'Day 5–9 already belong to Kyoto and the legs after it.',
    );
    expect(radio('Push the later legs back').textContent).toContain('Osaka would have no days left.');
    expect(save().disabled).toBe(true);
    expect(save().textContent).toBe('Save');
    expect(node.querySelector('.seg-issues')?.textContent).toContain('already belong to another leg');
  });

  it('offers give, pull and gap when the leg gets shorter, and Save alone for a gap', () => {
    const onSave = open(1);
    setDay(1, 2);

    expect(radios().map((r) => r.querySelector('.seg-choice-title')?.textContent)).toEqual([
      'Give the days to Kyoto',
      'Pull the later legs forward',
      'Leave a gap',
    ]);
    expect(save().textContent).toBe('Save and change 1 other leg');

    radio('Pull the later legs forward').click();
    expect(save().textContent).toBe('Save and change 2 other legs');

    radio('Leave a gap').click();
    expect(save().textContent).toBe('Save');
    save().click();
    // The pick still goes along, so the server can tell if it no longer means "nothing moves".
    expect(onSave).toHaveBeenCalledWith({ name: 'Tokyo', color: '#4F46E5', start_day: 1, end_day: 2 }, 1, {
      picks: { end: 'gap' },
      expected: [],
    });
  });

  it('asks about the first day too, defaulting to taking from the previous leg', () => {
    open(2);
    setDay(0, 3);

    expect(node.querySelector('.seg-knock .trek-label')?.textContent).toBe('Day 3–4 already belong to Tokyo.');
    expect(checked()?.querySelector('.seg-choice-title')?.textContent).toBe('Take the days from Tokyo');
  });

  it('keeps the options and the pick while the user types a new name', () => {
    open(1);
    setDay(1, 6);
    radio('Take the days from Kyoto').click();
    const before = radios();

    const input = node.querySelector('input') as HTMLInputElement;
    input.value = 'Tokyo and Yokohama';
    input.dispatchEvent(new Event('input'));

    expect(radios()).toEqual(before);
    expect(checked()).toBe(radio('Take the days from Kyoto'));
  });

  it('moves the pick with the arrow keys, as a radio group does', () => {
    open(1);
    setDay(1, 2);
    radios()[0]!.focus();

    radios()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(checked()).toBe(radio('Pull the later legs forward'));
    expect(document.activeElement).toBe(radio('Pull the later legs forward'));
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('removes the choice again when the range goes back to fitting', () => {
    open(1);
    setDay(1, 6);
    setDay(1, 4);

    expect(radios()).toHaveLength(0);
    expect(save().textContent).toBe('Save');
  });

  it('never offers a choice when creating a leg', () => {
    renderEditor(node, editorState({ draft: { name: 'New', color: '#4F46E5', start_day: 3, end_day: 6 } }), overview(legs()), {
      onSave: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(radios()).toHaveLength(0);
    expect(node.querySelector('.seg-issues')?.textContent).toContain('already belong to another leg');
  });
});
