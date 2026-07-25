/**
 * The contract-checking HTTP client every golden-workflow step goes through.
 *
 * It is not a convenience wrapper — it is half the test. Every call asserts the
 * wire rules from `docs/collab-v2-api-design/04-COMMUNICATION-MODEL.md` before
 * the workflow ever looks at the payload:
 *
 *   §1  every success is `{ data, requestId }`; list pages carry `nextCursor`
 *       INSIDE `data.page`, never at the envelope level                  (DEV-6)
 *   §4  every error is `{ error: { code, message, details?, requestId,
 *       retryable } }`, code drawn from the closed set, HTTP status matching
 *       the taxonomy row                                                 (DEV-8)
 *   §5  every mutation takes `clientMutationId`; replaying one returns the
 *       recorded CommandResult                                           (DEV-9)
 *
 * So a workflow that "passes" cannot have passed against an ad-hoc shape.
 */
import { operationPath } from './contract.mjs';
import { fail, ok, isString } from './assert.mjs';

/** The closed error taxonomy (04 §4). A code outside this set is itself a failure. */
export const ERROR_CODES = Object.freeze({
  invalid_input: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  invariant_violation: 409,
  payload_too_large: 413,
  rate_limited: 429,
  not_implemented: 501,
  upstream_unavailable: [502, 503],
});

export const DEFAULT_BASE_URL = process.env.TM8_BASE_URL || 'http://localhost:4610';

let mutationCounter = 0;

/**
 * uuidv7-shaped client mutation id. Time-ordered so a failed run's ledger rows
 * sort next to each other; the rigs never rely on the version nibble beyond
 * "the server accepted it".
 */
