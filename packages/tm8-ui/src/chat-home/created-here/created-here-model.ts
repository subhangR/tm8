/**
 * CREATED HERE — the pure half of the strip on top of the chat composer.
 *
 * The strip lists the ROOTS this chat made, one kind at a time, each root
 * expandable to its whole subtree. Where "made here" comes from is the
 * server's business (`filters.createdIn`, migration 327: the recorded
 * `authored_from` edge, or a session's spawn parent); this module only shapes
 * what the reads returned. Everything here is a function of its inputs so the
 * rules are testable without a host.
 *
 * STATUS IS NOT RE-DERIVED. The word and tone come from `homeRowOf` — the one
 * summary→row projection Home, the rail and the fleet use — composed with the
 * seam's liveness verdict. This file only folds that into the strip's four
 * marks (running, done, waiting on a human, failed) and a `closed` flag for
 * greying. A pulse is reachable only through `homeRowOf`'s live treatment.
 */
import type { EntitySummary, WorkSessionStatus } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { homeRowOf } from '../../home/home-model';
import type { PillTone } from '../../kit';

/** The strip's one-glyph status. `null` = this kind has no status to show. */
export type MadeMark = 'running' | 'done' | 'waiting' | 'failed' | 'open' | null;

export interface MadeStatus {
  mark: MadeMark;
  /** homeRowOf's word, for the row's title and the screen reader. */
  word: string | null;
  tone: PillTone;
  /** Ended session, closed task: drawn greyed. */
  closed: boolean;
  /** The long-form honest sentence for a degraded verdict, when there is one. */
  detail?: string | undefined;
}

export type LivenessOf = (session: { id: string; status: WorkSessionStatus | null }) => SessionLiveness;

export function livenessFor(summary: EntitySummary, livenessOf: LivenessOf | undefined): SessionLiveness | null {
  if (summary.kind !== 'work_session' || !livenessOf) return null;
  const status = (summary.state as { status?: WorkSessionStatus }).status ?? null;
  return livenessOf({ id: summary.id, status });
}

export function madeStatusOf(summary: EntitySummary, livenessOf?: LivenessOf | undefined): MadeStatus {
  const liveness = livenessFor(summary, livenessOf);
  const row = homeRowOf(summary, liveness ? { liveness } : {});
  const state = summary.state as {
    kind: string; status?: string; outcome?: string; endedKind?: string | null;
  };
  const category = summary.category;
  const base = { word: row.word, tone: row.tone, ...(row.detail ? { detail: row.detail } : {}) };

  if (summary.kind === 'work_session') {
    const ended = state.status === 'exited' || state.status === 'failed';
    if (state.status === 'failed' || state.endedKind === 'crashed') return { ...base, mark: 'failed', closed: true };
    if (state.outcome === 'completed') return { ...base, mark: 'done', closed: ended || liveness !== 'live' };
    if (state.outcome === 'stopped') return { ...base, mark: 'done', closed: true };
    if (liveness === 'live') {
      /* A live session sitting idle with open work is waiting on its human —
         the registry's own word for that state, not a rule invented here. */
      if (state.status === 'idle') return { ...base, mark: 'waiting', closed: false };
      return { ...base, mark: 'running', closed: false };
    }
    return { ...base, mark: ended ? 'done' : 'open', closed: ended || liveness === 'not-running' };
  }

  if (category === 'done') return { ...base, mark: 'done', closed: true };
  if (category === 'cancelled') return { ...base, mark: 'failed', closed: true };
  if (state.status === 'blocked') return { ...base, mark: 'waiting', closed: false };
  if (state.status === 'working' || state.status === 'in_review' || category === 'in_progress') {
    return { ...base, mark: 'running', closed: false };
  }
  if (row.word === null) return { ...base, mark: null, closed: false };
  return { ...base, mark: 'open', closed: false };
}

/** Kinds that are never "made here" roots — every chat post carries provenance too. */
const NEVER_ROOTS = new Set(['message', 'form', 'chat']);

/**
 * ROOTS ONLY, DEDUPED, ONE PASS. The server already answers roots; this is the
 * client half of the same rule for the union with the transcript's own
 * creates (an older node records nothing for a chat). A root whose parent is
 * also in the set is a child and is left to that parent's subtree.
 */
export function rootsOf(items: readonly EntitySummary[], chatId: string): EntitySummary[] {
  const byId = new Map<string, EntitySummary>();
  for (const item of items) {
    if (NEVER_ROOTS.has(item.kind) || item.deletedAt) continue;
    if (item.id === chatId) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()]
    .filter((item) => !item.parentId || item.parentId === chatId || !byId.has(item.parentId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Kind tabs in a stable order: most roots first, then by name. */
export function kindsOf(roots: readonly EntitySummary[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const root of roots) counts.set(root.kind, (counts.get(root.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Sessions, then tasks, then docs: the order the strip was designed around. */
function kindRank(kind: string): number {
  const at = ['work_session', 'task', 'doc'].indexOf(kind);
  return at === -1 ? 3 : at;
}

export interface MadeSummary {
  running: number;
  waiting: number;
}

export function summaryOf(statuses: Iterable<MadeStatus>): MadeSummary {
  let running = 0;
  let waiting = 0;
  for (const status of statuses) {
    if (status.mark === 'running') running += 1;
    else if (status.mark === 'waiting') waiting += 1;
  }
  return { running, waiting };
}

export type MadeFilter = 'all' | 'running' | 'done';

export function passesFilter(status: MadeStatus, filter: MadeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return status.mark === 'running' || status.mark === 'waiting';
  return status.mark === 'done' || status.closed;
}

/** `18m`, `3h`, `2d` — the row's quiet age. Never negative. */
export function ageOf(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `Worker · Opus 5.5 1M` for a session; nothing for any other kind. */
export function sessionByline(summary: EntitySummary, modelLabel: (model: string) => string): string | null {
  if (summary.kind !== 'work_session') return null;
  const state = summary.state as { model?: string | null; teammate?: { displayName?: string | null } | null };
  const who = state.teammate?.displayName ?? (summary.createdBy.isAgent ? summary.createdBy.displayName : null);
  const model = state.model ? modelLabel(state.model) : null;
  return [who, model].filter(Boolean).join(' · ') || null;
}

/** Per-chat memory of the strip: open or not, and which kind. */
export interface MadeMemory {
  expanded: boolean;
  kind: string | null;
}

const MEMORY_PREFIX = 'tm8.chat.createdHere.';

export function readMemory(chatId: string, storage: Pick<Storage, 'getItem'> | null): MadeMemory {
  try {
    const raw = storage?.getItem(MEMORY_PREFIX + chatId);
    if (!raw) return { expanded: false, kind: null };
    const parsed = JSON.parse(raw) as Partial<MadeMemory>;
    return { expanded: parsed.expanded === true, kind: typeof parsed.kind === 'string' ? parsed.kind : null };
  } catch {
    return { expanded: false, kind: null };
  }
}

export function writeMemory(chatId: string, memory: MadeMemory, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(MEMORY_PREFIX + chatId, JSON.stringify(memory));
  } catch {
    // A full or disabled storage only costs the strip its memory.
  }
}
