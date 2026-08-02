/**
 * The session read-cache (F2) — byte-identical reads revalidated by event seq.
 *
 * THE MEASURED TARGET: ~30% of real agent traffic is a byte-identical repeat
 * of a read the same session already made (~345k est tokens in the evidence
 * corpus; same entity ×5, message list ×9). This cache serves those repeats
 * from disk — but NEVER blindly: a hit is served only after a ~free
 * `events.poll --since <seq>` says nothing touched the entity, and a fetch
 * that cannot carry that coherence basis is not cached at all. Correctness
 * rule, stated once: THE CACHE MAY ONLY EVER CAUSE A REFETCH IT COULD HAVE
 * SKIPPED, never skip a fetch it could not prove redundant. Every uncertain
 * path below (no seq, no space, parse failure, poll failure) falls through to
 * the network.
 *
 * WHY A DIRECTORY AND NOT PROCESS MEMORY: every `tm8` command is its own
 * short-lived process (the GPT-F2 objection to CLI placement), so the store
 * lives next to the journal — `<TM8_JOURNAL_PATH>.cache/` — and is therefore
 * per-session by the same construction that makes the journal per-session.
 * Nothing here is shared across sessions and nothing survives the session's
 * journal being cleaned up.
 *
 * THE GATE mirrors the journal's, plus two cache-specific offs: TM8_NO_CACHE
 * disables it outright (the integration suite sets this — fixtures must stay
 * deterministic), and a `harness`-classed environment never caches (same
 * heuristics as the journal class tag, so the two subsystems cannot disagree
 * about who is running).
 *
 * SEQ PROVENANCE, in precedence order:
 *   1. the response's own `provenance.eventSeq` (entity context carries one);
 *   2. the session's per-space WATERMARK — the highest seq this cache has seen
 *      any evidence for, recorded from context provenance and from
 *      revalidation polls. A watermark taken BEFORE a fetch is conservative:
 *      anything that changed after it triggers a refetch, including changes
 *      that predate the cached bytes. Conservative is the correct direction.
 *   3. none — the entry is NOT stored. Serve-stale-with-notice was considered
 *      and rejected: a notice does not make stale bytes coherent.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveJournalClass } from './journal-stats.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface CacheEntry {
  /** `<operation> <pathname>?<sorted query>` — the byte-identity key. */
  key: string;
  operation: string;
  /** Entities this payload is ABOUT — the invalidation join key. */
  entityIds: string[];
  spaceId: string;
  /** The per-space seq this payload is known-coherent as of. */
  seq: number;
  status: number;
  text: string;
  storedAt: string;
}

export interface ReadCache {
  readonly enabled: boolean;
  /** The byte-identity key for a resolved request, or null if uncacheable. */
  keyFor(operation: string, pathname: string, search: URLSearchParams): string | null;
  read(key: string): CacheEntry | null;
  /** Store a successful read. Silently refuses entries with no coherence basis. */
  store(operation: string, pathname: string, search: URLSearchParams, status: number, text: string): void;
  /** A mutation happened: drop every entry about any of these entities. */
  invalidate(ids: Iterable<string>): void;
  /** Drop one entry (its revalidation said the world moved). */
  evict(key: string): void;
  /** Advance the per-space watermark — evidence flows in, never out. */
  advanceWatermark(spaceId: string, seq: number): void;
  watermark(spaceId: string): number | null;
  /** Print the served-from-cache notice. Stderr only, like the spend line. */
  notice(entry: CacheEntry): void;
}

const INERT: ReadCache = {
  enabled: false,
  keyFor: () => null,
  read: () => null,
  store: () => {},
  invalidate: () => {},
  evict: () => {},
  advanceWatermark: () => {},
  watermark: () => null,
  notice: () => {},
};

export function createReadCache(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = safeCwd(),
): ReadCache {
  const journalPath = env.TM8_JOURNAL_PATH;
  const sessionId = env.TM8_SESSION_ID;
  if (!journalPath || !sessionId) return INERT;
  if (env.TM8_NO_CACHE) return INERT;
  // The class gate: a harness never caches. Same heuristics as the journal
  // tag (no calls exist yet at construction, so this is env + cwd only).
  if (resolveJournalClass(env, [], cwd) !== 'agent') return INERT;
  return new DirReadCache(`${journalPath}.cache`);
}

class DirReadCache implements ReadCache {
  readonly enabled = true;

  constructor(private readonly dir: string) {}

