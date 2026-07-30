import type { Tone } from './host-types';

/**
 * Day tints accept arbitrary #rrggbb colours. The map and day-schedule banner
 * contracts still accept only TREK's four semantic tones, so each colour also
 * has a nearest-tone fallback for those surfaces.
 */
export interface Swatch {
  hex: string;
  label: string;
}

export const PALETTE: readonly Swatch[] = [
  { hex: '#4F46E5', label: 'Indigo' },
  { hex: '#10B981', label: 'Emerald' },
  { hex: '#F59E0B', label: 'Amber' },
  { hex: '#EF4444', label: 'Red' },
  { hex: '#0EA5E9', label: 'Sky' },
  { hex: '#8B5CF6', label: 'Violet' },
  { hex: '#14B8A6', label: 'Teal' },
  { hex: '#EC4899', label: 'Pink' },
];

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

const HEX_BY_TONE: Readonly<Record<Tone, string>> = {
  default: '#4F46E5',
  success: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

export function isTone(value: unknown): value is Tone {
  return value === 'default' || value === 'success' || value === 'warn' || value === 'danger';
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value);
}

/** Validate and canonicalise a host-safe colour. */
export function normalizeHexColor(value: unknown): string | null {
  return isHexColor(value) ? value.toUpperCase() : null;
}

export function hexForTone(tone: Tone): string {
  return HEX_BY_TONE[tone] ?? HEX_BY_TONE.default;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Best available fallback for host surfaces that have not gained a colour
 * channel yet. This never changes the colour stored or shown by this plugin.
 */
export function toneForColor(color: string): Tone {
  const normalized = normalizeHexColor(color) ?? HEX_BY_TONE.default;
  const [r, g, b] = rgb(normalized);
  let best: Tone = 'default';
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const tone of ['default', 'success', 'warn', 'danger'] as const) {
    const [tr, tg, tb] = rgb(HEX_BY_TONE[tone]);
    const distance = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (distance < bestDistance) {
      best = tone;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Design-kit chip modifier for a tone. Note the mismatch: the host's tone enum
 * says `warn` but the kit's CSS class is `--warning` (plugin-sdk/src/ui/kit.ts),
 * which is exactly the kind of thing that silently renders unstyled.
 */
export function toneChipClass(tone: Tone): string {
  return tone === 'warn' ? 'trek-chip--warning' : `trek-chip--${tone}`;
}

/** A segment colour as a translucent fill for calendar cells. */
export function colorFill(color: string, alpha: number): string {
  const [r, g, b] = rgb(normalizeHexColor(color) ?? HEX_BY_TONE.default);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Backward-compatible helper for tone-based callers. */
export function toneFill(tone: Tone, alpha: number): string {
  return colorFill(hexForTone(tone), alpha);
}

/** The colour a new leg gets — cycles all presets so consecutive legs differ. */
export function suggestColor(existingCount: number): string {
  return PALETTE[existingCount % PALETTE.length]!.hex;
}
