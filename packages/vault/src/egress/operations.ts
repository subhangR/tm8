import type { ZodType } from 'zod';
import { boundedSafeParse } from '../bounded-parse.js';
import { EgressRefusal, type ApiRequestBody, type HttpMethod } from '../types.js';

/**
 * Connector operations (independent review F02).
 *
 * A connector policy used to mean only "this vendor's hosts, minus a deny list". The owner's
 * path prefixes did the rest, so a policy with `/` or `/graphql` reached every endpoint not on
 * the deny list, with any body. Now a connector request must match one vetted operation, and
 * each part of the request is checked against that operation:
 * - the method;
 * - the exact path;
 * - every query parameter;
 * - the body, against a strict schema;
 * - every agent header.
 * Anything not listed is refused.
 *
 * Every rule is a whole-value match. Matching wraps each one as `^(?:rule)$` without its `g`,
 * `m` or `y` flags, and `catalogProblems` also refuses a rule that is not anchored at both ends
 * or that carries those flags. What the broker checked is what it sends: a vetted operation's
 * query and form body go upstream re-serialized from the parsed pairs, and a JSON body is the
 * agent's value serialized once.
 */
export type ValueRule = RegExp;

export type OperationBody =
  /**
   * A JSON body, checked against `schema`. Unknown keys must fail: build every object with
   * `.strict()`. The broker sends the agent's value, not zod's output, so a stripping object
   * would pass a key it never checked.
   */
  | { kind: 'json'; schema: ZodType<unknown> }
  /** A form body. Each field is either named in `fields` or matches one `patterns` pair [name, value]. */
  | { kind: 'form'; fields: Readonly<Record<string, ValueRule>>; patterns?: readonly (readonly [ValueRule, ValueRule])[] };

export interface ConnectorOperation {
  /** Stable name, e.g. `issues.create`. It appears in tests and docs only. */
  id: string;
  method: HttpMethod;
  /** Exact path. `{name}` is one segment checked by `params[name]`. A final `{name+}` takes one or more segments. */
  path: string;
  params?: Readonly<Record<string, ValueRule>>;
  /** Allowed query parameters. Each may appear at most once. */
  query?: Readonly<Record<string, ValueRule>>;
  requiredQuery?: readonly string[];
  /** `null`: the request must have no body. */
  body: OperationBody | null;
}

const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)(\+?)\}$/;
const FORM_TYPE = /^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i;

const WHOLE = new WeakMap<ValueRule, RegExp>();

/** `check` as a whole-value match without state, whatever its own anchors and flags say. */
function whole(check: ValueRule): RegExp {
  let compiled = WHOLE.get(check);
  if (!compiled) {
    compiled = new RegExp(`^(?:${check.source})$`, check.flags.replace(/[gmy]/g, ''));
    WHOLE.set(check, compiled);
  }
  return compiled;
}

/** The rule registered under `name`, never an inherited property, as a whole-value match. */
function rule(rules: Readonly<Record<string, ValueRule>> | undefined, name: string): RegExp | undefined {
  return rules && Object.hasOwn(rules, name) ? whole(rules[name]!) : undefined;
}

/** A vetted operation's agent header: named by the template, and its value passes the template's rule. */
export function headerAllowed(headers: Readonly<Record<string, ValueRule>> | undefined, name: string, value: string): boolean {
  return rule(headers, name)?.test(value) ?? false;
}

function matchesPath(operation: ConnectorOperation, parts: readonly string[]): boolean {
  const template = operation.path.split('/');
  for (const [index, segment] of template.entries()) {
    const param = PARAM.exec(segment);
    if (!param) { if (parts[index] !== segment) return false; continue; }
    const check = rule(operation.params, param[1]!);
    if (!check) return false;
    if (param[2] === '+') {
      const rest = parts.slice(index);
      return rest.length > 0 && rest.every((part) => part !== '' && check.test(part));
    }
    const part = parts[index];
    if (part === undefined || part === '' || !check.test(part)) return false;
  }
  return parts.length === template.length;
}

/** The operation `method` and the decoded `path` name, or null. Literal segments match case-sensitively. */
export function matchOperation(operations: readonly ConnectorOperation[], method: HttpMethod, path: string): ConnectorOperation | null {
  const parts = path.split('/');
  return operations.find((operation) => operation.method === method && matchesPath(operation, parts)) ?? null;
}

