import { z } from 'zod';
import { mcpHttp, type McpHttpInput } from '../../transport.js';
import { FirstPartyUnauthorized } from '../host.js';
import type { GoogleEndpoints } from './endpoints.js';

/** A Google REST error the model may read: status and Google's own message, never a header or token. */
export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

/**
 * One access token's view of the Google REST APIs. Every request goes through
 * `mcpHttp`, so the SSRF guard, the redirect refusal, the 2 MiB cap and the
 * timeout all apply, and only to the static endpoints.
 */
export class GoogleApi {
  constructor(
    private readonly accessToken: string,
    readonly endpoints: GoogleEndpoints,
    private readonly privateNetwork: boolean,
    /**
     * The REST bases this connector may call — its OWN API only (B39). With
     * include_granted_scopes a Calendar token also carries any Gmail or Drive
     * scope the account granted before, so the token cannot be what confines
     * a connector to its surface; this list is.
     */
    private readonly bases: readonly string[],
  ) {}

  async json<T = Record<string, unknown>>(method: McpHttpInput['method'], base: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const response = await this.send(method, base, path, options.query, options.body === undefined ? undefined : {
      contentType: 'application/json', body: JSON.stringify(options.body),
    });
    if (!response.body) return {} as T;
    try { return JSON.parse(response.body) as T; }
    catch { throw new GoogleApiError(502, 'Google returned an unreadable response'); }
  }

  async text(base: string, path: string, query?: Query): Promise<{ contentType: string; body: string }> {
    const response = await this.send('GET', base, path, query);
    return { contentType: response.headers['content-type'] ?? '', body: response.body };
  }

  async raw(method: McpHttpInput['method'], base: string, path: string, query: Query, contentType: string, body: string): Promise<Record<string, unknown>> {
    const response = await this.send(method, base, path, query, { contentType, body });
    try { return JSON.parse(response.body) as Record<string, unknown>; }
    catch { throw new GoogleApiError(502, 'Google returned an unreadable response'); }
  }

  private async send(method: McpHttpInput['method'], base: string, path: string, query?: Query, payload?: { contentType: string; body: string }) {
    if (!this.bases.includes(base)) throw new Error('MCP connector may not call this Google API');
    const root = new URL(base.replace(/\/$/, ''));
    const url = new URL(root.href + path);
    // Belt to segment()'s braces: whatever the path held, the request stays under this connector's own base.
    if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname}/`)) throw new GoogleApiError(400, 'Invalid resource id');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    const response = await mcpHttp({
      url: url.href, method,
      headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json', ...(payload ? { 'content-type': payload.contentType } : {}) },
      ...(payload ? { body: payload.body } : {}),
    }, this.privateNetwork);
    if (response.status === 401) throw new FirstPartyUnauthorized();
    if (response.status < 200 || response.status >= 300) throw new GoogleApiError(response.status, googleMessage(response.body));
    return response;
  }
}

function googleMessage(body: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } | string; error_description?: unknown };
    const message = typeof value.error === 'object' ? value.error.message : value.error_description ?? value.error;
    if (typeof message === 'string' && message) return message.slice(0, 500);
  } catch { /* not JSON */ }
  return 'Google request failed';
}

/**
 * A path segment from model input. Encoded, so an id can never add a path or a
 * query; and never `.` or `..`, which URL parsing would resolve into a walk up
 * to the parent collection (update_event {eventId:'..'} would PATCH the calendar).
 */
export function segment(value: string): string {
  if (value === '' || value === '.' || value === '..') throw new GoogleApiError(400, 'Invalid resource id');
  return encodeURIComponent(value);
}

/** One tool the host exposes. `gate` names the definition gate that must be TRUE for it to exist. */
export interface GoogleTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  gate?: string;
  /** The Google scopes that let this tool work, ANY one of them. A connection granted none of them does not get the tool. */
  scopes: readonly string[];
  run(api: GoogleApi, input: z.infer<I>): Promise<unknown>;
}

export function tool<I extends z.ZodTypeAny>(value: GoogleTool<I>): GoogleTool {
  return value as unknown as GoogleTool;
}

/**
 * The JSON Schema `tools/list` advertises, derived from the same zod schema
 * `tools/call` validates with, so the two cannot drift. Only the shapes the
 * Google tools use are supported; anything else throws when the list is built.
 */
export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description ? { description: schema.description } : {};
  const def = schema._def as { typeName: string };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const required = Object.entries(shape).filter(([, child]) => !child.isOptional()).map(([key]) => key);
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, jsonSchema(child)])),
        ...(required.length ? { required } : {}), additionalProperties: false, ...description };
    }
    case 'ZodOptional': case 'ZodDefault': {
      const inner = jsonSchema((schema._def as { innerType: z.ZodTypeAny }).innerType);
      return { ...inner, ...description };
    }
    case 'ZodString': {
      const checks = (schema._def as { checks: { kind: string; value?: number }[] }).checks;
      const max = checks.find(check => check.kind === 'max')?.value;
      const min = checks.find(check => check.kind === 'min')?.value;
      return { type: 'string', ...(min !== undefined ? { minLength: min } : {}), ...(max !== undefined ? { maxLength: max } : {}), ...description };
    }
    case 'ZodNumber': {
      const checks = (schema._def as { checks: { kind: string; value?: number }[] }).checks;
      const max = checks.find(check => check.kind === 'max')?.value;
      const min = checks.find(check => check.kind === 'min')?.value;
      return { type: checks.some(check => check.kind === 'int') ? 'integer' : 'number',
        ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}), ...description };
    }
    // refine(): the advertised shape is the inner one; the refinement is enforced on call.
    case 'ZodEffects': return { ...jsonSchema((schema._def as { schema: z.ZodTypeAny }).schema), ...description };
    case 'ZodBoolean': return { type: 'boolean', ...description };
    case 'ZodEnum': return { type: 'string', enum: (schema._def as { values: string[] }).values, ...description };
    case 'ZodArray': {
      const { type, maxLength } = schema._def as { type: z.ZodTypeAny; maxLength?: { value: number } };
      return { type: 'array', items: jsonSchema(type), ...(maxLength ? { maxItems: maxLength.value } : {}), ...description };
    }
    default: throw new Error(`unsupported tool schema: ${def.typeName}`);
  }
}
