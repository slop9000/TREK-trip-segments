// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderDetailPanel } from '../../client-src/views/detail';
import type { DetailPayload, SegmentView } from '../../src/shared/types';

/**
 * `blur_booking_codes` is a privacy setting TREK honours everywhere it prints a
 * confirmation code. TREK 4 forwards it to plugin frames on `trek:context`, so
 * a tab that ignored it would be the one place in the app that leaks a code the
 * user asked to keep covered.
 */
function setContext(formats: Record<string, unknown> | undefined): void {
  (window as unknown as { trek?: unknown }).trek = {
    context: formats ? { formats } : {},
    onContext: () => () => {},
    onEvent: () => () => {},
    invoke: async () => ({}),
    notify: () => {},
    confirm: async () => true,
    resize: () => {},
    session: { get: async () => undefined, set: async () => {} },
  };
}

const segment: SegmentView = {
  id: 1,
  trip_id: 1,
  name: 'Tokyo',
  color: '#3b82f6',
  tone: 'default',
  start_day: 1,
  end_day: 3,
  created_at: 'x',
  updated_at: 'x',
  index: 0,
  status: 'ok',
  effStart: 1,
  effEnd: 3,
  effLength: 3,
  startDate: null,
  endDate: null,
};

const payload: DetailPayload = {
  segment,
  dayCount: 3,
  days: [],
  bookings: [
    {
      id: 10,
      title: 'Shinkansen',
      type: 'train',
      status: 'confirmed',
      time: '2026-04-02T09:00:00',
      confirmation: 'ABC123',
      fromPos: 1,
      toPos: 1,
      spansLegs: false,
    },
  ],
  stays: [
    {
      id: 20,
      placeName: 'Hotel Okura',
      address: null,
      checkIn: '15:00',
      checkOut: '11:00',
      confirmation: 'STAY999',
      fromPos: 1,
      toPos: 3,
      nights: 2,
      bookingTitles: [],
    },
  ],
};

function render(): HTMLElement {
  const node = document.createElement('div');
  renderDetailPanel(node, segment, payload, () => {});
  return node;
}

afterEach(() => {
  delete (window as unknown as { trek?: unknown }).trek;
});

describe('booking codes honour blur_booking_codes', () => {
  it('blurs both the booking and the stay code when the setting is on', () => {
    setContext({ blurBookingCodes: true });
    const codes = [...render().querySelectorAll('.seg-code')].map((n) => n.textContent);
    expect(codes).toEqual(['ABC123', 'STAY999']);
  });

  it('makes a blurred code revealable, and it starts covered', () => {
    setContext({ blurBookingCodes: true });
    const code = render().querySelector<HTMLButtonElement>('.seg-code');

    expect(code?.classList.contains('seg-code--on')).toBe(false);
    code?.click();
    expect(code?.classList.contains('seg-code--on')).toBe(true);
  });

  it('leaves codes as plain inert text when the setting is off', () => {
    setContext({ blurBookingCodes: false });
    const node = render();

    expect(node.querySelectorAll('.seg-code')).toHaveLength(0);
    expect(node.textContent).toContain('ABC123');
    expect(node.textContent).toContain('STAY999');
  });

  it('does not blur on a host that sends no formats at all', () => {
    setContext(undefined);
    const node = render();

    expect(node.querySelectorAll('.seg-code')).toHaveLength(0);
    expect(node.textContent).toContain('ABC123');
  });

  // The code must never be joined into the detail line: a blur has to cover the
  // code and nothing else, and joining it would blur the dates with it.
  it('keeps the code out of the joined detail string', () => {
    setContext({ blurBookingCodes: true });
    const meta = render().querySelector('.seg-row-meta span');

    expect(meta?.textContent).not.toContain('ABC123');
  });
});
