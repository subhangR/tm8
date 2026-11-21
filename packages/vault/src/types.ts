import type { SecretMaterial } from './secret-material.js';
import type { CapturePayload } from './capture/payload.js';
import type { OriginRefusalCode } from './origin/normalize.js';

/**
 * Seams between the broker core and the components built in parallel
 * workstreams. The broker core owns authorization, approvals, audit and alerts.
 * A component owns only its mechanism, and it reports refusals by THROWING or
 * RETURNING a typed code. It never audits, alerts, logs a value or decides
 * policy by itself. That keeps every authority decision in one place (MSG 11)
 * and lets each mechanism be tested without a database.
 *
 * Hard rules for every implementation of these interfaces:
 * - Never log, throw, or return a secret, a token, a cookie, a full URL with a
 *   query string, or PII (R5, R12). Error `message`s are fixed strings.
 * - Dispose of every `SecretMaterial` you create, in a `finally`. Never dispose
 *   one you were handed; the caller owns it.
 * - Never write to disk (MSG 5D). Use memory only.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type VaultMode = 'off' | 'dev' | 'pre_review' | 'production';

/** A set of planted decoy values (MSG 2 canaries, failure case 10, acceptance test 10). */
export interface CanarySet {
  readonly size: number;
  /** True when `data` contains any canary in any encoding the filter knows (raw, base64, base64url, hex, URL, JSON-escaped). */
  matches(data: string | Buffer): boolean;
}

// ---------------------------------------------------------------------------
// WS-B: egress executor and response filter (src/egress/**, src/filter/**)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** connector = a vetted template (default). generic = owner-entered hosts; the UI labels it weaker (MSG 5C). */
export type EgressMode = 'connector' | 'generic';

export type KeyInjection =
  | { kind: 'bearer' }
  | { kind: 'header'; name: string; prefix?: string }
  | { kind: 'basic'; username: string }
  /** Generic mode only. The key appears in the request URL; upstream logs may keep it. */
  | { kind: 'query'; name: string };

/** BrokerPolicy(key_id, hosts, methods, path_prefixes, max_body) from MSG 11, plus injection and limits. */
export interface BrokerPolicy {
  keyId: string;
  version: number;
  mode: EgressMode;
  connector: string | null;
  /** Exact lowercase ASCII hostnames. No wildcards and no ports other than 443. */
  hosts: readonly string[];
  methods: readonly HttpMethod[];
  /** Each starts with `/`. Matched per path SEGMENT after normalisation: `/v1/x` allows `/v1/x/y`, not `/v1/xy`. */
  pathPrefixes: readonly string[];
  maxRequestBytes: number;
  maxResponseBytes: number;
  injection: KeyInjection;
}

export type ApiRequestBody = { kind: 'json'; value: unknown } | { kind: 'text'; value: string; contentType?: string };

/** What an agent may ask for. It never contains the key: the executor injects it. */
export interface ApiRequestSpec {
  method: HttpMethod;
  /** Absolute https URL. A query is allowed; credentials and fragments are refused. */
  url: string;
  /** Agent headers. Authorization, Cookie, Proxy-*, Host, Forwarded, X-Forwarded-*, method/URL overrides, client-address claims and the injection header are refused. */
  headers?: Readonly<Record<string, string>>;
  body?: ApiRequestBody;
}

export type ApiResponseBody =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; value: string }
  | { kind: 'empty' }
  | { kind: 'withheld'; reason: 'canary' | 'too_large' | 'binary' };

export interface ApiResponseOutcome {
  status: number;
  /** Allowlisted response headers only, lowercase names. Set-Cookie is never included. */
  headers: Record<string, string>;
  body: ApiResponseBody;
  /** Count of spans replaced with `[redacted]` (the key in any encoding, or a credential-shaped token). */
  redactions: number;
}

