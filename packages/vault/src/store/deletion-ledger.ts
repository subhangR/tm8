import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SYSTEM_ACTOR, type DeletionLedger, type DeletionLedgerEntry, type VaultStore } from '../core-types.js';

function checked(value: unknown): DeletionLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('vault deletion ledger: corrupt record');
  const entry = value as DeletionLedgerEntry;
  if (Object.keys(entry).sort().join(',') !== 'itemId,ownerMemberId,spaceId,tombstonedAt') throw new Error('vault deletion ledger: corrupt record');
  const uuid = (id: unknown): string => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('vault deletion ledger: corrupt record');
    return id.toLowerCase();
  };
  const at = entry.tombstonedAt;
  if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new Error('vault deletion ledger: corrupt record');
  }
  return { itemId: uuid(entry.itemId), spaceId: uuid(entry.spaceId), ownerMemberId: uuid(entry.ownerMemberId), tombstonedAt: at };
}

/** One instance per broker. The operator-provided parent directory must exist. */
export class FileDeletionLedger implements DeletionLedger {
  readonly #path: string;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = resolve(path); }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #read(): Promise<DeletionLedgerEntry[]> {
    let file;
    try {
      try { file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (!(await file.stat()).isFile()) throw new Error();
      const bytes = await file.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.length === 0) return [];
      if (!text.endsWith('\n')) throw new Error();
      return text.slice(0, -1).split('\n').map((line) => checked(JSON.parse(line)));
    } catch { throw new Error('vault deletion ledger: corrupt or unavailable file'); }
    finally { await file?.close(); }
  }

  entries(): Promise<DeletionLedgerEntry[]> { return this.#exclusive(() => this.#read()); }

  append(entry: DeletionLedgerEntry): Promise<void> {
    const record = checked(entry);
    return this.#exclusive(async () => {
      await this.#read(); // A damaged tail is never silently extended.
      try {
        const file = await open(this.#path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        try {
          if (!(await file.stat()).isFile()) throw new Error();
          await file.writeFile(JSON.stringify(record) + '\n');
          await file.sync();
        } finally { await file.close(); }
        const directory = await open(dirname(this.#path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { throw new Error('vault deletion ledger: append failed'); }
    });
  }
}

/** Called before accepting requests, after every restore as well as a normal start. */
export async function replayDeletionLedger(store: VaultStore, ledger: DeletionLedger): Promise<number> {
  let count = 0;
  for (const entry of await ledger.entries()) {
    const changed = await store.transaction({ kind: 'system', purpose: 'deletion_ledger' }, async (tx) => {
      if (!(await tx.items.forceTombstone(entry))) return false;
      await tx.audit.append({ action: 'item.tombstone_replayed', actor: SYSTEM_ACTOR, itemId: entry.itemId, subjectMemberId: entry.ownerMemberId, spaceId: entry.spaceId, params: {} });
      return true;
    });
    if (changed) count += 1;
  }
  return count;
}
