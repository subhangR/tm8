import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SYSTEM_ACTOR, type DeletionLedger, type DeletionLedgerEntry, type RevocationLedgerEntry, type VaultStore } from '../core-types.js';

const corrupt = (): never => { throw new Error('vault deletion ledger: corrupt record'); };

function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt();
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== keys) corrupt();
  return fields;
}

function uuid(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) corrupt();
  return (id as string).toLowerCase();
}

function at(time: unknown): string {
  if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) {
    corrupt();
  }
  return time as string;
}

function checked(value: unknown): DeletionLedgerEntry {
  const entry = record(value, 'itemId,ownerMemberId,spaceId,tombstonedAt');
  return { itemId: uuid(entry.itemId), spaceId: uuid(entry.spaceId), ownerMemberId: uuid(entry.ownerMemberId), tombstonedAt: at(entry.tombstonedAt) };
}

/** A line with a `kind` is a revocation; its fields are exact for that kind, as a tombstone's are. */
function checkedRevocation(value: unknown): RevocationLedgerEntry {
  const kind = value && typeof value === 'object' && !Array.isArray(value) ? (value as { kind?: unknown }).kind : undefined;
  if (kind === 'grant_revoked') {
    const entry = record(value, 'grantId,itemId,kind,ownerMemberId,revokedAt,spaceId');
    return { kind, grantId: uuid(entry.grantId), itemId: uuid(entry.itemId), spaceId: uuid(entry.spaceId), ownerMemberId: uuid(entry.ownerMemberId),
      revokedAt: at(entry.revokedAt) };
  }
  if (kind === 'approval_consumed') {
    const entry = record(value, 'approvalId,consumedAt,itemId,kind,operationId,ownerMemberId,spaceId');
    return { kind, approvalId: uuid(entry.approvalId), itemId: uuid(entry.itemId), spaceId: uuid(entry.spaceId), ownerMemberId: uuid(entry.ownerMemberId),
      operationId: uuid(entry.operationId), consumedAt: at(entry.consumedAt) };
  }
  return corrupt();
}

type Line = { tombstone: DeletionLedgerEntry } | { revocation: RevocationLedgerEntry };

function line(value: unknown): Line {
  const tagged = !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'kind');
  return tagged ? { revocation: checkedRevocation(value) } : { tombstone: checked(value) };
}

/**
 * One instance per broker. The operator-provided parent directory must exist.
 * One JSON object per line, in append order: a tombstone line has no `kind`
 * (the format before revocations, which still reads), a revocation line has one.
 */
export class FileDeletionLedger implements DeletionLedger {
  readonly #path: string;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = resolve(path); }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #read(): Promise<Line[]> {
    let file;
    try {
      try { file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (!(await file.stat()).isFile()) throw new Error();
      const bytes = await file.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.length === 0) return [];
      if (!text.endsWith('\n')) throw new Error();
      return text.slice(0, -1).split('\n').map((row) => line(JSON.parse(row)));
    } catch { throw new Error('vault deletion ledger: corrupt or unavailable file'); }
    finally { await file?.close(); }
  }

  #write(row: DeletionLedgerEntry | RevocationLedgerEntry): Promise<void> {
    return this.#exclusive(async () => {
      await this.#read(); // A damaged tail is never silently extended.
      try {
        const file = await open(this.#path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        try {
          if (!(await file.stat()).isFile()) throw new Error();
          await file.writeFile(JSON.stringify(row) + '\n');
          await file.sync();
        } finally { await file.close(); }
        const directory = await open(dirname(this.#path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { throw new Error('vault deletion ledger: append failed'); }
    });
  }

  async entries(): Promise<DeletionLedgerEntry[]> {
    return (await this.#exclusive(() => this.#read())).flatMap((row) => ('tombstone' in row ? [row.tombstone] : []));
  }

  async revocations(): Promise<RevocationLedgerEntry[]> {
    return (await this.#exclusive(() => this.#read())).flatMap((row) => ('revocation' in row ? [row.revocation] : []));
  }

  async append(entry: DeletionLedgerEntry): Promise<void> {
    await this.#write(checked(entry));
  }

  async appendRevocation(entry: RevocationLedgerEntry): Promise<void> {
    await this.#write(checkedRevocation(entry));
  }
}

const LEDGER_SCOPE = { kind: 'system', purpose: 'deletion_ledger' } as const;

/**
 * Called before accepting requests, after every restore as well as a normal
 * start. Tombstones first (a tombstone also revokes the item's grants and
 * expires its approvals), then revocations, in append order. Each change is its
 * own transaction with its audit event, so an audit outage leaves it unapplied
 * and the start fails. Returns how many entries changed the store.
 */
export async function replayDeletionLedger(store: VaultStore, ledger: DeletionLedger): Promise<number> {
  let count = 0;
  for (const entry of await ledger.entries()) {
    const changed = await store.transaction(LEDGER_SCOPE, async (tx) => {
      if (!(await tx.items.forceTombstone(entry))) return false;
      await tx.audit.append({ action: 'item.tombstone_replayed', actor: SYSTEM_ACTOR, itemId: entry.itemId, subjectMemberId: entry.ownerMemberId, spaceId: entry.spaceId, params: {} });
      return true;
    });
    if (changed) count += 1;
  }
  for (const entry of await ledger.revocations()) {
    const changed = await store.transaction(LEDGER_SCOPE, async (tx) => {
      const event = { actor: SYSTEM_ACTOR, itemId: entry.itemId, subjectMemberId: entry.ownerMemberId, spaceId: entry.spaceId };
      if (entry.kind === 'grant_revoked') {
        if (!(await tx.grants.forceRevoke(entry))) return false;
        await tx.audit.append({ ...event, action: 'grant.revoke_replayed', params: { grantId: entry.grantId } });
      } else {
        if (!(await tx.approvals.forceConsume(entry))) return false;
        await tx.audit.append({ ...event, action: 'approval.consume_replayed', params: { approvalId: entry.approvalId, operationId: entry.operationId } });
      }
      return true;
    });
    if (changed) count += 1;
  }
  return count;
}
