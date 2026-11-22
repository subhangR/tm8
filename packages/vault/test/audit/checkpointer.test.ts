import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditCheckpointer, FileCheckpointSink, LocalEd25519CheckpointSigner, OffCheckpointSink } from '../../src/audit/checkpointer.js';
import { checkpointSigningInput } from '../../src/audit/chain.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { CheckpointReadError, actorOf } from '../../src/core-types.js';
import { FixedClock, OWNER_ID, SPACE_A, scopeOf, testCaller } from '../support/kit.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), 'vault-checkpoint-')); dirs.push(dir); return dir; };

describe('audit checkpoints', () => {
  it('signs the exact bytes, puts create-only metadata, then records the receipt', async () => {
    const dir = await temporary(); const keyFile = join(dir, 'signing-key');
    const pair = generateKeyPairSync('ed25519');
    await writeFile(keyFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const signer = new LocalEd25519CheckpointSigner({ name: 'test', keyFile, mode: 'dev' });
    const sink = new FileCheckpointSink(join(dir, 'checkpoints'));
    const store = new MemoryVaultStore(); const clock = new FixedClock();
    const checkpointer = new AuditCheckpointer({ store, signer, sink, clock });
    const record = await checkpointer.checkpoint();
    expect(record).toMatchObject({ seq: 0, sink: 'file', anchored: true, keyId: 'local-dev:test' });
    expect(verify(null, checkpointSigningInput({ ...record, keyId: record.keyId! }), pair.publicKey, Buffer.from(record.signature!, 'base64url'))).toBe(true);
    expect(JSON.parse(await readFile(record.location!, 'utf8'))).toMatchObject({ seq: 0, signature: record.signature });
    expect(await store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.latestCheckpoint())).toEqual(record);
    await expect(checkpointer.checkpoint()).rejects.toThrow('file sink write failed');
    expect(await sink.health()).toEqual({ ok: true, retention: 'not_applicable' });
  });
  it('never records a checkpoint when signing or the put fails', async () => {
    const store = new MemoryVaultStore(); const sink = new OffCheckpointSink();
    const failed = new AuditCheckpointer({ store, sink, signer: { keyId: 'test', sign: async () => { throw new Error('test signer failed'); } } });
    await expect(failed.checkpoint()).rejects.toThrow('test signer failed');
    const putFailure = new AuditCheckpointer({ store, signer: { keyId: 'test', sign: async () => Buffer.alloc(64) }, sink: { kind: 'file', health: sink.health.bind(sink), latest: async () => null, put: async () => { throw new Error('test put failed'); } } });
    await expect(putFailure.checkpoint()).rejects.toThrow('test put failed');
    expect(await store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.latestCheckpoint())).toBeNull();
    const off = await new AuditCheckpointer({ store, sink, signer: { keyId: 'test', sign: async () => Buffer.alloc(64) } }).run();
    expect(off).toMatchObject({ sink: 'off', anchored: false, location: null });
  });
  it('refuses local signing in production and insecure or non-Ed25519 key files', async () => {
    const dir = await temporary(); const path = join(dir, 'key');
    const pair = generateKeyPairSync('ed25519');
    await writeFile(path, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o644 });
    expect(() => new LocalEd25519CheckpointSigner({ mode: 'production', name: 'test', keyFile: path })).toThrow('local signer refused');
    expect(() => new LocalEd25519CheckpointSigner({ mode: 'dev', name: 'test', keyFile: path })).toThrow('signing key unavailable');
    expect(() => new LocalEd25519CheckpointSigner({ mode: 'dev', name: '../bad', keyFile: path })).toThrow('invalid key name');
  });
  it('the scheduled form anchors only a head that no recorded checkpoint covers', async () => {
    const dir = await temporary();
    const store = new MemoryVaultStore();
    const puts: number[] = [];
    const sink = new FileCheckpointSink(join(dir, 'checkpoints'));
    const counting = { kind: sink.kind, health: sink.health.bind(sink), latest: sink.latest.bind(sink), put: async (checkpoint: Parameters<typeof sink.put>[0]) => { puts.push(checkpoint.seq); return sink.put(checkpoint); } };
    const checkpointer = new AuditCheckpointer({ store, sink: counting, signer: { keyId: 'test', sign: async () => Buffer.alloc(64, 1) } });
    const append = () => store.transaction(scopeOf(testCaller), (tx) => tx.audit.append({ action: 'session.signed_in', actor: actorOf(testCaller),
      itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: {} }));
    expect(await checkpointer.checkpointIfAdvanced()).toBeNull();
    await append();
    expect(await checkpointer.checkpointIfAdvanced()).toMatchObject({ seq: 1, anchored: true });
    // A restart with no new events: the create-only sink would refuse a second put of the same head.
    expect(await checkpointer.checkpointIfAdvanced()).toBeNull();
    await append(); await append();
    expect(await checkpointer.checkpointIfAdvanced()).toMatchObject({ seq: 3 });
    expect(puts).toEqual([1, 3]);
  });
});

