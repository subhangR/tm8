/**
 * 431: BridgeRuntimeHub turns a send row's attachments (`files`, server-only)
 * into the frame's `media`. The first readable file goes as the media message,
 * captioned with the text; any file it could not send is named in the caption.
 * Storage paths never reach the runtime.
 */
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub, type OutboundFile } from '../../src/bridges/runtime/hub.js';
import type { Db } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

const SPACE = '00000000-0000-4000-8000-000000000001';

function file(name: string, mime: string, size: number, storagePath = `spaces/${SPACE}/${name}`): OutboundFile {
  return { fileEntityId: `f-${name}`, spaceId: SPACE, storagePath, name, mime, size };
}

/** One pump: the outbox answers `frame`; returns what the runtime received. */
async function dispatch(frame: Record<string, unknown>, blobs?: Record<string, Buffer>): Promise<Extract<ServerFrame, { type: 'send' }>> {
  const got: ServerFrame[] = [];
  const db = { rpc: async (_c: unknown, fn: string) => fn === 'internal.bridge_outbox_take' ? [{ runtimeId: 'rt', frame }] : [] } as unknown as Db;
  const hub = new BridgeRuntimeHub({
    db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }), log: () => undefined,
    ...(blobs ? {
      blobStore: {
        read: async (path: string) => {
          const b = blobs[path];
          if (!b) throw new Error('blob bytes are not available');
          return b;
        },
      },
    } : {}),
  });
  const sink: EventSink = {
    id: 's', identity: { kind: 'bearer' }, isOpen: true, send: (t: string) => { got.push(JSON.parse(t) as ServerFrame); },
    close: () => undefined, onMessage: () => undefined, onClose: () => undefined,
  };
  (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set('rt', { runtimeId: 'rt', sink, provider: 'whatsapp' });
  await (hub as unknown as { pump(): Promise<void> }).pump();
  expect(got).toHaveLength(1);
  return got[0] as Extract<ServerFrame, { type: 'send' }>;
}

const base = { type: 'send', outboxId: 'ob1', connectionId: 'c1', conversationId: '1203@g.us', text: 'Owner: look' };

describe('BridgeRuntimeHub outbound media (431)', () => {
  it('an image goes as an image, captioned with the text; storage paths never leave', async () => {
    const png = Buffer.from('89504e47', 'hex');
    const sent = await dispatch({ ...base, files: [file('a.png', 'image/png', png.length)] }, { [`spaces/${SPACE}/a.png`]: png });
    expect(sent).toEqual({ type: 'send', outboxId: 'ob1', connectionId: 'c1', conversationId: '1203@g.us',
      media: { kind: 'image', mime: 'image/png', fileName: 'a.png', caption: 'Owner: look', data: png.toString('base64') } });
  });

  it('a non-image, or an image past 16 MB, goes as a document; further files are named', async () => {
    const pdf = Buffer.from('%PDF');
    const sent = await dispatch({ ...base, files: [file('r.pdf', 'application/pdf', 4), file('b.png', 'image/png', 9)] },
      { [`spaces/${SPACE}/r.pdf`]: pdf });
    expect(sent.media).toMatchObject({ kind: 'document', fileName: 'r.pdf', caption: 'Owner: look\n[b.png: in tm8]' });
    const big = await dispatch({ ...base, files: [file('huge.png', 'image/png', 17 * 1024 * 1024)] },
      { [`spaces/${SPACE}/huge.png`]: Buffer.from('x') });
    expect(big.media).toMatchObject({ kind: 'document', fileName: 'huge.png' });
  });

  it('an unreadable file is named and the next one is sent', async () => {
    const jpg = Buffer.from('ffd8', 'hex');
    const sent = await dispatch({ ...base, files: [file('gone.png', 'image/png', 3), file('ok.jpg', 'image/jpeg', 2)] },
      { [`spaces/${SPACE}/ok.jpg`]: jpg });
    expect(sent.media).toMatchObject({ kind: 'image', fileName: 'ok.jpg', caption: 'Owner: look\n[gone.png: in tm8]' });
  });

  it('with no blob store, or nothing readable, the text goes alone and names the files', async () => {
    const sent = await dispatch({ ...base, files: [file('a.png', 'image/png', 3)] });
    expect(sent).toEqual({ type: 'send', outboxId: 'ob1', connectionId: 'c1', conversationId: '1203@g.us', text: 'Owner: look\n[a.png: in tm8]' });
  });

  it('a frame without files is sent as it was', async () => {
    expect(await dispatch({ ...base })).toEqual(base);
  });
});