  keyFor(operation: string, pathname: string, search: URLSearchParams): string {
    const sorted = new URLSearchParams(search);
    sorted.sort();
    const qs = sorted.toString();
    return `${operation} ${pathname}${qs === '' ? '' : `?${qs}`}`;
  }

  read(key: string): CacheEntry | null {
    try {
      const entry = JSON.parse(readFileSync(this.fileFor(key), 'utf8')) as CacheEntry;
      // A torn or foreign file is a miss, never an error — and never served.
      if (entry.key !== key || typeof entry.text !== 'string' || typeof entry.seq !== 'number') {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  store(operation: string, pathname: string, search: URLSearchParams, status: number, text: string): void {
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return; // a non-JSON read has no ids to key coherence on
      }
      const data = (payload as { data?: unknown }).data as Record<string, unknown> | undefined;
      if (data === undefined || data === null || typeof data !== 'object') return;

      const spaceId = findSpaceId(data);
      if (spaceId === null) return; // no space, no event stream, no coherence
      const ownSeq = findEventSeq(data);
      if (ownSeq !== null) this.advanceWatermark(spaceId, ownSeq);
      const seq = ownSeq ?? this.watermark(spaceId);
      if (seq === null) return; // rule above: no basis, no entry

      const key = this.keyFor(operation, pathname, search);
      const entityIds = [...new Set([
        ...(pathname.match(UUID_RE) ?? []),
        ...idsOf(data),
      ])].map((id) => id.toLowerCase());

      const entry: CacheEntry = {
        key, operation, entityIds, spaceId, seq, status, text,
        storedAt: new Date().toISOString(),
      };
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.fileFor(key), JSON.stringify(entry), 'utf8');
    } catch {
      // The cache is an accelerator. Failing to store must cost nothing.
    }
  }

  invalidate(ids: Iterable<string>): void {
    try {
      const targets = new Set([...ids].map((id) => id.toLowerCase()));
      if (targets.size === 0) return;
      for (const file of this.entryFiles()) {
        try {
          const entry = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as CacheEntry;
          if (entry.entityIds?.some((id) => targets.has(id))) {
            rmSync(join(this.dir, file), { force: true });
          }
        } catch {
          rmSync(join(this.dir, file), { force: true }); // unreadable = untrusted
        }
      }
    } catch {
      /* an unreadable dir invalidates nothing it could have served either */
    }
  }

  evict(key: string): void {
    try {
      rmSync(this.fileFor(key), { force: true });
    } catch {
      /* as above */
    }
  }

  advanceWatermark(spaceId: string, seq: number): void {
    try {
      if (!Number.isFinite(seq) || seq < 0) return;
      const marks = this.readWatermarks();
      if ((marks[spaceId] ?? -1) >= seq) return;
      marks[spaceId] = seq;
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, 'watermarks.json'), JSON.stringify(marks), 'utf8');
    } catch {
      /* a lost watermark only costs a refetch */
    }
  }

  watermark(spaceId: string): number | null {
    const seq = this.readWatermarks()[spaceId];
    return typeof seq === 'number' ? seq : null;
  }

  notice(entry: CacheEntry): void {
    try {
      process.stderr.write(`[cached: unchanged since seq ${entry.seq}; --fresh re-fetches]\n`);
    } catch {
      /* the notice is advice */
    }
  }

  private readWatermarks(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'watermarks.json'), 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private entryFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith('.entry.json'));
    } catch {
      return [];
    }
  }

  private fileFor(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.entry.json`);
  }
}

/** The response's own per-space seq, where a DTO carries one (entity context). */
function findEventSeq(data: Record<string, unknown>): number | null {
  const provenance = data['provenance'] as { eventSeq?: unknown } | undefined;
  return typeof provenance?.eventSeq === 'number' ? provenance.eventSeq : null;
}

function findSpaceId(data: Record<string, unknown>): string | null {
  const direct = data['spaceId'];
  if (typeof direct === 'string') return direct;
  const root = data['root'] as { spaceId?: unknown } | undefined;
  if (typeof root?.spaceId === 'string') return root.spaceId;
  const entity = data['entity'] as { spaceId?: unknown } | undefined;
  if (typeof entity?.spaceId === 'string') return entity.spaceId;
  return null;
}

/** The entity ids a payload is ABOUT: its own id and its root's, not every id in it. */
function idsOf(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof data['id'] === 'string') out.push(data['id']);
  const root = data['root'] as { id?: unknown } | undefined;
  if (typeof root?.id === 'string') out.push(root.id);
  return out;
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/** The process singleton, gated exactly like the journal's. */
export const readCache: ReadCache = createReadCache();