describe('file checkpoint read-back (review F01)', () => {
  async function fileKit() {
    const dir = await temporary(); const keyFile = join(dir, 'signing-key');
    await writeFile(keyFile, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const signer = new LocalEd25519CheckpointSigner({ name: 'test', keyFile, mode: 'pre_review' });
    const directory = join(dir, 'checkpoints');
    await mkdir(directory, { mode: 0o700 });
    const at = new FixedClock().iso();
    const signed = async (seq: number, headHash: string) => {
      const unsigned = { seq, headHash, at, keyId: signer.keyId };
      return { ...unsigned, signature: (await signer.sign(checkpointSigningInput(unsigned))).toString('base64url') };
    };
    return { dir, directory, signer, sink: new FileCheckpointSink(directory), signed };
  }
  const code = async (promise: Promise<unknown>): Promise<string> => {
    try { await promise; } catch (error) { expect(error).toBeInstanceOf(CheckpointReadError); return (error as CheckpointReadError).code; }
    throw new Error('test expected a CheckpointReadError');
  };

  it('reads back exactly what put wrote: the highest seq at or above from, unrelated names ignored', async () => {
    const { directory, sink, signed } = await fileKit();
    expect(await sink.latest()).toBeNull();
    const one = await signed(1, 'a'.repeat(64)); const three = await signed(3, 'b'.repeat(64));
    await sink.put(one); await sink.put(three);
    for (const name of ['notes.txt', `07-${'c'.repeat(64)}.json`, `9-${'C'.repeat(64)}.json`, `9-${'c'.repeat(64)}.json.tmp`, `-1-${'c'.repeat(64)}.json`]) {
      await writeFile(join(directory, name), 'test-only unrelated');
    }
    const location = join(directory, `3-${'b'.repeat(64)}.json`);
    expect(await sink.latest()).toEqual({ ...three, location });
    expect(await sink.latest(2)).toEqual({ ...three, location });
    expect(await sink.latest(3)).toEqual({ ...three, location });
    expect(await sink.latest(4)).toBeNull();
  });

  it('the local signer verifies only its own key over the exact bytes', async () => {
    const { signer, signed } = await fileKit();
    const checkpoint = await signed(5, 'd'.repeat(64));
    const signature = Buffer.from(checkpoint.signature, 'base64url');
    expect(await signer.verify(signer.keyId, checkpointSigningInput(checkpoint), signature)).toBe(true);
    expect(await signer.verify(signer.keyId, checkpointSigningInput({ ...checkpoint, seq: 6 }), signature)).toBe(false);
    expect(await signer.verify('local-dev:other', checkpointSigningInput(checkpoint), signature)).toBe(false);
    expect(await signer.verify(signer.keyId, checkpointSigningInput(checkpoint), Buffer.alloc(3))).toBe(false);
  });

  it('two heads for one seq are a fork wherever they are in the history', async () => {
    const { sink, signed } = await fileKit();
    await sink.put(await signed(2, 'a'.repeat(64)));
    await sink.put(await signed(2, 'b'.repeat(64)));
    await sink.put(await signed(7, 'c'.repeat(64)));
    expect(await code(sink.latest())).toBe('conflict');
    expect(await code(sink.latest(5))).toBe('conflict');
  });

  it('an unreadable directory is an outage, not "no checkpoints"', async () => {
    const { dir, directory } = await fileKit();
    expect(await code(new FileCheckpointSink(join(dir, 'missing')).latest())).toBe('unavailable');
    await symlink(directory, join(dir, 'linked'));
    expect(await code(new FileCheckpointSink(join(dir, 'linked')).latest())).toBe('unavailable');
    await writeFile(join(dir, 'plain-file'), 'test-only');
    expect(await code(new FileCheckpointSink(join(dir, 'plain-file')).latest())).toBe('unavailable');
  });

  it('a planted, oversized or malformed object under a checkpoint name is invalid evidence', async () => {
    const hash = 'e'.repeat(64);
    const valid = async (kit: Awaited<ReturnType<typeof fileKit>>) => kit.signed(4, hash);
    const planted: [string, (kit: Awaited<ReturnType<typeof fileKit>>, path: string) => Promise<void>][] = [
      ['symlink', async (kit, path) => { const target = join(kit.dir, 'elsewhere.json'); await writeFile(target, JSON.stringify(await valid(kit))); await symlink(target, path); }],
      ['fifo', async (_kit, path) => { execFileSync('mkfifo', ['-m', '600', path]); }],
      ['directory', async (_kit, path) => { await mkdir(path); }],
      ['oversize', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), at: 'x'.repeat(4_096) })); }],
      ['empty', async (_kit, path) => { await writeFile(path, ''); }],
      ['not json', async (_kit, path) => { await writeFile(path, '{"seq":4,'); }],
      ['not utf-8', async (_kit, path) => { await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d])); }],
      ['an array', async (kit, path) => { await writeFile(path, JSON.stringify([await valid(kit)])); }],
      ['an extra field', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), location: '/elsewhere' })); }],
      ['a missing field', async (kit, path) => { const { at: _at, ...rest } = await valid(kit); await writeFile(path, JSON.stringify(rest)); }],
      ['another seq than its name', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), seq: 3 })); }],
      ['a string seq', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), seq: '4' })); }],
      ['another head than its name', async (kit, path) => { await writeFile(path, JSON.stringify(await kit.signed(4, 'f'.repeat(64)))); }],
      ['a padded signature', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), signature: 'AA==' })); }],
      ['a non-canonical signature', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), signature: 'AB' })); }],
      ['an empty signature', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), signature: '' })); }],
      ['an unsignable time', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), at: '2026-13-01T00:00:00.000Z' })); }],
      ['a key id with a separator', async (kit, path) => { await writeFile(path, JSON.stringify({ ...(await valid(kit)), keyId: 'local-dev:a|b' })); }],
    ];
    for (const [name, plant] of planted) {
      const kit = await fileKit();
      await plant(kit, join(kit.directory, `4-${hash}.json`));
      expect(await code(kit.sink.latest()), name).toBe('invalid');
    }
    // The control: the same name with the valid bytes reads back.
    const kit = await fileKit();
    await writeFile(join(kit.directory, `4-${hash}.json`), JSON.stringify(await valid(kit)) + '\n');
    expect(await kit.sink.latest()).toMatchObject({ seq: 4, headHash: hash });
  });
});
