/**
 * Slack lane A: the hub picks a runtime by the connection's provider and never
 * another provider's; it keeps each runtime's capability sheet from hello and
 * fits frames to it; it refuses group creation on Slack.
 */
import { describe, expect, it } from 'vitest';
import { SLACK_CAPABILITIES, WHATSAPP_CAPABILITIES, type ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub } from '../../src/bridges/runtime/hub.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

const caller: DbClaims = { identityId: 'owner-identity', authKind: 'browser', requestId: 'r1' };

function harness(take: () => { runtimeId: string; frame: ServerFrame }[] = () => []) {
  let taken = false;
  const db = {
    rpc: async (_claims: DbClaims, fn: string) => {
      if (fn === 'internal.bridge_runtime_connect') return { allowlist: { type: 'allowlist', connectionId: 'c1', version: 1, conversationIds: [] } };
      if (fn === 'internal.bridge_outbox_take') {
        if (taken) return [];
        taken = true;
        return take();
      }
      return [];
    },
  } as unknown as Db;
  const hub = new BridgeRuntimeHub({ db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }) });
  const got = new Map<string, ServerFrame[]>();
  const add = (runtimeId: string, provider: string | null, capabilities: unknown = null) => {
    const frames: ServerFrame[] = [];
    got.set(runtimeId, frames);
    const sink: EventSink = {
      id: runtimeId, identity: { kind: 'bearer' }, isOpen: true, send: (t: string) => { frames.push(JSON.parse(t) as ServerFrame); },
      close: () => undefined, onMessage: () => undefined, onClose: () => undefined,
    } as unknown as EventSink;
    (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set(runtimeId, { runtimeId, sink, provider: null, capabilities: null });
    if (provider) hub.noteHello(runtimeId, provider, provider === 'slack' ? 4 : 3, capabilities);
  };
  return { hub, got, add };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('BridgeRuntimeHub provider routing', () => {
  it('never routes a Slack connection to the WhatsApp runtime, even when it is the only one', async () => {
    const { hub, got, add } = harness();
    add('wa', 'whatsapp', WHATSAPP_CAPABILITIES);
    expect(await hub.connect({ provider: 'slack', connectionId: 'c1',
      credential: { kind: 'slack_tokens', botToken: 'xoxb-1-2-a', appToken: 'xapp-1-A-2-b' } }, caller)).toBeNull();
    expect(got.get('wa')!.filter((f) => f.type === 'connect')).toEqual([]);
  });

  it('routes each provider to its own runtime and puts the credential on Slack\'s connect only', async () => {
    const { hub, got, add } = harness();
    add('wa', 'whatsapp', WHATSAPP_CAPABILITIES);
    add('sl', 'slack', SLACK_CAPABILITIES);
    const credential = { kind: 'slack_tokens' as const, botToken: 'xoxb-1-2-a', appToken: 'xapp-1-A-2-b' };
    expect(await hub.connect({ provider: 'slack', connectionId: 'c1', credential }, caller)).toEqual({ runtimeId: 'sl' });
    expect(await hub.connect({ provider: 'whatsapp', connectionId: 'c2', authFlow: { kind: 'qr' } }, caller)).toEqual({ runtimeId: 'wa' });
    expect(got.get('sl')!.find((f) => f.type === 'connect')).toMatchObject({ connectionId: 'c1', credential });
    const wa = got.get('wa')!.find((f) => f.type === 'connect')!;
    expect(wa).toMatchObject({ connectionId: 'c2', authFlow: { kind: 'qr' } });
    expect(wa).not.toHaveProperty('credential');
  });

  it('takes a lone runtime that has not said hello yet', async () => {
    const { hub, add } = harness();
    add('fresh', null);
    expect(await hub.connect({ provider: 'slack', connectionId: 'c1' }, caller)).toEqual({ runtimeId: 'fresh' });
  });

  it('refuses group.create and group.add on a Slack runtime without asking it', async () => {
    const { hub, got, add } = harness();
    add('sl', 'slack', SLACK_CAPABILITIES);
    const created = await hub.createGroup('sl', { requestId: 'q1', connectionId: 'c1', subject: 'x', participants: [] });
    expect(created).toMatchObject({ requestId: 'q1', error: expect.stringContaining('Slack') });
    const added = await hub.addToGroup('sl', { requestId: 'q2', connectionId: 'c1', conversationId: 'C1', participants: ['U1'] });
    expect(added).toMatchObject({ requestId: 'q2', error: expect.stringContaining('Slack') });
    expect(got.get('sl')).toEqual([]);
  });
});

describe('BridgeRuntimeHub capability sheet', () => {
  const send = (runtimeId: string, connectionId: string): { runtimeId: string; frame: ServerFrame } => ({ runtimeId, frame: {
    type: 'send', outboxId: `o-${runtimeId}`, connectionId, conversationId: 'X', text: 'hi', threadTs: '1.2',
    voice: { username: 'Infra Bot', iconUrl: null },
  } });

  it('skips typing and read where the sheet says false, and keeps them where it says true', async () => {
    const { hub, got, add } = harness(() => [
      { runtimeId: 'sl', frame: { type: 'typing', connectionId: 'c1', conversationId: 'C1', state: 'composing' } },
      { runtimeId: 'sl', frame: { type: 'read', connectionId: 'c1', conversationId: 'C1', messages: [] } },
      { runtimeId: 'wa', frame: { type: 'typing', connectionId: 'c2', conversationId: 'G', state: 'composing' } },
    ]);
    add('wa', 'whatsapp', WHATSAPP_CAPABILITIES);
    add('sl', 'slack', SLACK_CAPABILITIES);
    hub.kick();
    await settle();
    expect(got.get('sl')).toEqual([]);
    expect(got.get('wa')!.map((f) => f.type)).toEqual(['typing']);
  });

  it('sends threadTs and voice only where the sheet has native threads and perUserVoice', async () => {
    const { hub, got, add } = harness(() => [send('sl', 'c1'), send('wa', 'c2')]);
    add('wa', 'whatsapp', WHATSAPP_CAPABILITIES);
    add('sl', 'slack', SLACK_CAPABILITIES);
    hub.kick();
    await settle();
    expect(got.get('sl')![0]).toMatchObject({ type: 'send', threadTs: '1.2', voice: { username: 'Infra Bot', iconUrl: null } });
    const wa = got.get('wa')![0]!;
    expect(wa).toMatchObject({ type: 'send', text: 'hi' });
    expect(wa).not.toHaveProperty('threadTs');
    expect(wa).not.toHaveProperty('voice');
  });
});
