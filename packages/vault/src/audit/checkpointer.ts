import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { systemClock, type CheckpointRecord, type CheckpointSigner, type CheckpointSink, type Clock, type VaultStore } from '../core-types.js';
import type { VaultMode } from '../types.js';
import { checkpointSigningInput } from './chain.js';

type SignedCheckpoint = Parameters<CheckpointSink['put']>[0];

/** Reads an operator-provided Ed25519 private key; never generates or writes one. */
export class LocalEd25519CheckpointSigner implements CheckpointSigner {
  readonly keyId: string;
  readonly #key: KeyObject;

  constructor(options: { name: string; keyFile: string; mode: VaultMode }) {
    if (options.mode !== 'dev' && options.mode !== 'pre_review') throw new Error('vault checkpoint: local signer refused');
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.name)) throw new TypeError('vault checkpoint: invalid key name');
    this.keyId = `local-dev:${options.name}`;
    let fd: number | undefined;
    let bytes: Buffer | undefined;
    try {
      fd = openSync(options.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) throw new Error();
      bytes = readFileSync(fd);
      this.#key = createPrivateKey(bytes);
      if (this.#key.asymmetricKeyType !== 'ed25519') throw new Error();
    } catch {
      throw new Error('vault checkpoint: signing key unavailable');
    } finally {
      bytes?.fill(0);
      if (fd !== undefined) closeSync(fd);
    }
  }

  async sign(input: Buffer): Promise<Buffer> {
    try { return sign(null, input, this.#key); }
    catch { throw new Error('vault checkpoint: signing failed'); }
  }
}

export class OffCheckpointSink implements CheckpointSink {
  readonly kind = 'off' as const;
  async put(_checkpoint: SignedCheckpoint): Promise<{ anchored: boolean; location: null }> { return { anchored: false, location: null }; }
  async health(): Promise<{ ok: boolean; retention: 'not_applicable' }> { return { ok: true, retention: 'not_applicable' }; }
}

export class FileCheckpointSink implements CheckpointSink {
  readonly kind = 'file' as const;
  readonly #directory: string;
  constructor(directory: string) { this.#directory = resolve(directory); }

  async put(checkpoint: SignedCheckpoint): Promise<{ anchored: boolean; location: string }> {
    checkpointSigningInput(checkpoint);
    if (!/^[A-Za-z0-9_-]+$/.test(checkpoint.signature)) throw new TypeError('vault checkpoint: invalid signature');
    const location = join(this.#directory, `${checkpoint.seq}-${checkpoint.headHash}.json`);
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const file = await open(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(JSON.stringify({ seq: checkpoint.seq, headHash: checkpoint.headHash, at: checkpoint.at, keyId: checkpoint.keyId, signature: checkpoint.signature }) + '\n');
        await file.sync();
      } finally { await file.close(); }
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      return { anchored: true, location };
    } catch { throw new Error('vault checkpoint: file sink write failed'); }
  }

  async health(): Promise<{ ok: boolean; retention: 'not_applicable' }> {
    try {
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      return { ok: true, retention: 'not_applicable' };
    } catch { return { ok: false, retention: 'not_applicable' }; }
  }
}

/** The external put must succeed before its receipt can become durable in SQL. */
export class AuditCheckpointer {
  readonly #clock: Clock;
  constructor(private readonly options: { store: VaultStore; signer: CheckpointSigner; sink: CheckpointSink; clock?: Clock }) {
    this.#clock = options.clock ?? systemClock;
  }

  async checkpoint(): Promise<CheckpointRecord> {
    const { store, signer, sink } = this.options;
    const head = await store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.head());
    const body = { seq: head.seq, headHash: head.hash, at: this.#clock.now().toISOString(), keyId: signer.keyId };
    const signature = (await signer.sign(checkpointSigningInput(body))).toString('base64url');
    const receipt = await sink.put({ ...body, signature });
    const record: CheckpointRecord = { ...body, signature, sink: sink.kind, anchored: receipt.anchored, location: receipt.location };
    await store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.recordCheckpoint(record));
    return record;
  }

  run(): Promise<CheckpointRecord> { return this.checkpoint(); }
}

export { AuditCheckpointer as Checkpointer };
