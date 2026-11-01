import { describe, expect, it } from 'vitest';
import { CollabError, type GroupFrame, type GroupMembersFrame, type ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub } from '../../src/bridges/runtime/hub.js';
import { bridgeGroupPort } from '../../src/bridges/commands/index.js';
import type { Db } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

const input = { connectionId: 'c1', requestId: 'r1', subject: 'Design review', participants: ['person@lid'], sourceConversationId: 'source@g.us' };
const community = { id: 'community@g.us', name: 'Acme Community' };

function runtime(version: number, answer: GroupFrame | GroupMembersFrame | null) {
  const sent: ServerFrame[] = [];
  const db = { rpc: async (_claims: unknown, fn: string) => fn === 'bridge_runtime_of' ? 'rt' : [] } as unknown as Db;
  const hub = new BridgeRuntimeHub({ db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }) });
  const sink = {
    id: 'sink', isOpen: true,
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if ((frame.type === 'group.create' || frame.type === 'group.members') && answer) hub.settleRequest(frame.requestId, answer);
    },
    close() {}, onMessage() {}, onClose() {},
  } as unknown as EventSink;
  (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set('rt', { runtimeId: 'rt', sink, provider: 'whatsapp' });
  hub.noteHello('rt', 'whatsapp', version);
  return { hub, port: bridgeGroupPort(db, () => hub), sent };
}

describe('community group creation through hub and command port', () => {
  it('forwards the source group and returns the community', async () => {
    const { hub, port, sent } = runtime(2, { requestId: input.requestId, connectionId: input.connectionId,
      conversationId: 'new@g.us', subject: input.subject, results: [], inviteLink: null, community });
    try {
      expect((await port.create(input)).community).toEqual(community);
      expect(sent.filter(f => f.type === 'group.create')).toEqual([{ type: 'group.create', ...input }]);
    } finally { await hub.stop(); }
  });

  for (const code of ['not_community_admin', 'community_create_failed'] as const) {
    it(`preserves ${code}, community details and partial group id without automatic retry`, async () => {
      const message = "Can't split in *Acme Community*";
      const { hub, port } = runtime(2, { requestId: input.requestId, connectionId: input.connectionId,
        error: message, code, community, createdConversationId: 'partial@g.us' });
      try {
        const error = await port.create(input).catch(e => e);
        expect(error).toBeInstanceOf(CollabError);
        expect(error).toMatchObject({ code: code === 'not_community_admin' ? code : 'upstream_unavailable',
          message, retryable: false, details: { reason: code, community, conversationId: 'partial@g.us' } });
      } finally { await hub.stop(); }
    });
  }

  it('refuses a split on an older runtime before sending anything, while plain creation still works', async () => {
    const { hub, port, sent } = runtime(1, { requestId: input.requestId, connectionId: input.connectionId,
      conversationId: 'standalone@g.us', subject: input.subject, results: [], inviteLink: null });
    try {
      await expect(port.create(input)).rejects.toMatchObject({ retryable: false, details: { reason: 'community_create_failed' } });
      expect(sent.filter(f => f.type === 'group.create')).toEqual([]);
      const { sourceConversationId: _source, ...plain } = input;
      await expect(hub.createGroup('rt', plain)).resolves.toMatchObject({ conversationId: 'standalone@g.us' });
    } finally { await hub.stop(); }
  });

  it('forwards a scoped member identity request and returns PN/LID aliases', async () => {
    const members = [{ ids: ['919000000001@s.whatsapp.net', '188888888888881@lid'], name: 'Maya' }];
    const { hub, port, sent } = runtime(3, { requestId: 'members', connectionId: input.connectionId, members, self: [] });
    try {
      const request = { connectionId: input.connectionId, conversationId: input.sourceConversationId, requestId: 'members' };
      await expect(port.members(request)).resolves.toEqual({ members, self: [] });
      expect(sent.filter(f => f.type === 'group.members')).toEqual([{ type: 'group.members', ...request }]);
    } finally { await hub.stop(); }
  });

  it('refuses identity resolution on older runtimes before sending anything', async () => {
    const { hub, port, sent } = runtime(2, null);
    try {
      await expect(port.members({ connectionId: input.connectionId, conversationId: input.sourceConversationId, requestId: 'members' }))
        .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('Upgrade') });
      expect(sent.filter(f => f.type === 'group.members')).toEqual([]);
    } finally { await hub.stop(); }
  });

  it('reports an unconfirmed split after a lost runtime answer so the caller does not automatically retry creation', async () => {
    const { hub, sent } = runtime(2, null);
    try {
      const frame = await hub.createGroup('rt', input, 10);
      expect(frame).toMatchObject({ code: 'community_create_failed', error: expect.stringContaining('a group may have been created') });
      expect(sent.filter(f => f.type === 'group.create')).toHaveLength(1);
    } finally { await hub.stop(); }
  });
});
