import {
  VAULT_INPUT_SCHEMAS, VAULT_OPERATIONS, VAULT_OUTPUT_SCHEMAS, VAULT_STEP_UP_ACTIONS,
  type VaultOperationName, type VaultStepUpAction, type VaultStepUpProof,
} from '@tm8/contract';
import {
  AuditUnavailableError, StoreDuplicateError, StoreNotFoundError, StoreStateError, StoreUnavailableError,
  StoreVersionConflictError, VAULT_COOKIE_NAMES, VAULT_REASON_STATUS, VaultError, actorOf, memberScope, systemClock,
  type AuditGate, type BrokerComponents, type BrokerConfig, type Clock, type HandlerContext, type HandlerResult,
  type OwnerAuth, type VaultCaller, type VaultCookies, type VaultHandlers, type VaultSetCookie, type VaultStore,
} from '../core-types.js';
import { KmsUnavailableError } from '../crypto/kms.js';
import { BrokerRateLimiter, rateClass } from './rate-limit.js';
import { matchVaultRoute, type VaultRoute } from '../relay/routes.js';

/** The relay and the broker share one route table (relay/routes.ts). */
export type BrokerRoute = VaultRoute;
export const matchBrokerRoute = matchVaultRoute;

export interface BrokerLog {
  op: VaultOperationName | null;
  status: number;
  ms: number;
  requestId: string;
}

export interface BrokerDependencies {
  config: BrokerConfig;
  store: VaultStore;
  auth: OwnerAuth;
  audit: AuditGate;
  components: BrokerComponents;
  handlers: VaultHandlers;
  clock?: Clock;
  rateLimiter?: BrokerRateLimiter;
  log?: (record: BrokerLog) => void;
}

export interface BrokerRequest {
  method: string;
  path: string;
  query: string;
  body: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  caller: VaultCaller;
  /**
   * The browser origin from the relay's signed attestation, or null. Human-only
   * commands decide on this and never on `headers.origin`: anything that can
   * reach the broker's socket can write that header, and the relay does not
   * forward it (independent review F04).
   */
  origin: string | null;
  requestId: string;
  signal: AbortSignal;
}

export interface BrokerResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[]>;
}

/** Only vault cookies are ever passed to OwnerAuth. Duplicate vault cookies are ambiguous and refused. */
export function parseVaultCookies(header: string | string[] | undefined): VaultCookies {
  const cookies: VaultCookies = { session: null, refresh: null };
  if (header === undefined) return cookies;
  if (typeof header !== 'string') throw new VaultError('invalid_input');
  const seen = new Set<string>();
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const key = name === VAULT_COOKIE_NAMES.session ? 'session' : name === VAULT_COOKIE_NAMES.refresh ? 'refresh' : null;
    if (!key) continue;
    if (seen.has(name)) throw new VaultError('invalid_input');
    seen.add(name);
    const value = part.slice(at + 1).trim();
    if (value.length > 256 || (value !== '' && !/^[A-Za-z0-9_-]+$/.test(value))) throw new VaultError('invalid_input');
    cookies[key] = value === '' ? null : value;
  }
  return cookies;
}

export function serializeVaultCookie(cookie: VaultSetCookie): string {
  if (![VAULT_COOKIE_NAMES.session, VAULT_COOKIE_NAMES.refresh].includes(cookie.name)
    || !Number.isSafeInteger(cookie.maxAgeSeconds) || cookie.maxAgeSeconds < 0
    || (cookie.value !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(cookie.value))) throw new VaultError('invariant_violation');
  const path = cookie.name === VAULT_COOKIE_NAMES.session ? '/v2/vault' : '/v2/vault/session';
  return `${cookie.name}=${cookie.value ?? ''}; Max-Age=${cookie.value === null ? 0 : cookie.maxAgeSeconds}; Path=${path}; HttpOnly; Secure; SameSite=Strict`;
}