export type EgressRefusalCode =
  /** Unparseable URL, a fragment, a port other than 443, an encoded slash, backslash or NUL in the path, or a path parameter (`;`). */
  | 'url_refused'
  | 'scheme_refused'
  | 'credentials_in_url'
  | 'host_not_allowed'
  /** Off the policy's method list, or a method override field (`_method`, `_HttpMethod` and kin) in the query or a form/multipart/JSON body. */
  | 'method_not_allowed'
  | 'path_not_allowed'
  | 'token_management_denied'
  /** Connector mode: no vetted operation of the template has this method and path (F02). */
  | 'operation_not_allowed'
  /** Connector mode: the query or body breaks the matched operation's schema (F02). */
  | 'request_schema_refused'
  /** A GraphQL, JSON-RPC, XML-RPC/SOAP or batch request, which hides the real operation (F02). Refused in both modes. */
  | 'multiplexer_refused'
  /** A blocked or duplicate header; in connector mode also any agent header the template does not list, or a failed value rule. */
  | 'header_refused'
  | 'body_too_large'
  | 'private_address'
  | 'dns_failed'
  | 'redirect_refused'
  /** The agent-supplied URL, headers or body carry a planted canary. */
  | 'canary_in_request'
  | 'upstream_unreachable'
  | 'timeout';

/** The ONLY error type an executor may throw for a policy decision. `message` is fixed; no request data. */
export class EgressRefusal extends Error {
  constructor(readonly code: EgressRefusalCode) {
    super(`egress refused: ${code}`);
    this.name = 'EgressRefusal';
  }
}

export interface EgressExecuteInput {
  operationId: string;
  policy: BrokerPolicy;
  /** Canonical JSON `{"key": "..."}` from the item. Owned by the caller. */
  key: SecretMaterial;
  request: ApiRequestSpec;
  canaries: CanarySet;
  signal?: AbortSignal;
}

export interface EgressExecutor {
  /**
   * Validates the request against the policy, resolves and PINS the
   * destination address (reusing `@tm8/integrations` outbound-guard), injects
   * the key, sends it, refuses any redirect, and filters the response. Throws
   * EgressRefusal for every policy decision.
   */
  execute(input: EgressExecuteInput): Promise<ApiResponseOutcome>;
}

/**
 * Finds credential-shaped spans (provider tokens, private keys, JWTs) in text.
 * WS-E's paste detector provides the production implementation (high-confidence
 * findings only). The response filter takes it as input so that the two
 * workstreams share one pattern set and nobody duplicates it.
 */
export type TokenSpanScanner = (text: string) => readonly { start: number; end: number }[];

export interface ResponseFilterInput {
  /** Upstream status, copied to the outcome unchanged. */
  status: number;
  /** The DECODED body (after any content-encoding). The executor enforces the size cap while decoding. */
  body: Buffer;
  contentType: string | null;
  /** Raw upstream response headers, lowercase names. The filter applies the allowlist. */
  headers: Readonly<Record<string, string>>;
  key: SecretMaterial;
  canaries: CanarySet;
  maxBytes: number;
  scanTokens?: TokenSpanScanner;
}

/**
 * Pure function. It never throws for content: the upstream call has already
 * happened, so the agent and the core must still see the status. A body that
 * carries a canary, is over `maxBytes`, or is not text comes back as
 * `{ kind: 'withheld', reason }`. The core alerts on `reason === 'canary'`.
 */
export type ResponseFilter = (input: ResponseFilterInput) => ApiResponseOutcome;

// ---------------------------------------------------------------------------
// WS-C: isolated fill worker (src/browser/**)
// ---------------------------------------------------------------------------

export interface FillIntent {
  operationId: string;
  itemId: string;
  /** The exact bound origin (normalized). The worker must see exactly this in the top frame. */
  origin: string;
  /** Page to open. Must be same-origin with `origin`; defaults to `origin + "/"`. */
  startUrl?: string;
  submit: boolean;
  /** The item's dev mode (an owner-approved property): allows http and localhost origins. False in every production item. */
  devMode: boolean;
}

export interface LoginMaterial {
  username: string | null;
  password: SecretMaterial;
  /** v1 leaves this null: TOTP autofill is v2 (MSG 15). */
  totp: SecretMaterial | null;
}