/**
 * Throws `request_schema_refused` unless every query parameter is allowed, appears once and
 * passes its rule. Returns the query re-serialized from the checked pairs, which is what the
 * broker sends, so an upstream parser cannot read the raw query differently.
 */
export function checkQuery(operation: ConnectorOperation, url: URL): string {
  // A raw ';' separates parameters for some parsers (older Rack) but not for URLSearchParams.
  if (url.search.includes(';')) throw new EgressRefusal('request_schema_refused');
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    const check = rule(operation.query, name);
    if (seen.has(name) || !check || !check.test(value)) throw new EgressRefusal('request_schema_refused');
    seen.add(name);
  }
  if ((operation.requiredQuery ?? []).some((name) => !seen.has(name))) throw new EgressRefusal('request_schema_refused');
  return new URLSearchParams([...url.searchParams]).toString();
}

function formAllowed(body: Extract<OperationBody, { kind: 'form' }>, name: string, value: string): boolean {
  const field = rule(body.fields, name);
  if (field) return field.test(value);
  return (body.patterns ?? []).some(([key, check]) => whole(key).test(name) && whole(check).test(value));
}

/**
 * How many zod issues a JSON body check may raise before it stops and refuses (review addendum 2,
 * C4; see bounded-parse.ts). A body that passes raises issues only in the union options tried
 * before the one it matches. Within the 128 KiB `vault.callApi` cap, the most such issues a passing
 * body can raise is about 4,500:
 * - chat completions: one per message with array content, and a message that small is 29 bytes;
 * - Anthropic messages: one per message with array content, at 31 bytes each, so about 4,200;
 * - embeddings `input`: at most 4,097, because the token lists hold at most 8,192 tokens and are
 *   tried before the string list (at most 2,048 strings);
 * - every other union: a handful.
 * The budget, 8,192, is 1.8 times that (measured: 4,520). Tests in test/egress/bounded-body.test.ts
 * fill the cap with the worst passing bodies and pin the list of union sites, so adding a union fails
 * a test until this bound is redone.
 */
export const JSON_BODY_ISSUE_BUDGET = 8192;

/** What the broker sends for a checked body: its content type, and for a form the re-serialized text. */
export interface CheckedBody { contentType: string; text?: string }

/**
 * Throws `request_schema_refused` unless the body is exactly what the operation takes. Returns
 * the content type the broker sends, so a connector request never chooses its own, and for a
 * form the text re-serialized from the checked pairs.
 */
export function checkBody(operation: ConnectorOperation, body: ApiRequestBody | undefined): CheckedBody | null {
  const expected = operation.body;
  if (expected === null) {
    if (body !== undefined) throw new EgressRefusal('request_schema_refused');
    return null;
  }
  if (body === undefined) throw new EgressRefusal('request_schema_refused');
  if (expected.kind === 'json') {
    if (body.kind !== 'json' || !boundedSafeParse(expected.schema, body.value, JSON_BODY_ISSUE_BUDGET).success) {
      throw new EgressRefusal('request_schema_refused');
    }
    return { contentType: 'application/json' };
  }
  if (body.kind !== 'text' || !FORM_TYPE.test(body.contentType ?? '') || body.value.includes(';')) {
    throw new EgressRefusal('request_schema_refused');
  }
  const pairs = [...new URLSearchParams(body.value)];
  const seen = new Set<string>();
  for (const [name, value] of pairs) {
    if (seen.has(name) || !formAllowed(expected, name, value)) throw new EgressRefusal('request_schema_refused');
    seen.add(name);
  }
  return { contentType: 'application/x-www-form-urlencoded', text: new URLSearchParams(pairs).toString() };
}

// ---------------------------------------------------------------------------
// Multiplexer surfaces, refused in BOTH modes
// ---------------------------------------------------------------------------
//
// A multiplexer endpoint carries the real operation in the body: GraphQL, JSON-RPC, XML-RPC and
// SOAP, OData `$batch`, Google and Graph API batch envelopes, Elasticsearch `_bulk` and
// `_msearch`, provider batch jobs. The method and path then say nothing about what runs, so a
// path deny list or prefix cannot bound it. No connector operation parses one, so they are
// refused everywhere. The checks look at the path, the query, the content type and the body.
// They are heuristics. A server that runs a multiplexer at an unremarkable path, in a body format
// these checks do not parse, is not detected; neither is a query language they do not know (SQL
// over HTTP, for one). Generic mode is the weaker mode for that reason. In connector mode the
// operation list already refuses everything it does not name, and these checks are a second
// layer.

