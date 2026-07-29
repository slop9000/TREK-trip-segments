import type { PluginContext, PluginRequest, PluginResponse } from '../shared/host-types';

/**
 * Status codes are the ONLY thing that reaches the UI: the iframe bridge
 * forwards `err.response?.status` and axios's generic message, discarding our
 * response body entirely (PluginFrame.tsx:368). The bodies below are still
 * worth sending — they show up in curl and in the dev dashboard — but the
 * client must never depend on them, which is why the real validation messages
 * come from the shared validator running client-side.
 */
export function json(status: number, body: unknown): PluginResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const badRequest = (detail: string): PluginResponse => json(400, { error: 'bad_request', detail });
export const notFound = (): PluginResponse => json(404, { error: 'not_found' });
export const conflict = (detail: string): PluginResponse => json(409, { error: 'conflict', detail });
export const unprocessable = (issues: string[]): PluginResponse => json(422, { error: 'invalid', issues });

type Handler = (req: PluginRequest, ctx: PluginContext) => Promise<PluginResponse>;

/**
 * A handler that throws is turned into a 502 "Plugin error" by the proxy
 * (plugins-proxy.controller.ts:164), which reads to the user as "the plugin is
 * broken" even for an ordinary transient failure. Wrapping every handler means
 * the worst we ever emit is a 500 we chose, and the reason is logged.
 */
export function guard(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      ctx.log.error('route failed', {
        path: req.path,
        method: req.method,
        message: err instanceof Error ? err.message : String(err),
      });
      return json(500, { error: 'internal' });
    }
  };
}

/** Express query values arrive as string | string[]; take the first usable one. */
function firstValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

/** A positive integer from the query string, or null. */
export function queryInt(query: Record<string, unknown>, key: string): number | null {
  const raw = firstValue(query[key]);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The request body as an object. Handles both parsed and still-stringified bodies. */
export function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === 'string' && body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** A positive integer from a body field, or null. */
export function bodyInt(body: Record<string, unknown>, key: string): number | null {
  const raw = body[key];
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Tell the trip that segments changed. Names only reach the frame — the payload
 * is dropped — so the client refetches rather than patching from the event.
 *
 * Never allowed to fail the write that triggered it.
 */
export async function announceChange(ctx: PluginContext, tripId: number): Promise<void> {
  try {
    await ctx.ws.broadcastToTrip(tripId, 'changed', {});
  } catch (err) {
    ctx.log.warn('broadcast failed', { tripId, message: err instanceof Error ? err.message : String(err) });
  }
}
