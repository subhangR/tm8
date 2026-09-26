/**
 * Attention v2 S4 — the delivery sweep's TS half and the bearer-only source.
 * The SQL doors are pinned by test/db/attention-v2-verbs.pg.test.ts; this
 * pins whose claims each door runs under and what is dispatched after commit.
 */
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import type { RequestContext } from '../../src/http/types.js';
import {
  createAttentionDeliveryJob,
  runAttentionDeliveryTick,
  sourceSessionOf,
} from '../../src/facade/services/attention/index.js';

interface Call { claims: DbClaims; fn: string; args: unknown[] }

function fakeDb(answers: Record<string, (args: unknown[]) => unknown>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (claims: DbClaims, fn: string, args: unknown[]) => {
      calls.push({ claims, fn, args });
      const answer = answers[fn];
      if (!answer) throw new Error(`unexpected rpc ${fn}`);
      return answer(args);
    },
  } as unknown as Db;
  return { db, calls };
}

const OWNER: DbClaims = { identityId: 'owner-identity', nodeAdmin: true, requestId: 'attention-delivery' };

describe('attention delivery sweep', () => {
  it('an idle tick reads once and is a quiet skip', async () => {
    const { db, calls } = fakeDb({ 'public.list_due_attention_notes': () => [] });
    expect(await runAttentionDeliveryTick({ db, ownerClaims: async () => OWNER })).toEqual({
      skipped: true, reason: 'no attention notes due',
    });
    expect(calls.map((c) => c.fn)).toEqual(['public.list_due_attention_notes']);
    const job = createAttentionDeliveryJob({ db, ownerClaims: async () => OWNER });
    expect(job).toMatchObject({ intervalMs: 2000, quietSkips: true, runOnStart: true });
  });

  it('posts as the resolver, records routes, dispatches, and wakes a chat', async () => {
    const dispatched: unknown[] = [];
    const woken: [string, string][] = [];
    const { db, calls } = fakeDb({
      'public.list_due_attention_notes': () => [
        { batchId: 'b-member', spaceId: 's', resolverId: 'm', resolverIdentityId: 'member-identity' },
        { batchId: 'b-agent', spaceId: 's', resolverId: 't', resolverIdentityId: null },
      ],
      'public.deliver_attention_batch': ([batch]) => (batch === 'b-member'
        ? { posted: [
            { messageId: 'm1', anchorId: 'session-1', anchorKind: 'work_session', chatIdentityId: null },
            { messageId: 'm2', anchorId: 'chat-1', anchorKind: 'chat', chatIdentityId: 'chat-owner' },
          ] }
        : { posted: [] }),
      'public.w2_record_session_message_routes': () => [{ targetMessageId: 'm1' }],
    });
    const outcome = await runAttentionDeliveryTick({
      db,
      ownerClaims: async () => OWNER,
      dispatch: async (posted) => { dispatched.push(posted); },
      wakeChat: (chatId, identity) => { woken.push([chatId, identity]); },
    });
    expect(outcome).toMatchObject({ affected: 2, detail: { batches: 2, messages: 2, failed: [] } });

    const deliver = calls.filter((c) => c.fn === 'public.deliver_attention_batch');
    expect(deliver[0]!.claims).toEqual({ identityId: 'member-identity', requestId: 'attention-note:b-member' });
    // A teammate resolver has no identity: the owner's claims act as it.
    expect(deliver[1]!.claims).toMatchObject({ identityId: 'owner-identity', nodeAdmin: true });
    const routes = calls.filter((c) => c.fn === 'public.w2_record_session_message_routes');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.args).toEqual([['m1', 'm2'], null]);
    expect(dispatched).toEqual([{ routes: [{ targetMessageId: 'm1' }], workSessionId: 'b-member' }]);
    expect(woken).toEqual([['chat-1', 'chat-owner']]);
  });

  it('one failing batch does not stop the next', async () => {
    const { db } = fakeDb({
      'public.list_due_attention_notes': () => [
        { batchId: 'bad', spaceId: 's', resolverId: 'm', resolverIdentityId: 'x' },
        { batchId: 'good', spaceId: 's', resolverId: 'm', resolverIdentityId: 'x' },
      ],
      'public.deliver_attention_batch': ([batch]) => {
        if (batch === 'bad') throw new Error('boom');
        return { posted: [{ messageId: 'm', anchorId: 'task', anchorKind: 'task', chatIdentityId: null }] };
      },
    });
    const outcome = await runAttentionDeliveryTick({ db, ownerClaims: async () => OWNER });
    expect(outcome).toMatchObject({ affected: 1, detail: { batches: 1, failed: ['bad: boom'] } });
  });
});

describe('sourceSessionOf (F1a)', () => {
  const ctx = (identity: RequestContext['identity']) => ({ identity }) as RequestContext;
  it('reads only the verified bearer: work session first, then chat, never the body', () => {
    expect(sourceSessionOf(ctx({ kind: 'bearer', workSessionId: 'ws', runtimeChatId: 'chat' }))).toBe('ws');
    expect(sourceSessionOf(ctx({ kind: 'bearer', runtimeChatId: 'chat' }))).toBe('chat');
    expect(sourceSessionOf(ctx({ kind: 'bearer' }))).toBeNull();
    expect(sourceSessionOf(ctx({ kind: 'auto-owner', workSessionId: 'ws' } as RequestContext['identity']))).toBeNull();
    expect(sourceSessionOf({ identity: { kind: 'anonymous' }, body: { workSessionId: 'forged' } } as unknown as RequestContext)).toBeNull();
  });
});