const MULTIPLEXER_SEGMENT = /^(?:graphql|graphiql|gql|batch|\$batch|_batch|batches|bulk|_bulk|composite|jsonrpc|json-rpc|xmlrpc|xml-rpc|rpc|multiplex|_msearch|_mget)(?:\.(?:json|php|aspx?))?$/i;
const MULTIPLEXER_TYPE = /^(?:application\/graphql(?:[+-][a-z0-9.+-]*)?|application\/(?:json-rpc|jsonrpc|jsonrequest|http|soap\+xml)|multipart\/(?:mixed|batch|parallel|digest))$/i;
/**
 * A GraphQL document: ignored tokens (white space, commas, comments), an optional operation
 * keyword and name, then a selection set that opens with a field name or a fragment spread. A
 * comment runs to the end of its line, so there is one way to match it (no backtracking blowup).
 * JSON text such as `{"term": 1}` or `{}` is not a document.
 */
const GRAPHQL_DOCUMENT = /^(?:[\s,\uFEFF]|#[^\n\r]*(?=[\n\r]|$))*(?:(?:query|mutation|subscription|fragment)\b[^{]*)?\{(?:[\s,\uFEFF]|#[^\n\r]*(?=[\n\r]|$))*(?:[_A-Za-z]|\.\.\.)/i;
const GRAPHQL_KEYS = ['operationName', 'persistedQuery', 'jsonrpc'];
/** A stored document's id. It names a GraphQL request only next to `variables` or `extensions`. */
const DOCUMENT_ID_KEYS = ['id', 'doc_id', 'docId', 'documentId', 'document_id', 'queryId', 'query_id', 'queryHash', 'query_hash'];
const DOCUMENT_ARGUMENT_KEYS = ['variables', 'extensions'];
const VERB_KEYS = ['method', 'httpMethod', 'http_method', 'verb'];
const TARGET_KEYS = ['url', 'uri', 'path', 'relative_url', 'relativeUrl', 'href', 'endpoint'];
const BATCH_KEYS = ['requests', 'batch', 'compositeRequest', 'operations', 'calls', 'queries'];
const lower = (keys: readonly string[]): ReadonlySet<string> => new Set(keys.map((key) => key.toLowerCase()));
const GRAPHQL_PARAMS = lower(GRAPHQL_KEYS);
const DOCUMENT_ID_PARAMS = lower(DOCUMENT_ID_KEYS);
const DOCUMENT_ARGUMENT_PARAMS = lower(DOCUMENT_ARGUMENT_KEYS);
const BATCH_PARAMS = lower(BATCH_KEYS);
/**
 * Multipart field names a GraphQL server reads: the multipart request spec's `operations` (its
 * `map` is useless without it), and the plain GraphQL parameters (graphene-django reads them
 * from a multipart form).
 */
const GRAPHQL_FIELDS = lower(['operations', 'query', 'mutation', 'operationName', 'extensions', 'persistedQuery']);
/** An XML body: optional byte order mark and white space, then markup. */
const XML_START = /^\uFEFF?\s*</;
/** An XML-RPC call or a SOAP envelope, with or without a namespace prefix. */
const XML_RPC_OR_SOAP = /<(?:[A-Za-z_][\w.-]*:)?(?:methodCall|Envelope)[\s/>]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function graphqlDocument(value: unknown): boolean {
  return typeof value === 'string' && GRAPHQL_DOCUMENT.test(value);
}

function hasAny(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(value, key));
}

/** One request inside a batch, or a GraphQL, JSON-RPC 1.0/2.0 or forwarded HTTP call. */
function requestLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (graphqlDocument(value.query) || graphqlDocument(value.mutation) || hasAny(value, GRAPHQL_KEYS)) return true;
  if (isRecord(value.extensions) && Object.hasOwn(value.extensions, 'persistedQuery')) return true;
  if (hasAny(value, DOCUMENT_ID_KEYS) && hasAny(value, DOCUMENT_ARGUMENT_KEYS)) return true;
  // JSON-RPC 1.0 has no `jsonrpc` member: a method name with parameters.
  if (typeof value.method === 'string' && Object.hasOwn(value, 'params')) return true;
  return hasAny(value, VERB_KEYS) && hasAny(value, TARGET_KEYS);
}

