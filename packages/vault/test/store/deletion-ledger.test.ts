import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDeletionLedger, replayDeletionLedger } from '../../src/store/deletion-ledger.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { FixedClock, OWNER_ID, SPACE_A, fakeSecret, newLogin, scopeOf, testCaller } from '../support/kit.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const path = async () => { const dir = await mkdtemp(join(tmpdir(), 'vault-ledger-')); dirs.push(dir); return join(dir, 'ledger.jsonl'); };
const entry = () => ({ itemId: randomUUID(), spaceId: SPACE_A, ownerMemberId: OWNER_ID, tombstonedAt: new FixedClock().iso() });

describe('FileDeletionLedger', () => {
  it('persists full records in append order, including concurrent callers', async () => {
    const file = await path(); const ledger = new FileDeletionLedger(file);
    expect(await ledger.entries()).toEqual([]);
    const rows = [entry(), entry(), entry()];
    await Promise.all(rows.map((row) => ledger.append(row)));
    expect(await new FileDeletionLedger(file).entries()).toEqual(rows);
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });
  it('fails loudly for a corrupt, truncated, invalid-UTF8 or invalid-date tail and refuses to append', async () => {
    for (const bytes of [Buffer.from('{"itemId":'), Buffer.from('{}\n'), Buffer.from(JSON.stringify({ ...entry(), tombstonedAt: '2026-02-30T00:00:00.000Z' }) + '\n'), Buffer.from([255,10])]) {
      const file = await path(); await writeFile(file, bytes);
      const ledger = new FileDeletionLedger(file);
      await expect(ledger.entries()).rejects.toThrow('corrupt or unavailable');
      await expect(ledger.append(entry())).rejects.toThrow('corrupt or unavailable');
      expect(await readFile(file)).toEqual(bytes);
    }
  });
  it('replays before serving, audits once, and rolls back if audit is unavailable', async () => {
    const file = await path(); const ledger = new FileDeletionLedger(file); const store = new MemoryVaultStore();
    const item = await store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    await ledger.append({ itemId: item.id, ownerMemberId: item.ownerMemberId, spaceId: item.spaceId, tombstonedAt: new FixedClock().iso() });
    store.faults.auditAppend = true;
    await expect(replayDeletionLedger(store, ledger)).rejects.toThrow('vault audit unavailable');
    expect((await store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id)))?.state).toBe('active');
    store.faults.auditAppend = false;
    expect(await replayDeletionLedger(store, ledger)).toBe(1);
    expect(await replayDeletionLedger(store, ledger)).toBe(0);
    expect((await store.transaction(scopeOf(testCaller), (tx) => tx.audit.list({ action: 'item.tombstone_replayed' }))).rows).toHaveLength(1);
  });
});