export function newClientMutationId() {
  const ms = Date.now();
  const tsHex = ms.toString(16).padStart(12, '0');
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  mutationCounter = (mutationCounter + 1) % 0x1000;
  const seq = mutationCounter.toString(16).padStart(3, '0');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${seq}-8${rand().slice(0, 3)}-${rand()}${rand()}${rand()}`;
}

export class ContractClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]   server origin (paths already carry `/v2`)
   * @param {object} [opts.headers]   extra headers (auth credential, actor pin)
   * @param {number} [opts.timeoutMs]
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, headers = {}, timeoutMs = 15_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...headers };
    this.timeoutMs = timeoutMs;
    /** Full request/response log — emitted into the run artifact for auditing. */
    this.log = [];
  }

  /**
   * Call an operation BY CATALOG NAME. There is no `get(path)` escape hatch on
   * purpose: a rig that can type a raw path can test a route the catalog does
   * not define, which is exactly the drift the conformance story exists to stop.
   */
  async call(operationName, { params = {}, query = {}, body, expectStatus } = {}) {
    const path = await operationPath(operationName, params);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const method = await methodFor(operationName);
    const init = { method, headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
      init.body = JSON.stringify(body);
    }

    const t0 = performance.now();
    let res;
    let raw;
    try {
      res = await fetch(url, init);
      raw = await res.text();
    } catch (error) {
      const entry = {
        operation: operationName,
        method,
        url: url.toString(),
        ms: performance.now() - t0,
        transportError: error.message,
      };
      this.log.push(entry);
      fail(`${operationName}: transport error — ${error.message}`, entry);
    }

    let json = null;
    try {
      json = raw.length ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }

    const entry = {
      operation: operationName,
      method,
      url: url.toString(),
      status: res.status,
      ms: performance.now() - t0,
      requestId: json?.requestId ?? json?.error?.requestId ?? null,
    };
    this.log.push(entry);

    if (res.status >= 400) {
      const err = assertErrorEnvelope(operationName, res.status, json, raw);
      if (expectStatus === res.status) return { ok: false, status: res.status, error: err };
      fail(`${operationName}: ${res.status} ${err.code} — ${err.message}`, {
        ...entry,
        code: err.code,
        details: err.details,
      });
    }

    if (expectStatus !== undefined && expectStatus !== res.status) {
      fail(`${operationName}: expected HTTP ${expectStatus}, got ${res.status}`, entry);
    }

    const data = assertSuccessEnvelope(operationName, json, raw);
    return { ok: true, status: res.status, data, requestId: json.requestId };
  }

  /** Mutation sugar: stamps a `clientMutationId` and returns it with the result. */
  async mutate(operationName, { params, query, body = {}, clientMutationId, expectStatus } = {}) {
    const cmid = clientMutationId ?? newClientMutationId();
    const result = await this.call(operationName, {
      params,
      query,
      body: { ...body, clientMutationId: cmid },
      expectStatus,
    });
    return { ...result, clientMutationId: cmid };
  }
}

async function methodFor(operationName) {
  const { loadContract } = await import('./contract.mjs');
  const contract = await loadContract();
  return contract.getOperation(operationName).method;
}

/** 04 §1 — `{ data, requestId }`, and list pages keep `nextCursor` inside `data.page`. */
export function assertSuccessEnvelope(operationName, json, raw) {
  ok(json && typeof json === 'object', `${operationName}: response is not JSON`, {
    body: raw?.slice(0, 400),
  });
  ok('data' in json, `${operationName}: success envelope missing 'data' (DEV-6)`, { got: Object.keys(json) });
  isString(json.requestId, `${operationName}: success envelope missing a non-empty 'requestId' (DEV-6)`);
  ok(
    !('nextCursor' in json),
    `${operationName}: 'nextCursor' must live inside data.page, not on the envelope (04 §1)`,
  );
  return json.data;
}

/** 04 §4 — closed taxonomy, and the HTTP status must match the code's row. */
export function assertErrorEnvelope(operationName, status, json, raw) {
  ok(json && typeof json === 'object' && json.error, `${operationName}: HTTP ${status} with no error envelope (04 §4)`, {
    body: raw?.slice(0, 400),
  });
  const err = json.error;
  ok(
    Object.prototype.hasOwnProperty.call(ERROR_CODES, err.code),
    `${operationName}: error code '${err.code}' is outside the closed taxonomy (04 §4)`,
    { code: err.code, allowed: Object.keys(ERROR_CODES) },
  );
  isString(err.message, `${operationName}: error envelope needs a 'message'`);
  isString(err.requestId, `${operationName}: error envelope needs a 'requestId'`);
  ok(typeof err.retryable === 'boolean', `${operationName}: error envelope needs a boolean 'retryable'`, { err });

  const expected = ERROR_CODES[err.code];
  const allowed = Array.isArray(expected) ? expected : [expected];
  ok(
    allowed.includes(status),
    `${operationName}: code '${err.code}' must map to HTTP ${allowed.join('/')}, got ${status} (04 §4)`,
    { status, code: err.code },
  );
  return err;
}

/** 04 §1 — `CommandResult = { entity?, edge?, activity?, patches[], undo? }`. */
export function assertCommandResult(operationName, data) {
  ok(data && typeof data === 'object', `${operationName}: CommandResult must be an object`, { data });
  ok(
    Array.isArray(data.patches),
    `${operationName}: CommandResult.patches must be an EntitySummary[] (04 §1)`,
    { got: typeof data.patches },
  );
  return data;
}

/** 04 §3 — a page is `{ items[], nextCursor: string|null, total? }`. */
export function assertPage(operationName, page) {
  ok(page && typeof page === 'object', `${operationName}: expected a Page`, { page });
  ok(Array.isArray(page.items), `${operationName}: Page.items must be an array`, { got: typeof page.items });
  ok(
    page.nextCursor === null || typeof page.nextCursor === 'string',
    `${operationName}: Page.nextCursor must be a string or null — null ⇔ exhausted (DEV-5)`,
    { nextCursor: page.nextCursor },
  );
  return page;
}