export function multiplexedJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requestLike);
  if (!isRecord(value)) return false;
  return requestLike(value) || BATCH_KEYS.some((key) => Array.isArray(value[key]) && (value[key] as unknown[]).some(requestLike));
}

/** Query or form parameters that carry GraphQL, JSON-RPC or a JSON batch (Graph API `batch=`). */
export function multiplexedParams(params: URLSearchParams): boolean {
  let documentId = false;
  let documentArguments = false;
  for (const [key, value] of params) {
    const name = key.toLowerCase();
    if ((name === 'query' || name === 'mutation') && graphqlDocument(value)) return true;
    if (GRAPHQL_PARAMS.has(name)) return true;
    if (name === 'extensions' && /persistedquery/i.test(value)) return true;
    if (BATCH_PARAMS.has(name)) {
      try { if (multiplexedJson(JSON.parse(value))) return true; } catch { /* not JSON */ }
    }
    documentId ||= DOCUMENT_ID_PARAMS.has(name);
    documentArguments ||= DOCUMENT_ARGUMENT_PARAMS.has(name);
  }
  return documentId && documentArguments;
}

/** RFC 2231 percent-decoding. A malformed sequence decodes byte by byte. */
function percentDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value.replace(/%([0-9A-Fa-f]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))); }
}

/** RFC 2047 encoded words (`=?utf-8?B?...?=`), which Apache Commons FileUpload and Tomcat decode in parameter values. */
function decodeWords(value: string): string {
  return value.replace(/=\?[^?\s]{1,64}\?([BbQq])\?([^?\s]*)\?=/g, (_word, encoding: string, data: string) => (encoding.toUpperCase() === 'B'
    ? Buffer.from(data, 'base64')
    : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1')
  ).toString('utf8'));
}

/**
 * Every field name a multipart parser may read from the body, in each encoding one of them
 * decodes: `name="x"` with backslash escapes, `name='x'` (PHP), `name=x`, the RFC 2231 forms
 * `name*=utf-8''x` and `name*0="x"; name*1="y"` (Go, Werkzeug), and RFC 2047 encoded words
 * (Commons FileUpload, Tomcat). It scans the whole body, not only part headers, and keeps every
 * reading, so it collects too much, which is the safe direction for a refusal. Each quoted read
 * stops at the next parameter's opening quote, so the scan stays linear in the body.
 */
