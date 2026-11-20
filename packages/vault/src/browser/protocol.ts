import type { FillIntent, FillOutcome, FillRefusalCode } from '../types.js';
import { zeroize } from '../secret-material.js';
import { observedOrigin } from './policy.js';

export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_FILL_TIMEOUT_MS = 30_000;

export const TEST_ENV_SWITCHES = ['TM8_VAULT_FILL_TEST_NO_SANDBOX', 'TM8_VAULT_FILL_TEST_SINGLE_PROCESS', 'TM8_VAULT_BROWSER_E2E'] as const;
export const TEST_CLI_SWITCHES = ['--no-sandbox', '--single-process', '--no-zygote', '--test-only-disable-sandbox'] as const;
const TEST_SOCKET_SWITCHES = ['testOnlyDisableSandbox', 'testOnlySingleProcess'] as const;
type TestSwitchName = typeof TEST_ENV_SWITCHES[number] | typeof TEST_CLI_SWITCHES[number] | typeof TEST_SOCKET_SWITCHES[number] | 'TM8_VAULT_FILL_TEST_*' | '--fill-child';

/** Names come only from this fixed vocabulary; supplied values never enter diagnostics. */
export class ProductionSwitchRefusal extends Error {
  constructor(readonly switchName: TestSwitchName) {
    super(`vault fill worker refused: ${switchName}`);
    this.name = 'ProductionSwitchRefusal';
  }
}

export type WorkerRequest = { id: string; op: 'health' } | {
  id: string; op: 'fill'; intent: FillIntent; username: string | null; password_b64: string;
};

export function refusal(code: FillRefusalCode): FillOutcome {
  return { ok: false, code, observedOrigin: null, screenshot: null };
}

/** The receiver owns each delivered body. The input chunks are wiped on every path. */
export class FrameReader {
  #header = Buffer.alloc(4);
  #headerOffset = 0;
  #body: Buffer | null = null;
  #bodyOffset = 0;
  #finished = false;

  constructor(private readonly limit: number, private readonly receive: (body: Buffer) => void) {}

