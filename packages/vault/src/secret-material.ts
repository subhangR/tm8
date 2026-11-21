import { inspect } from 'node:util';

/**
 * A plaintext secret held by the broker for the shortest possible time.
 *
 * Rules (brief MSG 5D, R1, R12):
 * - It never serializes. `JSON.stringify`, `String()`, template literals and
 *   `util.inspect`/`console.log` all print `[redacted]`, so an accidental log
 *   line or error payload cannot carry the value.
 * - `dispose()` overwrites the bytes with zeros. Every holder disposes in a
 *   `finally`. A disposed holder throws on use, so use-after-dispose is loud.
 * - `utf8()` is the one escape hatch, for a consumer that only takes strings
 *   (Playwright's `fill`, an HTTP header value). V8 strings cannot be zeroized,
 *   so call it as late as possible and never keep the result.
 *
 * The Node runtime cannot `mlock` the V8 heap or wipe a string, so this is
 * hygiene, not a memory guarantee. Copies outside this buffer stay until their
 * memory is reused (deploy/vault/README.md, "Plaintext in broker memory", lists
 * them). Against disk: the broker keeps its memory out of core dumps, and
 * production refuses a host that could still write a core or swap it out
 * (broker/host-memory.ts, review F05). Hibernation, kdump and VM snapshots are
 * host checks.
 */
export class SecretMaterial {
  #bytes: Buffer | null;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  /** Takes ownership of `bytes` (no copy). The caller must not reuse the buffer. */
  static adopt(bytes: Buffer): SecretMaterial {
    return new SecretMaterial(bytes);
  }

  /** Copies a string into a zeroizable buffer. The source string itself cannot be wiped. */
  static fromUtf8(value: string): SecretMaterial {
    return new SecretMaterial(Buffer.from(value, 'utf8'));
  }

  get disposed(): boolean {
    return this.#bytes === null;
  }

  get byteLength(): number {
    return this.#live().length;
  }

  /** Runs `fn` with the live bytes. Do not retain the buffer past the callback. */
  use<T>(fn: (bytes: Buffer) => T): T {
    return fn(this.#live());
  }

  /** See the class comment: the returned string cannot be zeroized. */
  utf8(): string {
    return this.#live().toString('utf8');
  }

  /** Constant-time equality without exposing either value. */
  equals(other: SecretMaterial): boolean {
    const a = this.#live();
    const b = other.#live();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
    return diff === 0;
  }

  dispose(): void {
    if (this.#bytes !== null) {
      this.#bytes.fill(0);
      this.#bytes = null;
    }
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'SecretMaterial([redacted])';
  }

  #live(): Buffer {
    if (this.#bytes === null) throw new Error('SecretMaterial used after dispose');
    return this.#bytes;
  }
}

/** Runs `fn` and disposes every holder afterwards, even on throw. */
export async function withSecrets<T>(holders: readonly SecretMaterial[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    for (const holder of holders) holder.dispose();
  }
}

/** Overwrites a buffer that held key material. */
export function zeroize(...buffers: (Buffer | Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}
