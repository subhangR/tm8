/**
 * BridgeRuntimeHub.connect (422, option B): a member request. The hub calls
 * internal.bridge_runtime_connect under the CALLER's claims, never the bridges
 * worker's backgroundJob claim.
 */
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub } from '../../src/bridges/runtime/hub.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

describe('BridgeRuntimeHub.connect', () => {
  it('binds the runtime under the caller\'s own claims and never the backgroundJob claim', async () => {
    const seen: Array<{ claims: DbClaims; fn: string }> = [];
    const db = {
      rpc: async (claims: DbClaims, fn: string) => {
        seen.push({ claims, fn });
        return fn === 'internal.bridge_runtime_connect'
          ? { allowlist: { type: 'allowlist', connectionId: 'c1', version: 1, conversationIds: [] } }
          : [];
      },
    } as unknown as Db;
    const hub = new BridgeRuntimeHub({ db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }) });
    const got: ServerFrame[] = [];
    const sink: EventSink = {
      id: 's', identity: { kind: 'bearer' }, isOpen: true, send: (t: string) => { got.push(JSON.parse(t) as ServerFrame); },
      close: () => undefined, onMessage: () => undefined, onClose: () => undefined,
    };
    (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set('rt-a', { runtimeId: 'rt-a', sink, provider: 'whatsapp' });
    const caller: DbClaims = { identityId: 'owner-identity', authKind: 'cli', requestId: 'r1' };
    expect(await hub.connect({ provider: 'whatsapp', connectionId: 'c1' }, caller)).toEqual({ runtimeId: 'rt-a' });
    const call = seen.find(s => s.fn === 'internal.bridge_runtime_connect')!;
    expect(call.claims).toBe(caller);
    expect(call.claims).not.toHaveProperty('backgroundJob');
    expect(got[0]).toMatchObject({ type: 'connect', connectionId: 'c1' });
  });
});
