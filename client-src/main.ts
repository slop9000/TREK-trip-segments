import { api, confirmDanger, onTrip, recallForTrip, rememberForTrip, reportHeight, trek } from './bridge';
import {
  collapseDetail,
  getState,
  isRelevantEvent,
  loadDetail,
  mutate,
  reconcileExpanded,
  refreshNow,
  scheduleRefresh,
  setState,
  subscribe,
} from './store';
import { mountShell, renderShell } from './views/shell';
import { resetDetailExpansion } from './views/detail';
import { resolveAll, uncoveredRanges } from '../src/shared/drift';
import { suggestTone } from '../src/shared/palette';
import type { DayIndex, OverviewPayload, SegmentInput, SegmentRow, SegmentView } from '../src/shared/types';
import type { ShellActions } from './views/shell';

const LAST_SEGMENT_KEY = 'openSegment';
const VIEW_KEY = 'view';

/** Rebuild the day index client-side so optimistic updates resolve exactly as the server would. */
function indexFromOverview(data: OverviewPayload): DayIndex {
  const posByDayId = new Map<number, number>();
  for (const day of data.days) posByDayId.set(day.id, day.pos);
  return {
    count: data.dayCount,
    posByDayId,
    dayIdByPos: data.days.map((d) => d.id),
    dateByPos: data.days.map((d) => d.date),
  };
}

/**
 * Recompute an overview from a modified row set using the SAME resolution code
 * the server runs, so an optimistic view can never disagree with the reconciled
 * one about status, clipping or coverage.
 */
function withRows(data: OverviewPayload, rows: SegmentRow[]): OverviewPayload {
  const segments = resolveAll(rows, indexFromOverview(data));
  return { ...data, segments, uncovered: uncoveredRanges(segments, data.dayCount) };
}

/** A new leg defaults to the first stretch of days that is not spoken for. */
function defaultDraft(data: OverviewPayload): SegmentInput {
  const gap = data.uncovered[0];
  const start = gap ? gap[0] : 1;
  const end = gap ? gap[1] : Math.max(start, Math.min(data.dayCount, start));
  return { name: '', tone: suggestTone(data.segments.length), start_day: start, end_day: end };
}

function draftFrom(view: SegmentView): SegmentInput {
  return { name: view.name, tone: view.tone, start_day: view.start_day, end_day: view.end_day };
}

const actions: ShellActions = {
  onCreate() {
    const data = getState().overview;
    if (!data) return;
    setState({ editor: { mode: 'create', draft: defaultDraft(data), issues: [] } });
  },

  onEdit(view) {
    setState({ editor: { mode: 'edit', id: view.id, draft: draftFrom(view), issues: [] } });
  },

  async onDelete(view) {
    const confirmed = await confirmDanger({
      title: 'Delete this leg?',
      message: `"${view.name}" will be removed. The days, bookings and stays inside it are not affected.`,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;

    const tripId = getState().tripId;
    if (tripId === null) return;

    await mutate({
      optimistic: (current) =>
        current.overview
          ? { overview: withRows(current.overview, current.overview.segments.filter((s) => s.id !== view.id)) }
          : {},
      call: () => api(`/segments?tripId=${tripId}&id=${view.id}`, { method: 'DELETE' }),
      successMessage: 'Leg deleted.',
    });

    reconcileExpanded();
  },

  onToggle(view) {
    if (getState().expandedId === view.id) actions.onClose();
    else actions.onOpenById(view.id);
  },

  onOpenById(id) {
    if (getState().expandedId === id) {
      actions.onClose();
      return;
    }
    resetDetailExpansion();
    void rememberForTrip(LAST_SEGMENT_KEY, id);
    void loadDetail(id);
  },

  onClose() {
    resetDetailExpansion();
    void rememberForTrip(LAST_SEGMENT_KEY, 0);
    collapseDetail();
  },

  async onSave(input, id) {
    const tripId = getState().tripId;
    if (tripId === null) return;

    const editing = id !== undefined;
    const ok = await mutate({
      optimistic: (current) => {
        if (!current.overview) return {};
        const rows: SegmentRow[] = current.overview.segments.map((s) => ({ ...s }));
        if (editing) {
          const target = rows.find((r) => r.id === id);
          if (target) Object.assign(target, input);
        } else {
          // A placeholder id keeps the strip and list in sync until the real row
          // arrives; the reconcile that follows replaces it either way.
          rows.push({
            ...input,
            id: -Date.now(),
            trip_id: tripId,
            created_at: '',
            updated_at: '',
          });
        }
        return { overview: withRows(current.overview, rows), editor: null };
      },
      call: () =>
        editing
          ? api('/segments', { method: 'PUT', body: { tripId, id, ...input } })
          : api('/segments', { method: 'POST', body: { tripId, ...input } }),
      successMessage: editing ? 'Leg updated.' : 'Leg added.',
    });

    if (!ok) setState({ editor: { mode: editing ? 'edit' : 'create', ...(id !== undefined ? { id } : {}), draft: input, issues: [] } });
  },

  onCancelEdit() {
    setState({ editor: null });
  },

  onSetView(view) {
    if (getState().view === view) return;
    setState({ view });
    void rememberForTrip(VIEW_KEY, view);
  },

};

function boot(): void {
  const root = document.getElementById('seg-root');
  if (!root) return;

  let bridge: ReturnType<typeof trek>;
  try {
    bridge = trek();
  } catch {
    return; // the bridge already rendered a visible explanation
  }

  mountShell(root, actions);
  subscribe((state) => {
    renderShell(state);
    requestAnimationFrame(reportHeight); // after layout settles
  });
  renderShell(getState());
  requestAnimationFrame(reportHeight);

  onTrip((tripId) => {
    if (getState().tripId === tripId) return;
    setState({ tripId, expandedId: null, overview: null, detail: null, editor: null, loading: true });

    void refreshNow().then(async () => {
      // Come back to whichever leg was open last time this trip was viewed.
      const savedView = await recallForTrip<string>(VIEW_KEY);
      if (savedView === 'calendar' || savedView === 'list') setState({ view: savedView });

      const last = await recallForTrip<number>(LAST_SEGMENT_KEY);
      if (typeof last === 'number' && last > 0 && getState().overview?.segments.some((s) => s.id === last)) {
        actions.onOpenById(last);
      }
    });
  });

  // Names only ever arrive — no payload — so any relevant event just triggers a
  // debounced refetch rather than a targeted patch.
  bridge.onEvent((event) => {
    if (isRelevantEvent(event)) scheduleRefresh();
  });
}

boot();