export interface MaskedScreenshot {
  mime: 'image/png';
  data: Buffer;
  width: number;
  height: number;
  /** Number of regions painted over: every form control, and any element whose text contains a filled value. */
  maskedRegions: number;
}

export type FillRefusalCode =
  /** Top frame is not EXACTLY the bound origin. Covers subdomains and lookalikes (tests 3 and 4). */
  | 'origin_mismatch'
  /** A navigation or redirect left the origin before or after the fill (test 6). */
  | 'cross_origin_redirect'
  /** The form's action resolves to another origin (test 6). */
  | 'cross_origin_form_action'
  /** The page or form action is not https (outside item dev mode). */
  | 'insecure_context'
  /** The only password field is inside a frame, not the top document. */
  | 'not_top_frame'
  | 'fields_not_found'
  | 'navigation_failed'
  | 'timeout'
  | 'browser_unavailable';

export type FillOutcome =
  | { ok: true; finalOrigin: string; submitted: boolean; screenshot: MaskedScreenshot | null }
  | { ok: false; code: FillRefusalCode; observedOrigin: string | null; screenshot: MaskedScreenshot | null };

export interface FillDriver {
  fill(input: { intent: FillIntent; material: LoginMaterial; signal?: AbortSignal }): Promise<FillOutcome>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WS-E: paste detection (src/paste/**) and import (src/import/**)
// ---------------------------------------------------------------------------

export type PasteKind =
  | 'private_key'
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'github_token'
  | 'gitlab_token'
  | 'openai_key'
  | 'anthropic_key'
  | 'google_api_key'
  | 'slack_token'
  | 'stripe_key'
  | 'twilio_key'
  | 'tm8_token'
  | 'jwt'
  | 'connection_string'
  /** A webhook URL whose path carries its own bearer secret (Discord, Teams and the like). Slack hooks stay `slack_token`. */
  | 'webhook_url'
  | 'card_number'
  | 'password_assignment'
  | 'generic_secret_assignment'
  | 'high_entropy';

export interface PasteFinding {
  kind: PasteKind;
  /** UTF-16 offsets into the scanned text. */
  start: number;
  end: number;
  confidence: 'high' | 'medium';
}

export interface PasteScanResult {
  findings: PasteFinding[];
  /** The text with every finding replaced by `[redacted:<kind>]`. Equal to the input when there are no findings. */
  redacted: string;
}

export interface PasteDetector {
  scan(text: string): PasteScanResult;
}

/** MSG 12 exposure tiers. a = exposed (rotate on import, blocked until rotated). b = plaintext under the owner's control. c = unknown, treated as b and noted in audit. */
export type ExposureTier = 'a' | 'b' | 'c';

export type ImportFormat = 'chrome_csv' | 'firefox_csv' | 'safari_csv' | 'bitwarden_csv' | 'bitwarden_json' | 'onepassword_csv' | 'generic_csv';

/** What the owner sees per row in the import preview. Metadata only. */
export interface ImportCandidate {
  index: number;
  type: 'login' | 'note' | 'card';
  name: string;
  /** Normalized exact origin, or null with `originError` when the row's URL is unusable. */
  origin: string | null;
  originError?: OriginRefusalCode;
  username: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  /** Index of an earlier candidate with the same origin and username. */
  duplicateOf?: number;
  /** Fixed-vocabulary warnings, e.g. `http_origin`, `missing_password`, `cvv_column_dropped`. */
  warnings: string[];
}

export interface ImportParseResult {
  format: ImportFormat;
  candidates: ImportCandidate[];
  /**
   * Parallel to `candidates`. SECRET: stays inside the broker process, is
   * never serialized, and is dropped (and its buffers zeroized) when the import
   * session ends.
   */
  payloads: CapturePayload[];
  /** Rows dropped entirely, by fixed reason code. */
  skipped: { index: number; reason: string }[];
}

export interface ImportParser {
  /** `bytes` is the decrypted export. The parser must not keep a reference to it after returning. */
  parse(bytes: Buffer, hint?: ImportFormat): ImportParseResult;
}
