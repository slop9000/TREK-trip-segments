import { button, clear, el, toneDot } from '../dom';
import { PALETTE, normalizeHexColor } from '../../src/shared/palette';
import { MAX_SEGMENTS_PER_TRIP, NAME_MAX } from '../../src/shared/limits';
import { dayRangeLabel, shortDate } from '../../src/shared/format';
import { changesFor, pickedOption, planKnockOn, toRangeUpdates } from '../../src/shared/knock-on';
import { validateSegmentInput } from '../../src/shared/validate';
import type { IssueCode } from '../../src/shared/validate';
import type {
  KnockOnChoice,
  KnockOnOption,
  KnockOnPicks,
  KnockOnPlan,
  RangeChange,
} from '../../src/shared/knock-on';
import type { OverviewDay, OverviewPayload, RangeUpdate, SegmentInput } from '../../src/shared/types';
import type { EditorState } from '../store';

/**
 * The complete error vocabulary, written for a human.
 *
 * These messages exist client-side because they CANNOT come from the server:
 * the iframe bridge forwards only the HTTP status code and discards the response
 * body (PluginFrame.tsx:368). So the shared validator runs here, before the
 * request, and the server repeats it purely as a backstop.
 */
const ISSUE_TEXT: Record<IssueCode, string> = {
  name_required: 'Give this leg a name.',
  name_too_long: `Keep the name under ${NAME_MAX} characters.`,
  color_invalid: 'Pick a valid colour.',
  range_invalid: 'The last day has to be on or after the first day.',
  range_out_of_bounds: 'That is past the last day of the trip.',
  overlap: 'Those days already belong to another leg.',
  limit_reached: `A trip can have at most ${MAX_SEGMENTS_PER_TRIP} legs.`,
  others_invalid: 'The other legs would no longer fit the trip.',
};

export interface EditorActions {
  /** `others` is present only when the save also moves other legs. */
  onSave: (input: SegmentInput, id?: number, others?: RangeUpdate[]) => void;
  onCancel: () => void;
}

const ARROW_STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Kyoto  Day 9–12 → Day 11–14", with how the length changed when it did. */
function changeRow(change: RangeChange, dayCount: number): HTMLElement {
  // A leg that already ran past the end is shown as the user sees it in the
  // strip, clipped to the trip, not as the stored range nobody can see.
  const fromEnd = Math.min(change.from[1], dayCount);
  const before = fromEnd - change.from[0] + 1;
  const after = change.to[1] - change.to[0] + 1;
  const delta = after - before;

  return el('span', { class: 'seg-choice-change' }, [
    toneDot(change.color),
    el('span', { class: 'seg-choice-name', text: change.name }),
    el('span', {
      class: 'trek-muted',
      text: `${dayRangeLabel(change.from[0], fromEnd)} → ${dayRangeLabel(change.to[0], change.to[1])}`,
    }),
    delta !== 0 &&
      el('span', {
        class: 'trek-faint',
        text: `(${plural(Math.abs(delta), 'day', 'days')} ${delta < 0 ? 'shorter' : 'longer'})`,
      }),
  ]);
}

/** The question a choice answers, naming exactly the days involved. */
function choiceHeading(c: KnockOnChoice): string {
  const days = dayRangeLabel(c.span[0], c.span[1]);
  if (c.kind === 'shrink') return `${days} ${c.days === 1 ? 'is' : 'are'} no longer in this leg.`;

  const verb = c.days === 1 ? 'belongs' : 'belong';
  const [lo, hi] = c.neighbour.range;
  // A long jump can run past the neighbour into the legs beyond it.
  if (c.span[0] >= lo && c.span[1] <= hi) return `${days} already ${verb} to ${c.neighbour.name}.`;
  const beyond = c.side === 'end' ? 'the legs after it' : 'the legs before it';
  return `${days} already ${verb} to ${c.neighbour.name} and ${beyond}.`;
}

