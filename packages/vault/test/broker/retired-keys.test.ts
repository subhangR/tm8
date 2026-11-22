import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrokerConfigError } from '../../src/broker/config.js';
import { failureMessage } from '../../src/broker/main.js';
import { createBrokerServer } from '../../src/broker/server.js';
import { exportAttestationKeyPair, generateAttestationKeyPair } from '../../src/relay/attestation.js';
import { parseRetiredKeys, publicKeySha256 } from '../../src/relay/retired-keys.js';
import { testBroker } from '../support/kit.js';
import { stubHandlers } from './support.js';

const B2 = 'vault broker: TM8_VAULT_RELAY_PUBLIC_KEY_FILE is a retired relay key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 B2)';

describe('broker: a retired relay public key is refused at load (review F03, B2)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'vault-b2-'));
    const broker = testBroker();
    cleanups.push(async () => { await broker.store.close(); broker.components.captureKeys.destroy(); await rm(dir, { recursive: true, force: true }); });
    // A throwaway relay key pair generated at runtime.
    const pair = generateAttestationKeyPair();
    const relayPublicKeyFile = join(dir, 'relay.pub');
    await writeFile(relayPublicKeyFile, exportAttestationKeyPair(pair).publicPem, { mode: 0o600 });
    const fingerprint = publicKeySha256(pair.publicKey);
    const server = (retiredRelayKeys?: ReadonlySet<string>) => createBrokerServer({
      ...broker, handlers: stubHandlers(), socketPath: join(dir, 'broker.sock'), relayPublicKeyFile, ...(retiredRelayKeys ? { retiredRelayKeys } : {}),
    });
    return { dir, fingerprint, server };
  }

  it('refuses the listed key in either spelling, names the knob, never the fingerprint, and binds nothing', async () => {
    const { dir, fingerprint, server } = await setup();
    const colons = fingerprint.toUpperCase().match(/../g)!.join(':');
    for (const listed of [fingerprint, colons, `${'ab'.repeat(32)},${colons}`]) {
      const error = await server(parseRetiredKeys(listed)!).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(BrokerConfigError);
      expect((error as BrokerConfigError).knob).toBe('TM8_VAULT_RELAY_PUBLIC_KEY_FILE');
      expect((error as Error).message).toBe(B2);
      expect(failureMessage(error)).toBe(B2);
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(fingerprint);
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(error)).toLowerCase()).not.toContain(colons.toLowerCase());
      await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('serves a key that is not listed, with the empty list and with other entries', async () => {
    const { dir, server } = await setup();
    for (const retired of [undefined, new Set<string>(), parseRetiredKeys(`${'ab'.repeat(32)},${'cd'.repeat(32)}`)!]) {
      const created = await server(retired);
      await created.listen();
      expect((await lstat(join(dir, 'broker.sock'))).isSocket()).toBe(true);
      await created.close();
    }
  });
});
