import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { VaultWebAuthnAssertion } from '@tm8/contract';
import type { VaultInput } from '@tm8/contract';

function header(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

/** Minimal definite-length CBOR, independent of the WebAuthn implementation. */
export function cbor(value: number | string | Buffer | Map<number | string, unknown>): Buffer {
  if (typeof value === 'number') return header(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === 'string') return Buffer.concat([header(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  const entries = [...value.entries()].flatMap(([key, entry]) => [cbor(key), cbor(entry as Parameters<typeof cbor>[0])]);
  return Buffer.concat([header(5, value.size), ...entries]);
}

export interface CeremonyOptions {
  origin?: string;
  rpId?: string;
  uv?: boolean;
  up?: boolean;
  counter?: number;
  crossOrigin?: boolean;
  topOrigin?: string;
}

export class SoftwareAuthenticator {
  readonly #keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly id = randomBytes(32).toString('base64url');
  counter = 0;

  #client(type: string, challenge: string, options: CeremonyOptions): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: options.origin ?? 'https://tm8.example.test',
      crossOrigin: options.crossOrigin ?? false, ...(options.topOrigin ? { topOrigin: options.topOrigin } : {}) }));
  }

  #data(options: CeremonyOptions, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    createHash('sha256').update(options.rpId ?? 'tm8.example.test').digest().copy(head);
    head[32] = (options.up === false ? 0 : 1) | (options.uv === false ? 0 : 4) | (attested ? 64 : 0);
    head.writeUInt32BE(options.counter ?? this.counter, 33);
    if (!attested) return head;
    const jwk = this.#keys.publicKey.export({ format: 'jwk' });
    const key = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const id = Buffer.from(this.id, 'base64url');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    return Buffer.concat([head, Buffer.alloc(16), length, id, key]);
  }

  register(challenge: string, options: CeremonyOptions = {}): VaultInput<'vault.passkeys.registerFinish'>['credential'] {
    const client = this.#client('webauthn.create', challenge, options);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: client.toString('base64url'), transports: ['internal'],
        attestationObject: cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.#data(options, true)]])).toString('base64url') } };
  }

  assert(challenge: string, options: CeremonyOptions = {}): VaultWebAuthnAssertion {
    this.counter += 1;
    const client = this.#client('webauthn.get', challenge, options);
    const data = this.#data(options, false);
    const signature = sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), this.#keys.privateKey);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'), signature: signature.toString('base64url') } };
  }
}
