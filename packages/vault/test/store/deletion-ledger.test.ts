import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, type RevocationLedgerEntry } from '../../src/core-types.js';
import { FileDeletionLedger, replayDeletionLedger } from '../../src/store/deletion-ledger.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { FixedClock, OWNER_ID, SPACE_A, fakeSecret, newLogin, otherCaller, scopeOf, testCaller } from '../support/kit.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const path = async () => { const dir = await mkdtemp(join(tmpdir(), 'vault-ledger-')); dirs.push(dir); return join(dir, 'ledger.jsonl'); };
const entry = () => ({ itemId: randomUUID(), spaceId: SPACE_A, ownerMemberId: OWNER_ID, tombstonedAt: new FixedClock().iso() });
const revoked = (): RevocationLedgerEntry => ({ kind: 'grant_revoked', grantId: randomUUID(), itemId: randomUUID(), spaceId: SPACE_A,
  ownerMemberId: OWNER_ID, revokedAt: new FixedClock().iso() });
const consumed = (): RevocationLedgerEntry => ({ kind: 'approval_consumed', approvalId: randomUUID(), itemId: randomUUID(), spaceId: SPACE_A,
  ownerMemberId: OWNER_ID, operationId: randomUUID(), consumedAt: new FixedClock().iso() });

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

  it('keeps revocation lines beside tombstones in append order, and still reads a file written before revocations', async () => {
    const file = await path();
    const old = entry();
    await writeFile(file, JSON.stringify(old) + '\n');
    const ledger = new FileDeletionLedger(file);
    const rows = [revoked(), entry(), consumed()];
    await ledger.appendRevocation(rows[0] as RevocationLedgerEntry);
    await ledger.append(rows[1] as ReturnType<typeof entry>);
    await ledger.appendRevocation(rows[2] as RevocationLedgerEntry);
    const reopened = new FileDeletionLedger(file);
    expect(await reopened.entries()).toEqual([old, rows[1]]);
    expect(await reopened.revocations()).toEqual([rows[0], rows[2]]);
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines.map((row) => (row ? (JSON.parse(row) as { kind?: string }).kind ?? 'tombstone' : ''))).toEqual(['tombstone', 'grant_revoked', 'tombstone', 'approval_consumed', '']);
  });

  it('refuses a revocation line of an unknown kind, with a missing or extra field, or a bad id or time, and never extends it', async () => {
    const grant = revoked();
    const use = consumed();
    const bad: unknown[] = [
      { kind: 'grant_restored', ...Object.fromEntries(Object.entries(grant).filter(([key]) => key !== 'kind')) },
      { ...grant, kind: null },
      { ...grant, grantId: undefined },
      { ...grant, approvalId: randomUUID() },
      { ...use, operationId: 'not-a-uuid' },
      { ...use, consumedAt: '2026-13-01T00:00:00.000Z' },
      { ...entry(), kind: 'tombstone' },
    ];
    for (const row of bad) {
      const file = await path();
      const bytes = Buffer.from(JSON.stringify(entry()) + '\n' + JSON.stringify(row) + '\n');
      await writeFile(file, bytes);
      const ledger = new FileDeletionLedger(file);
      await expect(ledger.entries()).rejects.toThrow('corrupt or unavailable');
      await expect(ledger.revocations()).rejects.toThrow('corrupt or unavailable');
      await expect(ledger.appendRevocation(revoked())).rejects.toThrow('corrupt or unavailable');
      expect(await readFile(file)).toEqual(bytes);
      // A caller's malformed entry is refused before anything is written.
      await expect(new FileDeletionLedger(await path()).appendRevocation(row as RevocationLedgerEntry)).rejects.toThrow('corrupt record');
    }
  });

  it('replays revocations after tombstones, audits each once, and rolls back if audit is unavailable', async () => {
    const file = await path(); const ledger = new FileDeletionLedger(file); const store = new MemoryVaultStore();
    const item = await store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    const grant = await store.transaction(scopeOf(testCaller), (tx) => tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: 'member',
      granteeId: otherCaller.memberId, constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null,
      createdBy: actorOf(testCaller) }));
    await ledger.appendRevocation({ kind: 'grant_revoked', grantId: grant.id, itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId,
      revokedAt: new FixedClock().iso() });
    store.faults.auditAppend = true;
    await expect(replayDeletionLedger(store, ledger)).rejects.toThrow('vault audit unavailable');
    expect((await store.transaction(scopeOf(testCaller), (tx) => tx.grants.get(grant.id)))?.revokedAt).toBeNull();
    store.faults.auditAppend = false;
    expect(await replayDeletionLedger(store, ledger)).toBe(1);
    expect(await replayDeletionLedger(store, ledger)).toBe(0);
    expect((await store.transaction(scopeOf(testCaller), (tx) => tx.audit.list({ action: 'grant.revoke_replayed' }))).rows).toHaveLength(1);
    expect(await store.transaction(scopeOf(otherCaller), (tx) => tx.items.get(item.id))).toBeNull();
  });
});
