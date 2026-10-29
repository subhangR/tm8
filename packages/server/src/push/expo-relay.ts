/**
 * The Expo Push Service relay (decide Q5). Endpoints, limits and error codes
 * are Expo's (docs.expo.dev/push-notifications/sending-notifications, read
 * 2026-10-29): `POST /--/api/v2/push/send` takes at most 100 messages and
 * answers one ticket per message in order; `POST /--/api/v2/push/getReceipts`
 * takes at most 1000 ticket ids; receipts are kept 24 hours; 429 and 5xx are
 * retried with backoff, a 400 is not.
 *
 * WHAT NEVER LEAVES THIS FILE: Expo's error MESSAGES. They quote the token
 * they are about ("ExponentPushToken[…] is not a registered push notification
 * recipient"), so only the error CODE is returned, logged or stored.
 *
 * Tests inject `fetch`; no test and no lane node ever reaches exp.host. The
 * composition root builds this relay only when TM8_PUSH_RELAY=expo is set.
 */
import {
  RelayRejectedError,
  RelayUnavailableError,
  type PushRelay,
  type RelayErrorCode,
  type RelayMessage,
  type RelayReceipt,
  type RelayTicket,
} from './types.js';

export const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push';
export const EXPO_SEND_LIMIT = 100;
export const EXPO_RECEIPT_LIMIT = 1000;
/** A push still undelivered after a day is no longer news; the inbox holds it anyway. */
export const PUSH_TTL_SECONDS = 86_400;

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'DeviceNotRegistered',
  'MessageTooBig',
  'MessageRateExceeded',
  'MismatchSenderId',
  'InvalidCredentials',
]);

/** Masks anything shaped like an Expo push token. For error text that is not ours. */
export function scrubPushTokens(text: string): string {
  return text.replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, 'ExponentPushToken[…]');
}

/** One RelayMessage as Expo's message object. */
export function expoMessageOf(message: RelayMessage): Record<string, unknown> {
  const { payload, route } = message;
  const passive = route.interruptionLevel === 'passive';
  return {
    to: message.to,
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.body ? { body: payload.body } : {}),
    data: payload.data,
    categoryId: payload.categoryId,
    threadId: payload.threadId,
    channelId: route.androidChannelId,
    interruptionLevel: route.interruptionLevel,
    priority: passive ? 'normal' : 'high',
    ...(passive ? {} : { sound: 'default' }),
    ttl: PUSH_TTL_SECONDS,
  };
}

function errorCodeOf(value: unknown): RelayErrorCode {
  const details = (value as { details?: { error?: unknown } } | null)?.details;
  const code = details && typeof details === 'object' ? details.error : undefined;
  return typeof code === 'string' && KNOWN_ERRORS.has(code) ? (code as RelayErrorCode) : 'Unknown';
}

function ticketOf(value: unknown): RelayTicket {
  const ticket = value as { status?: unknown; id?: unknown } | null;
  if (ticket?.status === 'ok' && typeof ticket.id === 'string' && ticket.id.length > 0 && ticket.id.length <= 200) {
    return { status: 'ok', id: ticket.id };
  }
  return { status: 'error', error: errorCodeOf(value) };
}

function receiptOf(value: unknown): RelayReceipt {
  return (value as { status?: unknown } | null)?.status === 'ok'
    ? { status: 'ok' }
    : { status: 'error', error: errorCodeOf(value) };
}

/** `errors[].code` of a whole-request failure; codes only, never messages. */
function requestErrorCodes(json: unknown): string[] {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((error) => (error as { code?: unknown } | null)?.code)
    .filter((code): code is string => typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code))
    .slice(0, 5);
}

function retryAfterMsOf(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), 3_600_000) : undefined;
}

function failureName(error: unknown): string {
  if (!(error instanceof Error)) return 'error';
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? `${error.name}: ${cause.code}` : error.name;
}

export interface ExpoPushRelayOptions {
  /** Expo's enhanced push security access token, when the project turns it on. */
  readonly accessToken?: string | undefined;
  /** Injected by tests, which never reach exp.host. */
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class ExpoPushRelay implements PushRelay {
  readonly name = 'expo';
  readonly maxBatch = EXPO_SEND_LIMIT;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ExpoPushRelayOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = (options.endpoint ?? EXPO_PUSH_ENDPOINT).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  async send(messages: readonly RelayMessage[]): Promise<RelayTicket[]> {
    if (messages.length === 0) return [];
    if (messages.length > EXPO_SEND_LIMIT) {
      throw new RangeError(`expo takes at most ${EXPO_SEND_LIMIT} messages per request, got ${messages.length}`);
    }
    const data = await this.post('/send', messages.map(expoMessageOf));
    if (!Array.isArray(data) || data.length !== messages.length) {
      const got = Array.isArray(data) ? String(data.length) : 'no';
      throw new RelayUnavailableError(`expo push service answered ${got} tickets for ${messages.length} messages`);
    }
    return data.map(ticketOf);
  }

  async receipts(ticketIds: readonly string[]): Promise<ReadonlyMap<string, RelayReceipt>> {
    const out = new Map<string, RelayReceipt>();
    for (let start = 0; start < ticketIds.length; start += EXPO_RECEIPT_LIMIT) {
      const ids = ticketIds.slice(start, start + EXPO_RECEIPT_LIMIT);
      const asked = new Set(ids);
      const data = await this.post('/getReceipts', { ids });
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const [id, receipt] of Object.entries(data)) {
        if (asked.has(id)) out.set(id, receiptOf(receipt));
      }
    }
    return out;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
          ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RelayUnavailableError(`expo push service unreachable (${failureName(error)})`);
    }

    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const codes = requestErrorCodes(json);
    const said = `${response.status}${codes.length > 0 ? ` (${codes.join(', ')})` : ''}`;
    if (response.status === 429 || response.status >= 500) {
      throw new RelayUnavailableError(
        `expo push service answered ${said}`,
        retryAfterMsOf(response.headers.get('retry-after'), this.now()),
      );
    }
    if (!response.ok) throw new RelayRejectedError(`expo push service refused the request: ${said}`);
    if (json === null || typeof json !== 'object' || !('data' in json)) {
      throw new RelayUnavailableError(`expo push service answered ${response.status} without data`);
    }
    return (json as { data: unknown }).data;
  }
}
