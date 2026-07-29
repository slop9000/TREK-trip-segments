import type { Tone } from './host-types';

/**
 * The palette is exactly TREK's own four tone colours, verified identical in
 * client/src/components/Map/MapPluginLayers.tsx:16-21 and
 * client/src/components/Plugins/PluginDaySchedule.tsx:13-18.
 *
 * That is the whole point: the map, the day plan and the trip card accept only
 * a four-value tone enum and have no hex channel at all. By offering exactly
 * those four colours we guarantee a leg looks the same in our tab as it does on
 * the map — instead of letting someone pick a colour we then silently round to
 * something else.
 */
export interface Swatch {
  tone: Tone;
  hex: string;
  label: string;
}

export const PALETTE: readonly Swatch[] = [
  { tone: 'default', hex: '#4F46E5', label: 'Indigo' },
  { tone: 'success', hex: '#10b981', label: 'Emerald' },
  { tone: 'warn', hex: '#f59e0b', label: 'Amber' },
  { tone: 'danger', hex: '#ef4444', label: 'Red' },
];

const HEX_BY_TONE = new Map<Tone, string>(PALETTE.map((s) => [s.tone, s.hex]));

export function isTone(value: unknown): value is Tone {
  return value === 'default' || value === 'success' || value === 'warn' || value === 'danger';
}

export function hexForTone(tone: Tone): string {
  return HEX_BY_TONE.get(tone) ?? '#4F46E5';
}

/**
 * Design-kit chip modifier for a tone. Note the mismatch: the host's tone enum
 * says `warn` but the kit's CSS class is `--warning` (plugin-sdk/src/ui/kit.ts),
 * which is exactly the kind of thing that silently renders unstyled.
 */
export function toneChipClass(tone: Tone): string {
  return tone === 'warn' ? 'trek-chip--warning' : `trek-chip--${tone}`;
}

/**
 * A tone as a translucent fill. Used for calendar day cells, where a solid leg
 * colour would swamp the text — and mixing with a fixed white/grey would break
 * in dark mode, whereas alpha composites over whatever the theme provides.
 */
export function toneFill(tone: Tone, alpha: number): string {
  const hex = hexForTone(tone);
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The tone a new leg gets — cycles the palette so consecutive legs differ. */
export function suggestTone(existingCount: number): Tone {
  return PALETTE[existingCount % PALETTE.length]!.tone;
}
