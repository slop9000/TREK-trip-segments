import { ApiError, api, messageFor, notify } from './bridge';
import type { DetailPayload, OverviewPayload, SegmentInput } from '../src/shared/types';
import type { IssueCode } from '../src/shared/validate';

/** Calendar answers "which leg is this day in"; list answers "what is in this leg". */
export type ViewMode = 'calendar' | 'list';

export interface EditorState {
  mode: 'create' | 'edit';
  id?: number;
  draft: SegmentInput;
  issues: IssueCode[];
}

export interface AppState {
  tripId: number | null;
  view: ViewMode;
  /**
   * The leg whose contents are expanded in place, if any.
   *
   * Deliberately not a separate screen: opening a leg used to replace the whole
   * tab, which threw away the calendar and the strip and left a back link as the
   * only way home. Expanding keeps the surrounding context on screen.
   */
  expandedId: number | null;
  overview: OverviewPayload | null;
  detail: DetailPayload | null;
  editor: EditorState | null;
  loading: boolean;
  busy: boolean;
  banner: { level: 'error' | 'info'; text: string } | null;
}

let state: AppState = {
  tripId: null,
  view: 'calendar',
  expandedId: null,
  overview: null,
  detail: null,
  editor: null,
  loading: true,
  busy: false,
  banner: null,
};

const listeners = new Set<(s: AppState) => void>();

export function getState(): AppState {
  return state;
}

export function subscribe(fn: (s: AppState) => void): void {
  listeners.add(fn);
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

// ---------------------------------------------------------------------------
// Refresh / mutation coordination
//
// Our own writes broadcast back to our own frame, so a naive "refetch on every
// event" would race the write that caused it and repaint stale data. Three rules
// keep it honest:
//   1. a generation counter discards any fetch that began before a mutation;
//   2. a refresh only ARMS while a mutation is in flight, never fires;
//   3. a failed mutation restores a whole-state snapshot rather than trying to
//      invert a patch.
// ---------------------------------------------------------------------------

const REFRESH_DEBOUNCE_MS = 400;

let generation = 0;
let mutationsInFlight = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Trip events that can change what a leg contains. Core also emits collab,
 * budget, packing, file and todo events on the same channel; those fire often
 * and cannot affect us, so matching them would just cause pointless refetching.
 */
const RELEVANT_PREFIXES = ['day:', 'reservation:', 'accommodation:', 'place:', 'assignment:', 'itinerary:', 'trip:'];

export function isRelevantEvent(event: string): boolean {
  if (event.startsWith('plugin:trip-segments:')) return true;
  return RELEVANT_PREFIXES.some((prefix) => event.startsWith(prefix));
}

export function scheduleRefresh(): void {
  if (mutationsInFlight > 0) return; // rule 2 — the mutation's own reconcile covers it
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void refreshNow();
  }, REFRESH_DEBOUNCE_MS);
}

export async function refreshNow(): Promise<void> {
  const tripId = state.tripId;
  if (tripId === null) return;

  const mine = ++generation;
  try {
    const overview = await api<OverviewPayload>(`/overview?tripId=${tripId}`);
    if (mine !== generation) return; // rule 1 — something newer superseded us
    setState({ overview, loading: false, banner: null });
  } catch (err) {
    if (mine !== generation) return;
    setState({ loading: false, banner: { level: 'error', text: errorText(err) } });
  }
}

export async function loadDetail(id: number): Promise<void> {
  const tripId = state.tripId;
  if (tripId === null) return;

  setState({ expandedId: id, detail: null, banner: null });
  try {
    const detail = await api<DetailPayload>(`/segment-detail?tripId=${tripId}&id=${id}`);
    if (state.expandedId !== id) return; // collapsed, or a different leg opened
    setState({ detail });
  } catch (err) {
    setState({ banner: { level: 'error', text: errorText(err) } });
  }
}

export function collapseDetail(): void {
  setState({ expandedId: null, detail: null });
}

/** Keep an open leg in sync after a refresh, and close it if it disappeared. */
export function reconcileExpanded(): void {
  const id = state.expandedId;
  if (id === null) return;
  if (!state.overview?.segments.some((s) => s.id === id)) collapseDetail();
}

function errorText(err: unknown): string {
  return messageFor(err instanceof ApiError ? err.code : 'error');
}

export interface MutateOptions<T> {
  /** Applied immediately so the UI responds before the round trip. */
  optimistic?: (current: AppState) => Partial<AppState>;
  call: () => Promise<T>;
  successMessage?: string;
}

export async function mutate<T>(opts: MutateOptions<T>): Promise<boolean> {
  const snapshot = state;

  generation++; // discard any refresh already in flight
  mutationsInFlight++;
  setState({ busy: true, banner: null, ...(opts.optimistic ? opts.optimistic(snapshot) : {}) });

  let ok = false;
  try {
    await opts.call();
    ok = true;
    if (opts.successMessage) notify('success', opts.successMessage);
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'error';
    state = snapshot; // rule 3 — whole-state rollback
    setState({ banner: { level: 'error', text: messageFor(code) } });
  } finally {
    mutationsInFlight--;
    setState({ busy: false });
    // Reconcile with the server either way: on success to pick up recomputed
    // coverage, on failure because a 409 means our view was stale to begin with.
    if (mutationsInFlight === 0) void refreshNow();
  }

  return ok;
}
