/**
 * The broker's socket defaults must agree with the units that ship in
 * deploy/vault (task 01a1fa87). They once did not. The broker's own socket
 * defaulted into /run/tm8-vault, the directory the fill worker's tmpfiles.conf
 * makes group-shared (2770), so listen() refused to start there. And the
 * broker looked for the fill worker on a path its unit never listens on.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BROKER_SOCKET, DEFAULT_FILL_SOCKET } from '../../src/broker/main.js';
import { createBrokerServer } from '../../src/broker/server.js';
import { exportAttestationKeyPair, generateAttestationKeyPair } from '../../src/relay/attestation.js';
import { testBroker } from '../support/kit.js';
import { stubHandlers } from './support.js';

const deployFile = (name: string): Promise<string> =>
  readFile(new URL(`../../../../deploy/vault/fill-worker/${name}`, import.meta.url), 'utf8');

/** Each `d <path> <mode> ...` line of a tmpfiles.d file, as path → mode. */
const tmpfilesDirectories = (text: string): Map<string, string> => new Map(text.split('\n')
  .map((line) => line.trim().split(/\s+/))
  .flatMap((fields) => (fields[0] === 'd' && fields[1] && fields[2] ? [[fields[1], fields[2]] as const] : [])));

describe('broker socket defaults against the shipped units', () => {
  it('looks for the fill worker where its unit listens', async () => {
    const unit = await deployFile('tm8-vault-fill.service');
    const listens = unit.split('\n').flatMap((line) => /^Environment=TM8_VAULT_FILL_SOCKET=(\S+)$/.exec(line.trim())?.[1] ?? []);
    expect(listens).toEqual([DEFAULT_FILL_SOCKET]);
  });

  it('keeps its own socket out of every directory tmpfiles.conf creates', async () => {
    const directories = tmpfilesDirectories(await deployFile('tmpfiles.conf'));
    expect(directories.get(dirname(DEFAULT_FILL_SOCKET))).toBe('2770');
    // Not in one, and not below one: the broker's socket directory is 0700 and its own.
    for (const directory of directories.keys()) {
      expect(dirname(DEFAULT_BROKER_SOCKET)).not.toBe(directory);
      expect(DEFAULT_BROKER_SOCKET.startsWith(`${directory}/`)).toBe(false);
    }
  });

  it('refuses to listen in a directory shaped like the shared one, and listens once it is owner-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vault-socket-dir-'));
    try {
      const relayPublicKeyFile = join(root, 'relay.pub');
      await writeFile(relayPublicKeyFile, exportAttestationKeyPair(generateAttestationKeyPair()).publicPem, { mode: 0o600 });
      const shared = join(root, 'tm8-vault');
      await mkdir(shared);
      await chmod(shared, 0o2770);
      const server = () => createBrokerServer({ ...testBroker(), handlers: stubHandlers(), socketPath: join(shared, 'broker.sock'), relayPublicKeyFile });
      await expect((await server()).listen()).rejects.toThrow('vault broker: socket directory must be owner-only');
      // The same directory at 0700 is accepted, so the refusal above is the mode and nothing else.
      await chmod(shared, 0o700);
      const owned = await server();
      await owned.listen();
      await owned.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
