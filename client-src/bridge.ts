/**
 * The only file that knows the host bridge's quirks.
 *
 * `window.trek` is installed by the design kit, which the `<!-- trek:ui -->`
 * marker in client/index.html expands into. If that marker is ever lost the
 * page renders blank with an empty console, so `trek()` turns that into a
 * visible message instead.
 */

export interface TrekContext {
  /** Arrives as a STRING (PluginFrame.tsx:264) — never a number. */
  tripId?: string | null;
  userId?: string | null;
  theme?: 'light' | 'dark';
  locale?: string;
}

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Defaults to TRUE host-side, so pass it explicitly at every call site. */
  danger?: boolean;
}

interface SessionScope {
  scope?: 'plugin' | 'trip';
}

interface TrekApi {
  onContext(cb: (ctx: TrekContext) => void): () => void;
  /** Fires with the event NAME only — there is never a payload. */
  onEvent(cb: (event: string, tripId: string) => void): () => void;
  invoke<T = unknown>(sub: string, opts?: { method?: string; body?: unknown }): Promise<T>;
  /** Positional, not an options object. */
  notify(level: 'info' | 'success' | 'warning' | 'error', message: string, duration?: number): void;
  confirm(opts: ConfirmOptions | string): Promise<boolean>;
  resize(px: number): void;
  session: {
    get<T = unknown>(key: string, opts?: SessionScope): Promise<T | undefined>;
    set(key: string, value: unknown, opts?: SessionScope): Promise<void>;
  };
}

let missingKitReported = false;

function reportMissingKit(): void {
  if (missingKitReported) return;
  missingKitReported = true;
  const root = document.getElementById('seg-root');
  if (root) {
    root.className = 'seg-boot-error';
    root.textContent =
      'Trip Segments could not reach TREK. The plugin was built without its design kit, so nothing on this tab can load. Reinstall or repack the plugin.';
  }
}

export function trek(): TrekApi {
  const api = (window as unknown as { trek?: TrekApi }).trek;
  if (!api) {
    reportMissingKit();
    throw new Error('window.trek is unavailable');
  }
  return api;
}

export function hasTrek(): boolean {
  return Boolean((window as unknown as { trek?: TrekApi }).trek);
}

/** An invoke failure, carrying the only thing that survives the bridge: the status. */
export class ApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * Call one of our own routes. `sub` is relative to `/api/plugins/trip-segments`.
 *
 * A plain `fetch()` cannot be used from this frame at all: it runs at an opaque
 * origin and the CSP's `connect-src 'self'` matches nothing there.
 */
export async function api<T>(sub: string, init?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await trek().invoke<T>(sub, init);
  } catch (err) {
    const code = (err as { code?: number | string }).code ?? 'error';
    throw new ApiError(code, err instanceof Error ? err.message : 'request failed');
  }
}

/**
 * The complete error vocabulary available to us. The host forwards only the
 * status code and axios's generic message, so anything more specific has to
 * come from the client-side validator before the request is ever made.
 */
export function messageFor(code: number | string): string {
  switch (code) {
    case 400:
    case 422:
      return 'That leg is not valid. Check the days and name.';
    case 401:
      return 'Your session expired. Reload TREK and try again.';
    case 404:
      return 'This trip is no longer available.';
    case 409:
      return 'The legs changed somewhere else. Reloading.';
    default:
      return 'Trip Segments did not respond. Try again.';
  }
}

export function notify(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  try {
    trek().notify(level, message);
  } catch {
    /* the tab is already showing the boot error */
  }
}

export async function confirmDanger(opts: ConfirmOptions): Promise<boolean> {
  try {
    return await trek().confirm({ ...opts, danger: true });
  } catch {
    return false;
  }
}

/**
 * Tell the host how tall we are.
 *
 * A trip-page tab pins the iframe to 100% and IGNORES this (PluginFrame.tsx:360),
 * so it is a no-op where the plugin actually ships. It matters for
 * `trek-plugin dev`'s /preview — and therefore for the registry screenshot
 * `trek-plugin shot` captures — which sizes the frame from this message alone.
 *
 * The design kit also auto-reports on every body resize, but that observer races
 * our first async render and can leave the frame stuck at its 120px default.
 * Reporting explicitly after each render closes that race; both measure the same
 * document height now, so the two never disagree.
 */
export function reportHeight(): void {
  const height = document.documentElement.scrollHeight;
  if (height <= 0) return;
  try {
    trek().resize(height);
  } catch {
    /* no bridge, nothing to report to */
  }
}

/** Subscribe to trip context, handing back the numeric trip id. */
export function onTrip(cb: (tripId: number) => void): void {
  trek().onContext((ctx) => {
    const id = Number(ctx.tripId);
    if (Number.isInteger(id) && id > 0) cb(id);
  });
}

/** Remember something per trip. Values are capped at 1KB host-side. */
export async function rememberForTrip(key: string, value: unknown): Promise<void> {
  try {
    await trek().session.set(key, value, { scope: 'trip' });
  } catch {
    /* session storage is a convenience, never a requirement */
  }
}

export async function recallForTrip<T>(key: string): Promise<T | undefined> {
  try {
    return await trek().session.get<T>(key, { scope: 'trip' });
  } catch {
    return undefined;
  }
}
