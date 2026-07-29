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
  draft: { name: '', tone: 'default', start_day: 1, end_day: 1 },
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
    renderEditor(node, editorState({ draft: { name: '', tone: 'default', start_day: 6, end_day: 9 } }), overview([view(1, 1, 5)]), {
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
      editorState({ mode: 'edit', id: 1, draft: { name: 'Tokyo', tone: 'warn', start_day: 1, end_day: 5 } }),
      overview([view(1, 1, 5)]),
      { onSave, onCancel: vi.fn() },
    );

    const save = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    expect(save.disabled).toBe(false); // editing itself is not an overlap

    save.click();
    expect(onSave).toHaveBeenCalledWith({ name: 'Tokyo', tone: 'warn', start_day: 1, end_day: 5 }, 1);
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
