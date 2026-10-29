/**
 * The Expo relay client against an injected fetch: no request here, or
 * anywhere in this suite, reaches exp.host (ac4).
 *
 * Under test: the message Expo receives (fields, the previews-shaped texts
 * passed through untouched, the routing hints), the ticket and receipt mapping,
 * which failures are worth retrying, and that no error this client raises or
 * returns carries a token, because Expo's own error messages quote one.
 */
import { describe, expect, it } from 'vitest';

import { pushRouteOf } from '@tm8/contract';

import { EXPO_SEND_LIMIT, ExpoPushRelay, PUSH_TTL_SECONDS, scrubPushTokens } from '../../src/push/expo-relay.js';
import { buildPushPayload } from '../../src/push/payload.js';
import { RelayRejectedError, RelayUnavailableError, type RelayMessage } from '../../src/push/types.js';
import { MESSAGE, ORIGIN, expoToken, notification } from './fixtures.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: unknown;
}

function fakeFetch(answer: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function message(previews: 'full' | 'sender' | 'none' = 'full', token = expoToken(1), quiet = false): RelayMessage {
  const item = notification();
  return {
    to: token,
    payload: buildPushPayload({ notification: item, messageId: MESSAGE, previews, origin: ORIGIN }),
    route: pushRouteOf(item.kind, { quiet }),
  };
}

describe('send: the request', () => {
  it('posts the messages to /push/send as JSON', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 'ticket-1' }] }));
    const relay = new ExpoPushRelay({ fetch: fetch.impl });
    await relay.send([message()]);
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call!.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(call!.init.method).toBe('POST');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends the access token only when the project uses enhanced push security', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 't' }] }));
    await new ExpoPushRelay({ fetch: fetch.impl, accessToken: 'expo-access-token' }).send([message()]);
    expect((fetch.calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer expo-access-token');
  });

  it('maps PushPayloadV1 and its route onto Expo fields, with no badge', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 't' }] }));
    const m = message('full');
    await new ExpoPushRelay({ fetch: fetch.impl }).send([m]);
    const [sent] = fetch.calls[0]!.body as Array<Record<string, unknown>>;
    expect(sent).toEqual({
      to: m.to,
      title: 'Priya mentioned you in #mobile',
      body: '@subhang can you look at the tablet overflow?',
      data: m.payload.data,
      categoryId: 'tm8.reply',
      threadId: m.payload.threadId,
      channelId: 'mentions',
      interruptionLevel: 'active',
      priority: 'high',
      sound: 'default',
      ttl: PUSH_TTL_SECONDS,
    });
    expect(sent).not.toHaveProperty('badge');
  });

  it('omits an empty title or body instead of sending blanks', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 'a' }, { status: 'ok', id: 'b' }] }));
    await new ExpoPushRelay({ fetch: fetch.impl }).send([message('sender'), message('none')]);
    const [sender, none] = fetch.calls[0]!.body as Array<Record<string, unknown>>;
    expect(sender).toHaveProperty('title', 'Priya mentioned you');
    expect(sender).not.toHaveProperty('body');
    expect(none).not.toHaveProperty('title');
    expect(none).toHaveProperty('body', 'New notification');
  });

  it('inside quiet hours: the quiet channel, passive, normal priority, no sound', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 't' }] }));
    await new ExpoPushRelay({ fetch: fetch.impl }).send([message('full', expoToken(2), true)]);
    const [sent] = fetch.calls[0]!.body as Array<Record<string, unknown>>;
    expect(sent).toMatchObject({ channelId: 'quiet', interruptionLevel: 'passive', priority: 'normal' });
    expect(sent).not.toHaveProperty('sound');
  });

  it('refuses more than Expo takes in one request: chunking is the dispatcher\'s', async () => {
    const fetch = fakeFetch(() => json(200, { data: [] }));
    const many = Array.from({ length: EXPO_SEND_LIMIT + 1 }, (_, i) => message('full', expoToken(i)));
    await expect(new ExpoPushRelay({ fetch: fetch.impl }).send(many)).rejects.toBeInstanceOf(RangeError);
    expect(fetch.calls).toHaveLength(0);
  });

  it('sends nothing for nothing', async () => {
    const fetch = fakeFetch(() => json(200, { data: [] }));
    expect(await new ExpoPushRelay({ fetch: fetch.impl }).send([])).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('send: tickets', () => {
  it('answers one ticket per message, in order, keeping only error CODES', async () => {
    const t1 = expoToken(11);
    const fetch = fakeFetch(() => json(200, {
      data: [
        { status: 'ok', id: 'ticket-a' },
        {
          status: 'error',
          message: `"${t1}" is not a registered push notification recipient`,
          details: { error: 'DeviceNotRegistered', expoPushToken: t1 },
        },
        { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
        { status: 'error', message: 'what', details: { error: 'SomethingNew' } },
        { status: 'error', message: 'no details' },
      ],
    }));
    const tickets = await new ExpoPushRelay({ fetch: fetch.impl })
      .send([message(), message('full', t1), message(), message(), message()]);
    expect(tickets).toEqual([
      { status: 'ok', id: 'ticket-a' },
      { status: 'error', error: 'DeviceNotRegistered' },
      { status: 'error', error: 'MessageTooBig' },
      { status: 'error', error: 'Unknown' },
      { status: 'error', error: 'Unknown' },
    ]);
    expect(JSON.stringify(tickets)).not.toContain('ExponentPushToken');
  });

  it('a ticket count that does not match the messages is not trusted', async () => {
    const fetch = fakeFetch(() => json(200, { data: [{ status: 'ok', id: 'only-one' }] }));
    await expect(new ExpoPushRelay({ fetch: fetch.impl }).send([message(), message()]))
      .rejects.toBeInstanceOf(RelayUnavailableError);
  });
});

describe('send: failures', () => {
  it('429 is "send again later", with the Retry-After the relay asked for', async () => {
    const fetch = fakeFetch(() => json(429, { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'slow down' }] },
      { 'retry-after': '120' }));
    const error = await new ExpoPushRelay({ fetch: fetch.impl }).send([message()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect((error as RelayUnavailableError).retryAfterMs).toBe(120_000);
    expect((error as Error).message).toContain('TOO_MANY_REQUESTS');
  });

  it('5xx and an unreachable relay are "send again later"', async () => {
    const down = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    await expect(new ExpoPushRelay({ fetch: down.impl }).send([message()])).rejects.toBeInstanceOf(RelayUnavailableError);
    const unreachable = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const error = await new ExpoPushRelay({ fetch: unreachable.impl }).send([message()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect((error as Error).message).toContain('ECONNREFUSED');
  });

  it('400 and 401 are refusals: sending the same request again will not help', async () => {
    for (const [status, code] of [[400, 'PUSH_TOO_MANY_EXPERIENCE_IDS'], [401, 'UNAUTHORIZED']] as const) {
      const fetch = fakeFetch(() => json(status, { errors: [{ code, message: `about ${expoToken(5)}` }] }));
      const error = await new ExpoPushRelay({ fetch: fetch.impl }).send([message()]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RelayRejectedError);
      expect((error as Error).message).toContain(code);
      expect((error as Error).message).not.toContain('ExponentPushToken');
    }
  });

  it('no error carries the token it was about', async () => {
    const token = expoToken(77);
    const answers = [
      () => json(400, { errors: [{ code: 'VALIDATION_ERROR', message: `"${token}" is not a valid token` }] }),
      () => json(503, { errors: [{ code: 'INTERNAL', message: token }] }),
      () => new Response(`<html>${token}</html>`, { status: 500 }),
    ];
    for (const answer of answers) {
      const fetch = fakeFetch(answer);
      const error = await new ExpoPushRelay({ fetch: fetch.impl }).send([message('full', token)]).catch((e: unknown) => e);
      expect(String((error as Error).message)).not.toContain(token);
    }
  });
});

describe('receipts', () => {
  it('asks /push/getReceipts in chunks of 1000 and maps each receipt to a code', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `ticket-${i}`);
    const fetch = fakeFetch((call) => {
      const asked = (call.body as { ids: string[] }).ids;
      const data: Record<string, unknown> = {};
      for (const id of asked) {
        data[id] = id === 'ticket-3'
          ? { status: 'error', message: `${expoToken(3)} gone`, details: { error: 'DeviceNotRegistered' } }
          : id === 'ticket-1000' ? { status: 'ok' } : undefined;
      }
      data['not-asked'] = { status: 'error', details: { error: 'DeviceNotRegistered' } };
      return json(200, { data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) });
    });
    const receipts = await new ExpoPushRelay({ fetch: fetch.impl }).receipts(ids);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://exp.host/--/api/v2/push/getReceipts',
      'https://exp.host/--/api/v2/push/getReceipts',
    ]);
    expect((fetch.calls[0]!.body as { ids: string[] }).ids).toHaveLength(1000);
    expect((fetch.calls[1]!.body as { ids: string[] }).ids).toEqual(['ticket-1000']);
    expect(receipts.get('ticket-3')).toEqual({ status: 'error', error: 'DeviceNotRegistered' });
    expect(receipts.get('ticket-1000')).toEqual({ status: 'ok' });
    // A ticket with no receipt yet is absent, and so is one nobody asked about.
    expect(receipts.has('ticket-0')).toBe(false);
    expect(receipts.has('not-asked')).toBe(false);
  });
});

describe('scrubPushTokens', () => {
  it('masks Expo push tokens in text that is not ours', () => {
    expect(scrubPushTokens(`bad ${expoToken(9)} and ExpoPushToken[abc]`))
      .toBe('bad ExponentPushToken[…] and ExponentPushToken[…]');
  });
});
