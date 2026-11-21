import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditUnavailableError, SYSTEM_ACTOR, StoreNotFoundError, StoreUnavailableError, actorOf, type AuditBody, type VaultTx } from '../../src/core-types.js';
import { VaultAuditGate } from '../../src/audit/gate.js';
import { AUDIT_GENESIS_HASH, auditBodyText, verifyAuditRun } from '../../src/audit/chain.js';
import { encryptSecretVersion, decryptSecretVersion } from '../../src/crypto/aead.js';
import { LocalDevKms, UnavailableKms, type KmsProvider } from '../../src/crypto/kms.js';
import { SecretMaterial } from '../../src/secret-material.js';
import { FileDeletionLedger, replayDeletionLedger } from '../../src/store/deletion-ledger.js';
import { OWNER_ID, SPACE_A, T0, fakeArgon2idHash, fakeSecret, newApproval, newLogin, otherCaller, outsiderCaller, scopeOf, testCaller, tokenPair } from '../support/kit.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from './pg-harness.js';

const sys = { kind: 'system', purpose: 'audit' } as const;
const event = (n = 0): AuditBody => ({ action: 'session.signed_in', actor: actorOf(testCaller), itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } });

if (!PG_ENABLED) describe('Postgres vault security', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('Postgres vault security', () => {
  let h: PgHarness;
  const dirs: string[] = [];
  beforeEach(async () => { h = await pgHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await h?.dispose(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

  it('roles are NOLOGIN with no passwords; tm8_app and PUBLIC have zero vault privileges', async () => {
    const roles = (await h.admin.query("select rolname, rolcanlogin, rolsuper, rolbypassrls, rolpassword from pg_authid where rolname like 'tm8_vault_%' order by rolname")).rows;
    expect(roles).toHaveLength(3);
    for (const role of roles) expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolpassword: null });
    expect((await h.admin.query("select has_schema_privilege('tm8_app','vault','USAGE') as usage, has_schema_privilege('tm8_app','vault','CREATE') as create")).rows[0]).toEqual({ usage: false, create: false });
    const grants = await h.admin.query("select count(*) as n from pg_namespace n, lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname = 'vault' and a.grantee = 0");
    expect(Number(grants.rows[0].n)).toBe(0);
    const relations = (await h.admin.query("select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'vault' and c.relkind in ('r','S')")).rows;
    for (const row of relations) {
      const permissions = (await h.admin.query("select has_table_privilege('tm8_app',$1::oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed", [row.oid])).rows[0];
      expect(permissions.allowed).toBe(false);
    }
    const client = await h.admin.connect();
    try {
      await client.query('set role tm8_app');
      await expect(client.query('select * from vault.items')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('reset role'); client.release(); }
  });

  it('SQL append seals both external golden vectors byte for byte, preserving body_text', async () => {
    const itemId = '11111111-1111-4111-8111-111111111111';
    const firstBody: AuditBody = { action: 'item.captured', actor: { kind: 'member', memberId: OWNER_ID, sessionId: null, name: 'Zoë Test' }, itemId, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { type: 'login', fieldNames: ['username','password'], count: 2, devMode: false, note: null, ratio: 0.5 } };
    const secondBody: AuditBody = { action: 'fill.started', actor: { kind: 'agent', memberId: OWNER_ID, sessionId: '22222222-2222-4222-8222-222222222222', name: 'Agent "q"\n\u0007 \u{1F6E1}' }, itemId, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: {} };
    const first = await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(firstBody));
    h.clock.set('2026-11-20T12:00:01.250Z');
    const second = await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(secondBody));
    expect(first.entryHash).toBe('eb3423d9681229df7da55989d2b82ddd32423ce4c2b4aeb52c40096b6ccb9ee5');
    expect(second.entryHash).toBe('4d5361f261c02655c7b8de4867809404b3378f98e81d435fa72d5f9de2da2abd');
    expect(first.at).toBe(T0); expect(first.bodyText).toBe(auditBodyText(firstBody)); expect(second.bodyText).toBe(auditBodyText(secondBody));
    // The SQL definer accepts canonical bytes verbatim, even when JSONB would
    // print different whitespace or key ordering.
    const raw = ' { "params":{}, "spaceId":null, "subjectMemberId":null, "itemId":null, "actor":{"kind":"system","memberId":null,"sessionId":null,"name":null}, "action":"session.ended" } ';
    const sql = (await h.admin.query('select * from vault.append_audit($1,$2)', [raw, T0])).rows[0];
    expect(sql.body_text).toBe(raw); expect(sql.at.toISOString()).toBe(second.at);
  });

  it('audit UPDATE, DELETE and TRUNCATE fail for the owner and superuser; only the definer inserts', async () => {
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(event()));
    for (const role of ['tm8_vault_broker','tm8_vault_owner',null]) {
      const client = await h.admin.connect();
      try {
        if (role) await client.query(`set role ${role}`);
        for (const sql of ["update vault.audit_events set action = 'session.ended'", 'delete from vault.audit_events', 'truncate vault.audit_events', "insert into vault.audit_events select * from vault.audit_events where seq = 1"]) {
          await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
      } finally { await client.query('reset role'); client.release(); }
    }
    expect((await h.store.transaction(sys, (tx) => tx.audit.range(1, 10))).length).toBe(1);
  });

  it('terminal approval and item states cannot reopen through SQL, including the owner', async () => {
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    const approval = await h.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)));
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.decide(approval.id, { state: 'denied', standing: false, decidedBy: actorOf(testCaller) }));
    await expect(h.admin.query("update vault.approvals set state = 'pending' where id = $1", [approval.id])).rejects.toMatchObject({ code: '23514' });
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.tombstone(item.id, item.version, actorOf(testCaller)));
    await expect(h.admin.query("update vault.items set state = 'active', tombstoned_at = null where id = $1", [item.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('concurrent appends serialize on the head; a SQL tamper and a missing tail are detected at their first seq (15)', async () => {
    await Promise.all(Array.from({ length: 15 }, (_, n) => h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(event(n)))));
    const gate = new VaultAuditGate({ store: h.store, pageSize: 3, clock: h.clock });
    expect(await gate.verifyAll()).toMatchObject({ status: 'verified', checkedThroughSeq: 15 });
    const records = await h.store.transaction(sys, (tx) => tx.audit.range(1, 20));
    expect(verifyAuditRun({ seq: 0, hash: AUDIT_GENESIS_HASH }, records).ok).toBe(true);
    await h.hooks.tamperAuditEvent!(7, { params: { n: -1 } });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 7, checkedThroughSeq: 6 });
    await h.hooks.deleteAuditEvent!(15);
    const second = new VaultAuditGate({ store: h.store, pageSize: 3 });
    await h.hooks.tamperAuditEvent!(7, { params: records[6]!.params });
    expect(await second.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 15, checkedThroughSeq: 14 });
  });

  it('a pg_dump with KMS absent contains no plaintext or unwrapped DEK; its encrypted rows cannot decrypt (14)', async () => {
    const kms = LocalDevKms.ephemeral(); let observedDek: Buffer | undefined;
    const capture: KmsProvider = { kind: 'test-fake', productionGrade: false, activeKekId: kms.activeKekId, health: () => kms.health(), unwrap: (wrapped, aad) => kms.unwrap(wrapped, aad), wrap: async (dek, aad) => { observedDek = Buffer.from(dek); return kms.wrap(dek, aad); } };
    const marker = Buffer.concat([Buffer.from('marked-test-value-'), randomBytes(32)]);
    const material = SecretMaterial.adopt(Buffer.from(marker)); const draft = newLogin();
    const aad = { itemId: draft.id, ownerId: OWNER_ID, version: 1 };
    try {
      const encrypted = await encryptSecretVersion(capture, material, aad);
      const control = await decryptSecretVersion(kms, encrypted, aad);
      try { expect(control.equals(material)).toBe(true); } finally { control.dispose(); }
      await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(draft, encrypted));
      kms.destroyForTest();
      const dump = await h.dump();
      for (const bytes of [marker, observedDek!]) for (const encoding of ['hex','base64','base64url'] as const) expect(dump.includes(bytes.toString(encoding))).toBe(false);
      expect(dump.includes('marked-test-value-')).toBe(false);
      await h.restoreDump(dump);
      const row = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.currentSecret(draft.id));
      expect(row).not.toBeNull();
      await expect(decryptSecretVersion(new UnavailableKms(), row!, aad)).rejects.toThrow('KMS unavailable');
      await expect(decryptSecretVersion(kms, row!, aad)).rejects.toThrow();
    } finally { material.dispose(); marker.fill(0); observedDek?.fill(0); }
  });

  it('a real dump restore plus FileDeletionLedger replay revives nothing and audits the replay (17)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-pg-ledger-')); dirs.push(dir);
    const ledger = new FileDeletionLedger(join(dir, 'deletions.jsonl'));
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    const dump = await h.dump(); h.clock.advance(1000);
    const entry = { itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId, tombstonedAt: h.clock.iso() };
    await ledger.append(entry);
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.tombstone(item.id, item.version, actorOf(testCaller)));
    await h.restoreDump(dump);
    expect((await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id)))?.state).toBe('active');
    expect(await replayDeletionLedger(h.store, new FileDeletionLedger(join(dir, 'deletions.jsonl')))).toBe(1);
    expect(await replayDeletionLedger(h.store, ledger)).toBe(0);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.currentSecret(item.id))).toBeNull();
    expect((await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id)))?.tombstonedAt).toBe(entry.tombstonedAt);
    expect((await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.list({ action: 'item.tombstone_replayed' }))).rows).toHaveLength(1);
  });

  it('all item-related repos give strangers the same result for existing and missing ids, in SQL and through repos (19)', async () => {
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    const approval = await h.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)));
    const grant = await h.store.transaction(scopeOf(testCaller), (tx) => tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: 'member', granteeId: randomUUID(), constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null, createdBy: actorOf(testCaller) }));
    for (const caller of [otherCaller, outsiderCaller, { ...testCaller, spaceId: outsiderCaller.spaceId }]) {
      await h.store.transaction(scopeOf(caller), async (tx) => {
        const lookups: [string, (id: string) => Promise<unknown>][] = [
          [item.id, (id) => tx.items.get(id)], [item.id, (id) => tx.items.currentSecret(id)], [item.id, (id) => tx.policies.get(id)],
          [approval.id, (id) => tx.approvals.get(id)], [approval.id, (id) => tx.spend.getByApproval(id)], [grant.id, (id) => tx.grants.get(id)],
          [item.id, (id) => tx.grants.activeForCaller(id)], [item.id, (id) => tx.grants.countActive(id)], [item.id, (id) => tx.approvals.countPending(id)],
        ];
        for (const [existing, lookup] of lookups) expect(await lookup(existing)).toEqual(await lookup(randomUUID()));
        for (const id of [item.id, randomUUID()]) {
          await expect(tx.items.setProperties(id, 1, {})).rejects.toBeInstanceOf(StoreNotFoundError);
          await expect(tx.items.addOrigin(id, 'https://test.example')).rejects.toBeInstanceOf(StoreNotFoundError);
          await expect(tx.items.replaceSecret(id, 1, fakeSecret(), {})).rejects.toBeInstanceOf(StoreNotFoundError);
          await expect(tx.items.tombstone(id, 1, actorOf(caller))).rejects.toBeInstanceOf(StoreNotFoundError);
          await expect(tx.grants.listForItem(id)).rejects.toBeInstanceOf(StoreNotFoundError);
        }
      });
      const client = await h.admin.connect();
      try {
        await client.query('begin'); await client.query('set local role tm8_vault_broker');
        await client.query("select set_config('vault.member_id',$1,true),set_config('vault.space_id',$2,true),set_config('vault.system_purpose','',true),set_config('vault.at',$3,true)", [caller.memberId, caller.spaceId, h.clock.iso()]);
        for (const table of ['items','secret_versions','broker_policies','origin_bindings','grants','approvals','spend_requests']) expect((await client.query(`select * from vault.${table}`)).rows).toEqual([]);
      } finally { await client.query('rollback'); client.release(); }
    }
  });

  it('an invisible row does not wait on its owner while a missing row returns immediately', async () => {
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    let release!: () => void; let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.items.update(item.id, item.version, { name: 'Changed metadata' });
      entered(); await hold;
    });
    await ready;
    const stranger = h.store.transaction(scopeOf(otherCaller), async (tx) => {
      expect(await tx.items.get(randomUUID())).toBeNull();
      return tx.items.get(item.id);
    });
    try {
      expect(await Promise.race([stranger.then((result) => result === null ? 'missing' : 'visible'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 200))])).toBe('missing');
    } finally { release(); await owner; await stranger; }
  });

  it('a real SQL uniqueness failure and a partially written call roll back only their savepoint', async () => {
    const credentialId = randomBytes(32).toString('base64url');
    const key = (credential: string) => ({ id: randomUUID(), credentialId: credential, publicKey: randomBytes(64).toString('base64url'), counter: 0, transports: [], backedUp: false, deviceType: 'singleDevice' as const, aaguid: null, name: 'Test key' });
    await h.store.transaction(scopeOf(otherCaller), (tx) => tx.passkeys.create(key(credentialId)));
    const usedId = randomUUID();
    const original = { id: randomUUID(), hash: fakeArgon2idHash() };
    await h.store.transaction(scopeOf(otherCaller), (tx) => tx.recoveryCodes.replaceAll([{ id: usedId, hash: fakeArgon2idHash() }]));
    await h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.recoveryCodes.replaceAll([original]);
      await expect(tx.passkeys.create(key(credentialId))).rejects.toMatchObject({ name: 'StoreDuplicateError' });
      await expect(tx.recoveryCodes.replaceAll([{ id: randomUUID(), hash: fakeArgon2idHash() }, { id: usedId, hash: fakeArgon2idHash() }])).rejects.toMatchObject({ name: 'StoreDuplicateError' });
      expect((await tx.recoveryCodes.listUnused()).map((row) => row.id)).toEqual([original.id]);
      await tx.items.create(newLogin(), fakeSecret());
      await tx.audit.append(event());
    });
    expect((await h.store.transaction(sys, (tx) => tx.audit.head())).seq).toBe(1);
  });

  it('a SQL audit append failure kills the transaction even when its exception is caught', async () => {
    await h.admin.query('revoke insert on vault.audit_events from tm8_vault_audit_writer');
    const draft = newLogin();
    await expect(h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.items.create(draft, fakeSecret());
      await expect(tx.audit.append(event())).rejects.toBeInstanceOf(AuditUnavailableError);
      await expect(tx.items.get(draft.id)).rejects.toBeInstanceOf(AuditUnavailableError);
      return 'caught';
    })).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(draft.id))).toBeNull();
    expect((await h.store.transaction(sys, (tx) => tx.audit.head())).seq).toBe(0);
  });

  it('the matching rollback removes the vault schema and rolls back transactionally', async () => {
    const client = await h.admin.connect();
    try {
      await client.query('begin');
      await client.query(await readFile(new URL('../../../../db/rollback/450_vault_store.down.sql', import.meta.url), 'utf8'));
      expect((await client.query("select to_regnamespace('vault') as schema")).rows[0].schema).toBeNull();
    } finally { await client.query('rollback'); client.release(); }
    expect((await h.store.health()).ok).toBe(true);
  });

  it('invalid ids and times throw before repo SQL, and a real lost connection kills a caught transaction', async () => {
    const client = await h.admin.connect();
    // Observe driver queries without exposing their parameters or errors.
    const observer = vi.spyOn(Object.getPrototypeOf(client), 'query');
    client.release();
    await h.store.transaction(scopeOf(testCaller), async (tx) => {
      const before = observer.mock.calls.length;
      await expect(tx.items.get('invalid-id')).rejects.toBeInstanceOf(TypeError);
      await expect(tx.approvals.create({ ...newApproval(randomUUID(), testCaller, h.clock), expiresAt: '2026-13-01T00:00:00.000Z' })).rejects.toBeInstanceOf(TypeError);
      expect(observer.mock.calls.length).toBe(before);
    });
    observer.mockRestore();
    const draft = newLogin();
    const result = h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.items.create(draft, fakeSecret());
      const backends = (await h.admin.query("select pid from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and pid <> pg_backend_pid()")).rows;
      expect(backends).toHaveLength(1);
      await h.admin.query('select pg_terminate_backend($1)', [backends[0].pid]);
      await expect(tx.items.get(draft.id)).rejects.toBeInstanceOf(StoreUnavailableError);
      await expect(tx.audit.head()).rejects.toBeInstanceOf(StoreUnavailableError);
      return 'caught';
    });
    await expect(result).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(draft.id))).toBeNull();
  });
});
