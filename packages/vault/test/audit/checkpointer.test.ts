import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditCheckpointer, FileCheckpointSink, LocalEd25519CheckpointSigner, OffCheckpointSink } from '../../src/audit/checkpointer.js';
import { checkpointSigningInput } from '../../src/audit/chain.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { FixedClock } from '../support/kit.js';

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
    const putFailure = new AuditCheckpointer({ store, signer: { keyId: 'test', sign: async () => Buffer.alloc(64) }, sink: { kind: 'file', health: sink.health.bind(sink), put: async () => { throw new Error('test put failed'); } } });
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
});