export function mapBrokerError(error: unknown, audit: AuditGate): VaultError {
  if (error instanceof AuditUnavailableError) {
    audit.reportAppendFailure();
    return VaultError.reason('audit_unavailable');
  }
  if (error instanceof VaultError) return error;
  if (error instanceof StoreNotFoundError) return new VaultError('not_found');
  if (error instanceof StoreVersionConflictError) return new VaultError('version_conflict', null, { currentVersion: error.currentVersion });
  if (error instanceof StoreUnavailableError) return VaultError.reason('vault_unavailable');
  if (error instanceof KmsUnavailableError) return VaultError.reason('kms_unavailable');
  if (error instanceof StoreDuplicateError) return new VaultError('conflict');
  if (error instanceof StoreStateError) {
    if (error.state === 'wrong_item_type') return VaultError.reason('wrong_item_type');
    return new VaultError('conflict');
  }
  return new VaultError('invariant_violation');
}

/** Fixed, contract-shaped error envelope; lower-layer messages and arbitrary details never cross this boundary. */
export function brokerErrorResponse(error: VaultError, requestId: string): BrokerResponse {
  const [status, code] = error.reason ? VAULT_REASON_STATUS[error.reason] : [error.status, error.code];
  const details: Record<string, string | number> = {};
  if (error.reason) details.reason = error.reason;
  if (error.code === 'version_conflict' && Number.isSafeInteger(error.extra.currentVersion) && error.extra.currentVersion! > 0) details.currentVersion = error.extra.currentVersion!;
  if (error.code === 'rate_limited' && Number.isSafeInteger(error.extra.retryAfterSeconds) && error.extra.retryAfterSeconds! > 0) details.retryAfterSeconds = error.extra.retryAfterSeconds!;
  const message = status === 500 ? 'internal server error' : `vault: ${error.reason ?? code}`;
  return {
    status,
    body: JSON.stringify({ error: { code, message, ...(Object.keys(details).length ? { details } : {}), requestId,
      retryable: status === 429 || status === 503 } }),
    headers: details.retryAfterSeconds ? { 'retry-after': String(details.retryAfterSeconds) } : {},
  };
}

function parseInput(op: VaultOperationName, request: BrokerRequest): unknown {
  let raw: unknown;
  if (request.method === 'GET') {
    if (request.body.length !== 0) throw new VaultError('invalid_input');
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of new URLSearchParams(request.query)) {
      if (Object.hasOwn(values, key)) throw new VaultError('invalid_input');
      values[key] = value;
    }
    raw = values;
  } else {
    // In particular, a capture token sent in the query never reaches a handler.
    if (request.query !== '') throw new VaultError('invalid_input');
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw new VaultError('invalid_input');
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)); }
    catch { throw new VaultError('invalid_input'); }
  }
  const result = VAULT_INPUT_SCHEMAS[op].safeParse(raw);
  if (!result.success) throw new VaultError('invalid_input');
  return result.data;
}

