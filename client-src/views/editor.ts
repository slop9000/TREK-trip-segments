import { button, clear, el } from '../dom';
import { PALETTE, normalizeHexColor } from '../../src/shared/palette';
import { MAX_SEGMENTS_PER_TRIP, NAME_MAX } from '../../src/shared/limits';
import { shortDate } from '../../src/shared/format';
import { validateSegmentInput } from '../../src/shared/validate';
import type { IssueCode } from '../../src/shared/validate';
import type { OverviewDay, OverviewPayload, SegmentInput } from '../../src/shared/types';
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
};

export interface EditorActions {
  onSave: (input: SegmentInput, id?: number) => void;
  onCancel: () => void;
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
    onClick: () => actions.onSave(read(), editingId),
  });

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

    const issues = validateSegmentInput(input, {
      dayCount: data.dayCount,
      existing: data.segments,
      ...(editingId !== undefined ? { editingId } : {}),
    });

    issuesNode.textContent = issues.map((code) => ISSUE_TEXT[code]).join(' ');
    issuesNode.classList.toggle('seg-issues--on', issues.length > 0);
    saveButton.disabled = issues.length > 0;
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
