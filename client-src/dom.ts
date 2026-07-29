/**
 * Tiny DOM builders emitting design-kit classes.
 *
 * Written rather than using `trek.ui` so views stay testable without the bridge,
 * and so nothing here can accidentally create a `<form>` or an `<a href>` — a
 * second document load in this frame permanently kills the postMessage bridge
 * (PluginFrame.tsx:303), and the sandbox allows form submission.
 */

type Child = Node | string | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  if (opts.style) Object.assign(node.style, opts.style);
  for (const [key, value] of Object.entries(opts.attrs ?? {})) node.setAttribute(key, value);
  for (const [event, handler] of Object.entries(opts.on ?? {})) {
    if (handler) node.addEventListener(event, handler as EventListener);
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** Always `type="button"` — a bare <button> inside a form would submit it. */
export function button(
  label: string,
  opts: { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; onClick: () => void; title?: string; disabled?: boolean } ,
): HTMLButtonElement {
  const node = el('button', {
    class: `trek-btn${opts.variant ? ` trek-btn--${opts.variant}` : ''}`,
    text: label,
    ...(opts.title ? { title: opts.title } : {}),
    attrs: { type: 'button' },
    on: { click: () => opts.onClick() },
  });
  node.disabled = Boolean(opts.disabled);
  return node;
}

export function chip(text: string, modifier?: string): HTMLElement {
  return el('span', { class: `trek-chip${modifier ? ` ${modifier}` : ''}`, text });
}

export function title(text: string): HTMLElement {
  return el('div', { class: 'trek-title', text });
}

export function muted(text: string): HTMLElement {
  return el('p', { class: 'trek-muted', text });
}

/** A coloured dot standing for a leg's tone. */
export function toneDot(hex: string): HTMLElement {
  return el('span', { class: 'seg-dot', style: { backgroundColor: hex } });
}