export function createBrokerDispatcher(deps: BrokerDependencies): (request: BrokerRequest) => Promise<BrokerResponse> {
  const clock = deps.clock ?? systemClock;
  const limiter = deps.rateLimiter ?? new BrokerRateLimiter(clock);
  return async (request) => {
    let response: BrokerResponse;
    try {
      const route = matchBrokerRoute(request.method, request.path);
      if (!route) throw new VaultError('not_found');
      const { row, params } = route;
      const { config, auth, store, audit, components } = deps;
      if (config.mode === 'off') throw VaultError.reason('vault_disabled');
      if (config.mode === 'pre_review' && !request.caller.isSpaceAdmin) throw VaultError.reason('pre_review_limit');
      limiter.take(request.caller, rateClass(row.name, row.kind === 'read'));
      if (row.authority !== 'member' && request.caller.kind === 'agent') throw new VaultError('forbidden');
      if ('humanOnly' in row && row.humanOnly && row.kind === 'command') {
        // The relay attests an origin only for a browser session whose Origin the tm8 server accepted. The broker
        // still requires that origin to be one of its exact WebAuthn origins, so the check is not weakened.
        if (request.origin === null || !config.webauthn.origins.includes(request.origin)) throw new VaultError('forbidden');
      }
      if (row.name.startsWith('vault.imports.') && (config.mode === 'pre_review' || !config.features.import)) throw VaultError.reason('import_disabled');
      if (row.name.startsWith('vault.spend.')) throw VaultError.reason('spend_disabled');
      if ((row.name.startsWith('vault.captures.') || row.name === 'vault.captureLinks.create') && !config.features.capture) throw VaultError.reason('vault_disabled');
      if ((row.name === 'vault.fill' && !config.features.fill) || (row.name === 'vault.callApi' && !config.features.callApi)) throw VaultError.reason('vault_disabled');
      // Revoke remains available so a disabled sharing feature does not trap a grant.
      if (row.name === 'vault.grants.create' && !config.features.grants) throw new VaultError('forbidden');
      const cookies = parseVaultCookies(request.headers.cookie);
      const input = parseInput(row.name, request);
      let ownerSession = null;
      let stepUp = null;
      if (row.authority === 'owner_session' || row.authority === 'owner_step_up') {
        ownerSession = await auth.resolveSession(request.caller, cookies);
        if (!ownerSession || ownerSession.memberId !== request.caller.memberId || Date.parse(ownerSession.expiresAt) <= clock.now().getTime()) throw VaultError.reason('vault_session_required');
        if (row.authority === 'owner_step_up') {
          if (!(VAULT_STEP_UP_ACTIONS as readonly string[]).includes(row.name)) throw new VaultError('invariant_violation');
          stepUp = await auth.verifyStepUp(request.caller, ownerSession, (input as { stepUp?: VaultStepUpProof }).stepUp,
            { action: row.name as VaultStepUpAction, pathParams: params, body: input as Record<string, unknown> });
        }
      }
      if (config.mode === 'pre_review' && (row.name === 'vault.captures.submit' || row.name === 'vault.imports.commit')) {
        const count = await store.transaction(memberScope(request.caller), (tx) => tx.items.countOwned());
        if (count >= config.preReview.maxItemsPerMember) throw VaultError.reason('pre_review_limit');
      }
      if (request.signal.aborted) throw VaultError.reason('vault_unavailable');
      const ctx: HandlerContext = { op: row.name, requestId: request.requestId, caller: request.caller, actor: actorOf(request.caller),
        config, clock, store, auth, audit, components, ownerSession, stepUp, cookies, signal: request.signal };
      // The runtime row chooses both schema and handler. Erase the correlated generic only at this boundary.
      const handler = deps.handlers[row.name] as (ctx: HandlerContext, request: { params: Record<string, string>; input: unknown }) => Promise<HandlerResult<unknown>>;
      const result = await handler(ctx, { params, input });
      const output = VAULT_OUTPUT_SCHEMAS[row.name].safeParse(result.data);
      if (!output.success) throw new VaultError('invariant_violation');
      const cookiesOut = result.setCookies?.map(serializeVaultCookie);
      if (cookiesOut && new Set(result.setCookies!.map((cookie) => cookie.name)).size !== cookiesOut.length) throw new VaultError('invariant_violation');
      response = { status: 200, body: JSON.stringify({ data: output.data, requestId: request.requestId }), headers: cookiesOut?.length ? { 'set-cookie': cookiesOut } : {} };
    } catch (error) {
      response = brokerErrorResponse(mapBrokerError(error, deps.audit), request.requestId);
    }
    return sweepBrokerResponse(response, request, deps);
  };
}

/** Runs on errors as well as successes, before headers or body are written. */
export function sweepBrokerResponse(response: BrokerResponse, request: Pick<BrokerRequest, 'caller' | 'requestId'>, deps: BrokerDependencies): BrokerResponse {
  try {
    if (!deps.components.canaries.matches(Buffer.from(response.body, 'utf8'))
      && !deps.components.canaries.matches(JSON.stringify(response.headers))) return response;
    try {
      deps.components.alerts.raise({ kind: 'canary_detected', memberId: request.caller.memberId, spaceId: request.caller.spaceId,
        itemId: null, params: {}, at: (deps.clock ?? systemClock).now().toISOString() });
    } catch { /* An alert sink cannot turn a refusal into an outgoing value. */ }
  } catch { /* A failed scanner is also a refusal. */ }
  const refusal = brokerErrorResponse(new VaultError('invariant_violation'), request.requestId);
  try {
    if (!deps.components.canaries.matches(Buffer.from(refusal.body, 'utf8'))) return refusal;
  } catch { /* No unswept bytes leave if the scanner is unavailable. */ }
  return { status: 500, headers: {}, body: '' };
}