  push(chunk: Buffer): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.#finished) throw new Error('invalid worker frame');
        if (this.#body === null) {
          const take = Math.min(4 - this.#headerOffset, chunk.length - offset);
          chunk.copy(this.#header, this.#headerOffset, offset, offset + take);
          offset += take;
          this.#headerOffset += take;
          if (this.#headerOffset !== 4) continue;
          const size = this.#header.readUInt32BE(0);
          if (size < 1 || size > this.limit) throw new Error('invalid worker frame');
          this.#body = Buffer.alloc(size);
        }
        const take = Math.min(this.#body.length - this.#bodyOffset, chunk.length - offset);
        chunk.copy(this.#body, this.#bodyOffset, offset, offset + take);
        offset += take;
        this.#bodyOffset += take;
        if (this.#bodyOffset === this.#body.length) {
          const body = this.#body;
          this.#body = null;
          this.#finished = true;
          zeroize(this.#header);
          if (offset !== chunk.length) {
            zeroize(body);
            throw new Error('invalid worker frame');
          }
          this.receive(body);
        }
      }
    } finally {
      zeroize(chunk);
    }
  }

  dispose(): void {
    zeroize(this.#header, this.#body);
    this.#body = null;
    this.#finished = true;
  }
}

export function frame(body: Buffer): Buffer {
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

export function encodeJsonFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  try { return frame(body); } finally { zeroize(body); }
}

/** Strict fixed-intent validation: extra agent actions/selectors never enter the driver. */
export function parseRequest(body: Buffer): WorkerRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new Error('invalid worker request'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid worker request');
  const value = parsed as Record<string, unknown>;
  for (const name of TEST_SOCKET_SWITCHES) {
    if (Object.hasOwn(value, name) || (value.intent && typeof value.intent === 'object' && Object.hasOwn(value.intent, name))) {
      throw new ProductionSwitchRefusal(name);
    }
  }
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id)) throw new Error('invalid worker request');
  if (value.op === 'health' && Object.keys(value).length === 2) return { id: value.id, op: 'health' };
  if (value.op !== 'fill' || Object.keys(value).some((key) => !['id', 'op', 'intent', 'username', 'password_b64'].includes(key))) {
    throw new Error('invalid worker request');
  }
  if (!value.intent || typeof value.intent !== 'object') throw new Error('invalid worker request');
  const intent = value.intent as Record<string, unknown>;
  if (Object.keys(intent).some((key) => !['operationId', 'itemId', 'origin', 'startUrl', 'submit', 'devMode'].includes(key))) {
    throw new Error('invalid worker request');
  }
  for (const key of ['operationId', 'itemId', 'origin']) {
    if (typeof intent[key] !== 'string' || intent[key].length < 1 || intent[key].length > 2048) throw new Error('invalid worker request');
  }
  if (intent.startUrl !== undefined && (typeof intent.startUrl !== 'string' || intent.startUrl.length > 2048)) throw new Error('invalid worker request');
  if (typeof intent.submit !== 'boolean' || typeof intent.devMode !== 'boolean') throw new Error('invalid worker request');
  if (value.username !== null && (typeof value.username !== 'string' || value.username.length > 4096)) throw new Error('invalid worker request');
  if (typeof value.password_b64 !== 'string' || value.password_b64.length < 4 || value.password_b64.length > 90_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.password_b64)) {
    throw new Error('invalid worker request');
  }
  return parsed as WorkerRequest;
}

const CODES: readonly FillRefusalCode[] = [
  'origin_mismatch', 'cross_origin_redirect', 'cross_origin_form_action', 'insecure_context',
  'not_top_frame', 'fields_not_found', 'navigation_failed', 'timeout', 'browser_unavailable',
];

/** PNG bytes use base64 on the JSON wire; there is no path, cookie or DOM field. */
export function encodeOutcome(id: string, outcome: FillOutcome): Buffer {
  return encodeJsonFrame({ id, op: 'fill', outcome: {
    ...outcome,
    screenshot: outcome.screenshot ? { ...outcome.screenshot, data: outcome.screenshot.data.toString('base64') } : null,
  } });
}

export function decodeOutcome(body: Buffer, expectedId: string): FillOutcome {
  try {
    const envelope = JSON.parse(body.toString('utf8'));
    if (envelope.id !== expectedId || envelope.op !== 'fill') return refusal('browser_unavailable');
    const value = envelope.outcome;
    let screenshot = null;
    if (value.screenshot !== null) {
      const shot = value.screenshot;
      if (!shot || shot.mime !== 'image/png' || typeof shot.data !== 'string' || !Number.isSafeInteger(shot.width) ||
          !Number.isSafeInteger(shot.height) || !Number.isSafeInteger(shot.maskedRegions) ||
          shot.width < 1 || shot.height < 1 || shot.maskedRegions < 0 || shot.data.length > MAX_RESPONSE_BYTES) {
        throw new Error('invalid worker response');
      }
      const data = Buffer.from(shot.data, 'base64');
      if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        zeroize(data);
        throw new Error('invalid worker response');
      }
      screenshot = { mime: 'image/png' as const, data, width: shot.width, height: shot.height, maskedRegions: shot.maskedRegions };
    }
    if (value.ok === true && typeof value.finalOrigin === 'string' &&
        observedOrigin(value.finalOrigin) === value.finalOrigin && typeof value.submitted === 'boolean') {
      return { ok: true, finalOrigin: value.finalOrigin, submitted: value.submitted, screenshot };
    }
    if (value.ok === false && CODES.includes(value.code) &&
        (value.observedOrigin === null || (typeof value.observedOrigin === 'string' && observedOrigin(value.observedOrigin) === value.observedOrigin))) {
      return { ok: false, code: value.code, observedOrigin: value.observedOrigin, screenshot };
    }
    zeroize(screenshot?.data);
  } catch { /* Never forward parser messages or payloads. */ }
  return refusal('browser_unavailable');
}