function optionTitle(c: KnockOnChoice, o: KnockOnOption): string {
  const later = c.side === 'end';
  switch (o.resolution) {
    case 'push':
      return later ? 'Push the later legs back' : 'Move the earlier legs earlier';
    case 'pull':
      return later ? 'Pull the later legs forward' : 'Move the earlier legs later';
    case 'take':
      return `Take the days from ${c.neighbour.name}`;
    case 'give':
      return `Give the days to ${c.neighbour.name}`;
    case 'gap':
      return 'Leave a gap';
  }
}

function optionSummary(c: KnockOnChoice, o: KnockOnOption): string {
  if (o.blockedBy) return `${o.blockedBy.name} would have no days left.`;

  const shift = plural(c.days, 'day', 'days');
  const legs = c.side === 'end' ? 'Every later leg' : 'Every earlier leg';
  switch (o.resolution) {
    case 'push':
      return `${legs} moves ${shift} ${c.side === 'end' ? 'later' : 'earlier'}.`;
    case 'pull':
      return `${legs} moves ${shift} ${c.side === 'end' ? 'earlier' : 'later'}.`;
    case 'take':
      return `Only ${c.neighbour.name} gets shorter.`;
    case 'give':
      return `Only ${c.neighbour.name} gets longer.`;
    case 'gap':
      return `No other leg changes; ${dayRangeLabel(c.span[0], c.span[1])} will not be in any leg.`;
  }
}

function dayLabel(day: OverviewDay): string {
  const parts = [`Day ${day.pos}`];
  const date = shortDate(day.date);
  if (date) parts.push(date);
  if (day.title) parts.push(day.title);
  return parts.join(' - ');
}

function daySelect(days: readonly OverviewDay[], selected: number): HTMLSelectElement {
  const select = el('select', { class: 'trek-select' });
  for (const day of days) {
    const option = el('option', { text: dayLabel(day), attrs: { value: String(day.pos) } });
    if (day.pos === selected) option.selected = true;
    select.append(option);
  }
  return select;
}

/** Identifies which segment the open editor belongs to, so we rebuild only on a real change. */
function editorKey(editor: EditorState): string {
  return `${editor.mode}:${editor.id ?? 'new'}`;
}

const KEY_ATTR = 'editorKey';

/**
 * An UNCONTROLLED form: the DOM is built once when the editor opens and is never
 * re-rendered from state afterwards. Only the validation message and the save
 * button's disabled flag are updated in place, so typing can never lose the
 * caret or the selection to a re-render.
 */
