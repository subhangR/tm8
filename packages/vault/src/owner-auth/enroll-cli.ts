import type { VaultStore } from '../core-types.js';
import { VaultError } from '../core-types.js';
import { mintEnrollmentCode } from './codes.js';

/** WS-A injects the system store. No environment credentials or database dialing here. */
export async function runEnrollmentCli(store: VaultStore, args: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Promise<void> {
  if (args.length !== 3) throw new VaultError('invalid_input');
  const [memberId, spaceId, ttl] = args;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!uuid.test(memberId!) || !uuid.test(spaceId!) || !/^\d+$/.test(ttl!)) throw new VaultError('invalid_input');
  const code = await mintEnrollmentCode(store, { memberId: memberId!, spaceId: spaceId!, ttlSeconds: Number(ttl) });
  stdout.write(`${code}\n`);
}
