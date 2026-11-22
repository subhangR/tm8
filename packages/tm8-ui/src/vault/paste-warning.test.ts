/**
 * vault/paste-warning.ts, and the real seam handing it every post and chat start (data/real/seam-real.ts).
 *
 * The node is a fake fetch, so nothing here reaches a network. The warning text is a stand-in: the
 * server writes the real one (packages/server/src/vault/paste-guard.ts), and it names kinds only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VAULT_PASTE_WARNING_CODE, type MessageBatchResult, type PostMessageInput, type StartChatInput } from '@tm8/contract';
import type { Notice } from '../shell/notices';
import { createRealSeam } from '../data/real/seam-real';
import { FakeClock, fakeFetch, fakeSocketPool, type FakeReply } from '../data/real/test-support';
import {
  PASTE_NOTICE_ACTION, PASTE_NOTICE_ID, PASTE_NOTICE_TITLE, PASTE_NOTICE_TTL_MS,
  pasteWarningOf, registerPasteWarningHost, surfacePasteWarning,
} from './paste-warning';

const MESSAGE = 'That message looked like it held a secret (a GitHub token). Treat it as exposed anyway.';
const pasteWarning = { code: VAULT_PASTE_WARNING_CODE, message: MESSAGE };
const otherWarning = { code: 'mention_unresolved', message: 'Nobody here is called @sam.' };

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

function host(openVault?: () => void) {
  const pushed: Notice[] = [];
  unregister = registerPasteWarningHost({ push: (notice) => pushed.push(notice), ...(openVault ? { openVault } : {}) });
  return pushed;
}

describe('pasteWarningOf', () => {
  it('finds the paste warning among the others a write answered', () => {
    expect(pasteWarningOf({ warnings: [otherWarning, pasteWarning] })).toEqual(pasteWarning);
  });

  it('is null for a result with no paste warning, or nothing usable', () => {
    for (const result of [undefined, null, 'text', {}, { warnings: null }, { warnings: [otherWarning] },
      { warnings: [null, 7, { code: VAULT_PASTE_WARNING_CODE }, { code: VAULT_PASTE_WARNING_CODE, message: 3 }] }]) {
      expect(pasteWarningOf(result)).toBeNull();
    }
  });
});

describe('surfacePasteWarning', () => {
  it('shows the server text as one warning notice that offers the vault, and returns the result itself', () => {
    const openVault = vi.fn();
    const pushed = host(openVault);
    const result = { messages: [], warnings: [pasteWarning] };
    expect(surfacePasteWarning(result)).toBe(result);
    expect(pushed).toHaveLength(1);
    const [notice] = pushed;
    expect(notice).toMatchObject({ id: PASTE_NOTICE_ID, tone: 'warn', title: PASTE_NOTICE_TITLE, body: MESSAGE, ttlMs: PASTE_NOTICE_TTL_MS });
    expect(notice?.action?.label).toBe(PASTE_NOTICE_ACTION);
    notice?.action?.run();
    expect(openVault).toHaveBeenCalledTimes(1);
  });

  it('offers no vault where the page has no vault section', () => {
    const pushed = host();
    surfacePasteWarning({ warnings: [pasteWarning] });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.action).toBeUndefined();
  });

  it('shows nothing for a write without a paste warning', () => {
    const pushed = host();
    surfacePasteWarning({ warnings: [otherWarning] });
    surfacePasteWarning({ messages: [] });
    expect(pushed).toHaveLength(0);
  });

  it('returns the result when no shell is listening, and when the notice itself fails', () => {
    const result = { warnings: [pasteWarning] };
    expect(surfacePasteWarning(result)).toBe(result);
    unregister = registerPasteWarningHost({ push: () => { throw new Error('notice queue is gone'); } });
    expect(surfacePasteWarning(result)).toBe(result);
  });

  it('a stale un-register leaves the newer host in place', () => {
    const first = host();
    const dropFirst = unregister;
    const second = host();
    dropFirst?.();
    surfacePasteWarning({ warnings: [pasteWarning] });
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});

describe('the real seam hands its posts and chat starts to the paste warning', () => {
  function seamAnswering(route: (url: string, method: string) => FakeReply) {
    const clock = new FakeClock();
    const pool = fakeSocketPool();
    const f = fakeFetch((call) => route(call.url, call.method));
    const seam = createRealSeam({
      baseUrl: '', wsUrl: 'ws://fake.invalid/v2/ws', fetch: f.fetch, webSocketFactory: pool.factory,
      timers: clock.timers, now: clock.now, random: clock.random,
    });
    return { seam, f };
  }

  const post: PostMessageInput = { clientMutationId: 'paste-warning-post', anchorIds: ['01a1fa87-dd1a-7f7c-b384-e8dc90f576b6'], body: 'deploy key: [redacted:github_token]' };
  const start: StartChatInput = {
    clientMutationId: 'paste-warning-start', spaceId: '01a1fa87-dd1a-7f7c-b384-e8dc90f576b6',
    teammateId: '01a1783f-b739-7262-aba9-8f94076efdf3', model: 'claude-opus-5-5', mode: 'ask', workdirMode: 'scratch',
    body: 'deploy with [redacted:github_token]',
  };

  it('messages.post: a paste warning reaches the shell, and the result is the node\'s answer', async () => {
    const answer: MessageBatchResult = { messages: [], warnings: [pasteWarning] } as unknown as MessageBatchResult;
    const { seam, f } = seamAnswering(() => ({ data: answer }));
    const pushed = host(() => undefined);
    await expect(seam.commands.postMessage(post)).resolves.toEqual(answer);
    expect(f.last().url.endsWith('/v2/messages')).toBe(true);
    expect(pushed.map((n) => n.body)).toEqual([MESSAGE]);
  });

  it('chat.start: a paste warning reaches the shell', async () => {
    const answer = { chat: { id: 'c1' }, warnings: [pasteWarning] };
    const { seam, f } = seamAnswering(() => ({ data: answer }));
    const pushed = host(() => undefined);
    await expect(seam.commands.startChat(start)).resolves.toEqual(answer);
    expect(f.last().url.endsWith('/v2/chats')).toBe(true);
    expect(pushed.map((n) => n.body)).toEqual([MESSAGE]);
  });

  it('a write the node answered without one shows nothing, and a refused write rejects as before', async () => {
    const pushed = host(() => undefined);
    const clean = seamAnswering(() => ({ data: { messages: [] } }));
    await clean.seam.commands.postMessage(post);
    const refused = seamAnswering(() => ({ status: 400, error: { code: 'invalid_input', message: 'too long to store', requestId: 'r', retryable: false } }));
    await expect(refused.seam.commands.startChat(start)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(pushed).toHaveLength(0);
  });
});