export function renderEditor(
  node: HTMLElement,
  editor: EditorState | null,
  data: OverviewPayload,
  actions: EditorActions,
): void {
  if (!editor) {
    clear(node);
    delete node.dataset[KEY_ATTR];
    return;
  }

  // The memo lives on the node, not in a module variable: it has to describe the
  // DOM that is actually there. A module-level flag would keep claiming "already
  // built" for a node something else had emptied, and the editor would silently
  // refuse to open.
  const key = editorKey(editor);
  if (node.dataset[KEY_ATTR] === key && node.childElementCount > 0) return;
  node.dataset[KEY_ATTR] = key;
  clear(node);

  // Captured up front: the closures below outlive this call, and `editor` is a
  // nullable parameter that TypeScript cannot keep narrowed inside them.
  const editingId = editor.id;
  const isCreate = editor.mode === 'create';

  let color = normalizeHexColor(editor.draft.color) ?? PALETTE[0]!.hex;

  const nameInput = el('input', {
    class: 'trek-input',
    attrs: { type: 'text', maxlength: String(NAME_MAX), placeholder: 'Tokyo' },
  });
  nameInput.value = editor.draft.name;

  const startSelect = daySelect(data.days, editor.draft.start_day);
  const endSelect = daySelect(data.days, editor.draft.end_day);

  const swatches = el('div', { class: 'trek-cluster seg-swatches' });
  const swatchButtons = PALETTE.map((swatch) => {
    const node = el('button', {
      class: `seg-swatch${swatch.hex === color ? ' seg-swatch--on' : ''}`,
      title: swatch.label,
      attrs: { type: 'button', 'aria-label': swatch.label, 'aria-pressed': String(swatch.hex === color) },
      style: { backgroundColor: swatch.hex },
      on: {
        click: () => {
          selectColor(swatch.hex);
        },
      },
    });
    swatches.append(node);
    return node;
  });

  const customInput = el('input', {
    class: 'seg-color-picker',
    attrs: { type: 'color', 'aria-label': 'Custom colour', title: 'Choose a custom colour' },
  });
  customInput.value = color;
  const colorValue = el('span', { class: 'trek-faint seg-color-value', text: color });

  function selectColor(next: string): void {
    const normalized = normalizeHexColor(next);
    if (!normalized) return;
    color = normalized;
    customInput.value = color;
    colorValue.textContent = color;
    for (const [i, b] of swatchButtons.entries()) {
      const selected = PALETTE[i]!.hex === color;
      b.classList.toggle('seg-swatch--on', selected);
      b.setAttribute('aria-pressed', String(selected));
    }
    revalidate();
  }

  customInput.addEventListener('input', () => selectColor(customInput.value));

  const issuesNode = el('p', { class: 'seg-issues' });
  const saveButton = button(isCreate ? 'Add leg' : 'Save', {
    variant: 'primary',
    onClick: () => {
      if (others.length > 0) actions.onSave(read(), editingId, others);
      else actions.onSave(read(), editingId);
    },
  });

  // --- knock-on choices --------------------------------------------------
  //
  // Like the issues line, this block is output, not input: it is rebuilt only
  // when the edited range raises a different question, and a pick merely
  // toggles classes, so a keyboard user's focus stays on the option they are
  // moving through.

  const knockNode = el('div', { class: 'trek-stack seg-knock' });
  let plan: KnockOnPlan = { choices: [] };
  let planKey = '';
  const picks: KnockOnPicks = {};
  let others: RangeUpdate[] = [];
  const optionButtons = new Map<KnockOnChoice['side'], Array<{ option: KnockOnOption; node: HTMLButtonElement }>>();

  function showPicks(): void {
    for (const c of plan.choices) {
      // By resolution, not identity: the plan is recomputed on every keystroke
      // while the buttons keep the options they were built from.
      const current = pickedOption(c, picks[c.side])?.resolution;
      for (const { option, node } of optionButtons.get(c.side) ?? []) {
        const on = option.resolution === current;
        node.classList.toggle('seg-choice--on', on);
        node.setAttribute('aria-checked', String(on));
        // Roving tabindex: the group is one tab stop, arrows move within it.
        node.tabIndex = on ? 0 : -1;
      }
    }
  }

  function pick(side: KnockOnChoice['side'], option: KnockOnOption, focus = false): void {
    picks[side] = option.resolution;
    showPicks();
    if (focus) optionButtons.get(side)?.find((b) => b.option === option)?.node.focus();
    revalidate();
  }

  function renderChoice(c: KnockOnChoice): HTMLElement {
    const headingId = `seg-knock-${c.side}`;
    const visible = c.options.filter((o) => o.sameAs === null);
    const buttons = visible.map((option) => {
      const node = el(
        'button',
        {
          class: 'seg-choice',
          attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' },
          on: { click: () => pick(c.side, option) },
        },
        [
          el('span', { class: 'seg-choice-title', text: optionTitle(c, option) }),
          el('span', { class: 'seg-choice-sub trek-muted', text: optionSummary(c, option) }),
          !option.blockedBy &&
            option.changes.length > 0 &&
            el(
              'span',
              { class: 'seg-choice-changes' },
              option.changes.map((change) => changeRow(change, data.dayCount)),
            ),
        ],
      );
      node.disabled = Boolean(option.blockedBy);
      return { option, node };
    });
    optionButtons.set(c.side, buttons);

    const group = el(
      'div',
      { class: 'seg-choices', attrs: { role: 'radiogroup', 'aria-labelledby': headingId } },
      buttons.map((b) => b.node),
    );

    // Arrow keys move the pick, as in any radio group, skipping options that
    // cannot be chosen.
    group.addEventListener('keydown', (ev) => {
      const step = ARROW_STEP[(ev as KeyboardEvent).key];
      if (step === undefined) return;
      const usable = buttons.filter((b) => !b.option.blockedBy);
      const at = usable.findIndex((b) => b.node === document.activeElement);
      const next = usable[(at + step + usable.length) % usable.length];
      if (!next) return;
      ev.preventDefault();
      pick(c.side, next.option, true);
    });

    return el('div', { class: 'seg-knock-group' }, [
      el('div', { class: 'trek-label', text: choiceHeading(c), attrs: { id: headingId } }),
      group,
    ]);
  }

  function renderPlan(next: KnockOnPlan): void {
    plan = next;
    const key = JSON.stringify(next.choices);
    if (key === planKey) return;
    planKey = key;

    // A pick survives a change of range when it is still offered; otherwise
    // the side falls back to its recommendation.
    for (const side of ['start', 'end'] as const) {
      const c = next.choices.find((candidate) => candidate.side === side);
      const kept = c?.options.find((o) => o.resolution === picks[side] && !o.blockedBy && o.sameAs === null);
      if (!kept) delete picks[side];
    }

    optionButtons.clear();
    knockNode.replaceChildren(...next.choices.map(renderChoice));
    showPicks();
  }

  function read(): SegmentInput {
    return {
      name: nameInput.value,
      color,
      start_day: Number(startSelect.value),
      end_day: Number(endSelect.value),
    };
  }

  function revalidate(): void {
    const input = read();

    // Keep the range sane as the user drags the first day past the last.
    if (input.end_day < input.start_day) {
      endSelect.value = String(input.start_day);
      input.end_day = input.start_day;
    }

    // Only an edit of an existing leg inside the trip can push others around;
    // anything else is left to the plain validator and its messages.
    const inTrip = Number.isInteger(input.start_day) && input.start_day >= 1 && input.end_day <= data.dayCount;
    renderPlan(
      editingId !== undefined && inTrip
        ? planKnockOn({ id: editingId, start_day: input.start_day, end_day: input.end_day }, data.segments, data.dayCount)
        : { choices: [] },
    );
    // Null when some question has no usable answer; the overlap message below
    // then says why Save is off, and the cards say what is in the way.
    const changes = changesFor(plan, picks) ?? [];
    others = toRangeUpdates(changes);

    const issues = validateSegmentInput(input, {
      dayCount: data.dayCount,
      existing: data.segments,
      ...(editingId !== undefined ? { editingId } : {}),
      ...(others.length > 0 ? { others } : {}),
    });

    issuesNode.textContent = issues.map((code) => ISSUE_TEXT[code]).join(' ');
    issuesNode.classList.toggle('seg-issues--on', issues.length > 0);
    saveButton.disabled = issues.length > 0;
    if (!isCreate) {
      saveButton.textContent =
        others.length > 0 ? `Save and change ${plural(others.length, 'other leg', 'other legs')}` : 'Save';
    }
  }

  nameInput.addEventListener('input', revalidate);
  startSelect.addEventListener('change', revalidate);
  endSelect.addEventListener('change', revalidate);

  node.append(
    el('div', { class: 'trek-glass trek-stack seg-editor trek-modal-enter' }, [
      el('div', { class: 'trek-title', text: isCreate ? 'New leg' : 'Edit leg' }),

      el('label', { class: 'trek-label', text: 'Name' }),
      nameInput,

      el('label', { class: 'trek-label', text: 'Colour' }),
      swatches,
      el('div', { class: 'seg-custom-color' }, [
        customInput,
        el('span', { text: 'Custom' }),
        colorValue,
      ]),

      el('div', { class: 'seg-range' }, [
        el('div', { class: 'seg-range-field' }, [el('label', { class: 'trek-label', text: 'First day' }), startSelect]),
        el('div', { class: 'seg-range-field' }, [el('label', { class: 'trek-label', text: 'Last day' }), endSelect]),
      ]),

      knockNode,

      issuesNode,

      el('div', { class: 'trek-cluster' }, [
        saveButton,
        button('Cancel', { variant: 'ghost', onClick: actions.onCancel }),
      ]),
    ]),
  );

  revalidate();
  nameInput.focus();
  nameInput.select();
}
