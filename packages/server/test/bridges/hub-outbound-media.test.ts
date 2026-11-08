/** Outbound control frames contain references, never file bytes or storage paths. */
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub, type OutboundFile } from '../../src/bridges/runtime/hub.js';
import type { Db } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

const SPACE = '00000000-0000-4000-8000-000000000001';
function file(name: string, mime: string, size: number): OutboundFile {
  return { fileEntityId: `f-${name}`, spaceId: SPACE, storagePath: `spaces/${SPACE}/${name}`, name, mime, size };
}
const base = { type: 'send', outboxId: 'ob1', connectionId: 'c1', conversationId: '1203@g.us', text: 'Owner: look' };

async function dispatch(frame: Record<string, unknown>, protocolVersion = 3): Promise<ServerFrame[]> {
  const got: ServerFrame[] = [];
  const db = { rpc: async (_c: unknown, fn: string, args: unknown[]) => {
    if (fn !== 'internal.bridge_outbox_take') return [];
    expect(args[1]).toBe(1); // never lease a backlog behind a slow upload
    return (args[0] as string[]).includes('rt') ? [{ runtimeId: 'rt', frame }] : [];
  } } as unknown as Db;
  const hub = new BridgeRuntimeHub({ db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }) });
  const sink: EventSink = { id: 's', identity: { kind: 'bearer' }, isOpen: true,
    send: (t) => { got.push(JSON.parse(t)); }, close: () => {}, onMessage: () => {}, onClose: () => {} };
  (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set('rt', { runtimeId: 'rt', sink, provider: 'whatsapp', protocolVersion });
  await (hub as unknown as { pump(): Promise<void> }).pump();
  return got;
}

describe('BridgeRuntimeHub streamed outbound media', () => {
  it.each([['a.png', 'image/png', 2 * 1024 * 1024, 'image'], ['r.pdf', 'application/pdf', 2_000_000_000, 'document'],
    ['huge.png', 'image/png', 32 * 1024 * 1024, 'document']] as const)('references %s without a whole-file frame ceiling', async (name, mime, size, kind) => {
    const [sent] = await dispatch({ ...base, files: [file(name, mime, size)] });
    expect(sent).toEqual({ type: 'send', outboxId: 'ob1', connectionId: 'c1', conversationId: '1203@g.us',
      media: { kind, mime, fileName: name, caption: 'Owner: look', fileEntityId: `f-${name}` } });
    expect(JSON.stringify(sent).length).toBeLessThan(500);
  });
  it('names further attachments while preserving one receipt per outbox row', async () => {
    const [sent] = await dispatch({ ...base, files: [file('r.pdf', 'application/pdf', 4), file('b.png', 'image/png', 9)] });
    expect(sent).toHaveProperty('media.caption', 'Owner: look\n[b.png: in tm8]');
  });
  it('leaves text frames unchanged', async () => {
    expect(await dispatch(base)).toEqual([base]);
  });
  it('does not dispatch to an old runtime that cannot consume file references', async () => {
    expect(await dispatch({ ...base, files: [file('r.pdf', 'application/pdf', 4)] }, 2)).toEqual([]);
  });
});