export function dispositionNames(text: string): string[] {
  const names: string[] = [];
  const groups: Map<number, string>[] = [];
  const key = /(?:^|[;\s])name(?:\*(\d{1,3}))?(\*)?\s*=/gi;
  const read = (pattern: RegExp, at: number): string | undefined => { pattern.lastIndex = at; return pattern.exec(text)?.[1]; };
  for (let match = key.exec(text); match; match = key.exec(text)) {
    const [, index, extended] = match;
    const space = /\s*/y;
    space.lastIndex = key.lastIndex;
    space.exec(text);
    const at = space.lastIndex;
    const quoted = text[at] === '"' ? read(/"((?:[^"\\]|\\[\s\S])*)"/y, at) : text[at] === "'" ? read(/'((?:[^'\\]|\\[\s\S])*)'/y, at) : undefined;
    const readings = [read(/([^;\s]*)/y, at) ?? ''];
    if (quoted !== undefined) readings.unshift(quoted.replace(/\\([\s\S])/g, '$1'));
    const decoded = readings.map((value) => (extended ? percentDecode(index === undefined || index === '0' ? value.replace(/^[^']*'[^']*'/, '') : value) : value));
    if (index === undefined) { names.push(...readings, ...decoded); continue; }
    const position = Number(index);
    let group = groups.at(-1);
    if (!group || position === 0 || group.has(position)) groups.push(group = new Map());
    group.set(position, decoded[0]!);
  }
  for (const group of groups) names.push([...group].sort(([a], [b]) => a - b).map(([, piece]) => piece).join(''));
  return [...new Set(names.flatMap((name) => [name, decodeWords(name)]))];
}

export function multiplexedPath(path: string): boolean {
  return path.split('/').some((segment) => MULTIPLEXER_SEGMENT.test(segment));
}

/**
 * The body as the upstream may read it. JSON is checked whatever the declared type, because
 * some GraphQL servers parse a `text/plain` body as JSON. A form is checked when the type is a
 * form or absent, which is how Rack reads a POST without a type. A raw GraphQL document is
 * checked as text with no type or `text/plain`. Field names are checked in any multipart type,
 * because Rack parses `multipart/related` and `multipart/mixed` as a form too. XML-RPC and SOAP
 * are checked in any XML-looking body, because XML-RPC servers read the body whatever its type.
 */
export function multiplexedBody(text: string, contentType: string | undefined): boolean {
  const mime = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (MULTIPLEXER_TYPE.test(mime)) return true;
  let parsed: unknown;
  let json = false;
  try { parsed = JSON.parse(text); json = true; } catch { /* not JSON */ }
  if (json && multiplexedJson(parsed)) return true;
  if ((mime === '' || mime === 'application/x-www-form-urlencoded') && multiplexedParams(new URLSearchParams(text))) return true;
  if ((mime === '' || mime === 'text/plain') && GRAPHQL_DOCUMENT.test(text)) return true;
  if (mime.startsWith('multipart/') && dispositionNames(text).some((name) => GRAPHQL_FIELDS.has(name.toLowerCase()))) return true;
  return XML_START.test(text) && XML_RPC_OR_SOAP.test(text);
}

// ---------------------------------------------------------------------------
// Catalog invariants
// ---------------------------------------------------------------------------

function ruleProblem(where: string, check: ValueRule): string | null {
  if (!check.source.startsWith('^') || !check.source.endsWith('$')) return `${where}: rule is not anchored`;
  if (/[gy]/.test(check.flags)) return `${where}: rule keeps state`;
  if (check.flags.includes('m')) return `${where}: rule is multiline`;
  return null;
}

/** The ways a catalog breaks the rules above. Empty for a sound catalog. */
export function catalogProblems(operations: readonly ConnectorOperation[], headers: Readonly<Record<string, ValueRule>> = {}): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const routes = new Set<string>();
  const push = (problem: string | null) => { if (problem) problems.push(problem); };
  for (const [name, check] of Object.entries(headers)) {
    if (name !== name.toLowerCase()) problems.push(`header ${name}: name is not lowercase`);
    push(ruleProblem(`header ${name}`, check));
  }
  for (const operation of operations) {
    if (ids.has(operation.id)) problems.push(`${operation.id}: duplicate id`);
    ids.add(operation.id);
    const route = `${operation.method} ${operation.path}`;
    if (routes.has(route)) problems.push(`${operation.id}: duplicate route`);
    routes.add(route);
    const segments = operation.path.split('/');
    if (segments[0] !== '' || segments.slice(1).some((segment) => segment === '')) problems.push(`${operation.id}: empty path segment`);
    for (const [index, segment] of segments.entries()) {
      const param = PARAM.exec(segment);
      if (!param) {
        if (/[{}]/.test(segment)) problems.push(`${operation.id}: malformed segment ${segment}`);
        continue;
      }
      if (!rule(operation.params, param[1]!)) problems.push(`${operation.id}: no rule for {${param[1]}}`);
      if (param[2] === '+' && index !== segments.length - 1) problems.push(`${operation.id}: {${param[1]}+} is not last`);
    }
    for (const [name, check] of Object.entries(operation.params ?? {})) push(ruleProblem(`${operation.id} param ${name}`, check));
    for (const [name, check] of Object.entries(operation.query ?? {})) push(ruleProblem(`${operation.id} query ${name}`, check));
    for (const name of operation.requiredQuery ?? []) if (!rule(operation.query, name)) problems.push(`${operation.id}: required ${name} is not allowed`);
    if (operation.body?.kind === 'form') {
      for (const [name, check] of Object.entries(operation.body.fields)) push(ruleProblem(`${operation.id} field ${name}`, check));
      for (const [key, check] of operation.body.patterns ?? []) {
        push(ruleProblem(`${operation.id} field pattern`, key)); push(ruleProblem(`${operation.id} field pattern value`, check));
      }
    }
    if (operation.body !== null && (operation.method === 'GET' || operation.method === 'HEAD')) problems.push(`${operation.id}: ${operation.method} with a body`);
    if (multiplexedPath(operation.path)) problems.push(`${operation.id}: multiplexer path`);
  }
  return problems;
}
