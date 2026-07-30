import { MAX_TRIP_DAYS, NAME_MAX } from '../shared/limits';
import { routes } from './routes';
import type {
  PluginContext,
  PluginMcpTool,
  PluginRequest,
  PluginResponse,
  PluginRoute,
} from '../shared/host-types';

const TRIP_ID = {
  type: 'integer',
  minimum: 1,
  description: 'The TREK trip id. The calling user must be a member of the trip.',
} as const;

const SEGMENT_ID = {
  type: 'integer',
  minimum: 1,
  description: 'The segment id returned by list_trip_segments.',
} as const;

const SEGMENT_PROPERTIES = {
  name: {
    type: 'string',
    minLength: 1,
    maxLength: NAME_MAX,
    description: 'A short destination or leg name, such as Tokyo or Patagonia.',
  },
  tone: {
    type: 'string',
    enum: ['default', 'success', 'warn', 'danger'],
    description: 'The TREK colour tone: default (indigo), success (emerald), warn (amber), or danger (red).',
  },
  start_day: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_TRIP_DAYS,
    description: 'The inclusive 1-based position of the first trip day in the segment.',
  },
  end_day: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_TRIP_DAYS,
    description: 'The inclusive 1-based position of the last trip day in the segment.',
  },
} as const;

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function route(method: PluginRoute['method'], path: string): PluginRoute {
  const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`missing internal route ${method} ${path}`);
  return found;
}

function responseBody(response: PluginResponse): Record<string, unknown> {
  let body = response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return { data: body };
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : { data: body ?? null };
}

/**
 * Invoke the same route handler as the Segments UI. This keeps MCP access,
 * validation, overlap/limit guards, broadcasts and future route fixes on one
 * behaviour path instead of growing a privileged second implementation.
 */
async function invoke(
  method: PluginRoute['method'],
  path: string,
  input: Record<string, unknown>,
  ctx: PluginContext,
): Promise<Record<string, unknown>> {
  const query: Record<string, unknown> = {};
  if (method === 'GET' || method === 'DELETE') {
    for (const [key, value] of Object.entries(input)) query[key] = String(value);
  }

  const request: PluginRequest = {
    method,
    path,
    query,
    body: method === 'GET' || method === 'DELETE' ? null : input,
    headers: {},
    // Authentication has already happened at the MCP boundary. The acting
    // user is carried by ctx, which is what ctx.trips uses for membership.
    user: null,
  };
  const response = await route(method, path).handler(request, ctx);
  const payload = responseBody(response);
  const ok = response.status >= 200 && response.status < 300;
  return ok ? { ok: true, ...payload } : { ok: false, status: response.status, ...payload };
}

export const mcpTools: PluginMcpTool[] = [
  {
    name: 'list_trip_segments',
    description:
      'List a trip’s segments and its ordered days. Use before creating or changing a segment to choose valid, non-overlapping day positions.',
    inputSchema: {
      type: 'object',
      properties: { tripId: TRIP_ID },
      required: ['tripId'],
      additionalProperties: false,
    },
    annotations: READ_ANNOTATIONS,
    handler: (input, ctx) => invoke('GET', '/overview', input, ctx),
  },
  {
    name: 'get_trip_segment',
    description:
      'Get one trip segment with the days, bookings and accommodation stays that fall within it.',
    inputSchema: {
      type: 'object',
      properties: { tripId: TRIP_ID, id: SEGMENT_ID },
      required: ['tripId', 'id'],
      additionalProperties: false,
    },
    annotations: READ_ANNOTATIONS,
    handler: (input, ctx) => invoke('GET', '/segment-detail', input, ctx),
  },
  {
    name: 'create_trip_segment',
    description:
      'Create a non-overlapping segment over an inclusive range of trip-day positions. Call list_trip_segments first.',
    inputSchema: {
      type: 'object',
      properties: { tripId: TRIP_ID, ...SEGMENT_PROPERTIES },
      required: ['tripId', 'name', 'tone', 'start_day', 'end_day'],
      additionalProperties: false,
    },
    annotations: WRITE_ANNOTATIONS,
    handler: (input, ctx) => invoke('POST', '/segments', input, ctx),
  },
  {
    name: 'update_trip_segment',
    description:
      'Replace the name, colour and inclusive day range of an existing trip segment. All editable fields are required.',
    inputSchema: {
      type: 'object',
      properties: { tripId: TRIP_ID, id: SEGMENT_ID, ...SEGMENT_PROPERTIES },
      required: ['tripId', 'id', 'name', 'tone', 'start_day', 'end_day'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    handler: (input, ctx) => invoke('PUT', '/segments', input, ctx),
  },
  {
    name: 'delete_trip_segment',
    description:
      'Permanently delete one segment. This only removes the segment; it does not delete trip days, bookings or stays.',
    inputSchema: {
      type: 'object',
      properties: { tripId: TRIP_ID, id: SEGMENT_ID },
      required: ['tripId', 'id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input, ctx) => invoke('DELETE', '/segments', input, ctx),
  },
];
