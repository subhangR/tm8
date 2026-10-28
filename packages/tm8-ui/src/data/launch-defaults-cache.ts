/**
 * THE LAUNCH DEFAULTS CACHE — this browser's last `launch.defaults` answer per
 * launch, and the loader every launch surface reads its defaults through.
 *
 * WHY. The defaults were read fresh on every open, so the launch card's strip
 * opened on "Reading what this launch starts with…" for as long as the node
 * took — every time, for the same teammate and task. The answer only moves
 * when the graph does (a memory remembered, a skill equipped, a doc linked),
 * which is rarely between two opens.
 *
 * CONTRACT
 *  - `launchDefaultsLoader(read, nodeKey, spaceId)` returns a
 *    `LoadLaunchDefaults`. Calling it asks the node — joining a read already
 *    in flight for the same input — and resolves with the NODE'S answer, which
 *    it then remembers. `peek(input)` answers synchronously from what was
 *    remembered: this tab's memory, filled from localStorage on first use, so
 *    a reload keeps the first frame warm.
 *  - Keyed by node, space and `launchDefaultsKey(input)` — exactly what the
 *    answer is a function of, so a hit answers THIS question, never a
 *    neighbour's (another subject's references are not this launch's).
 *  - Only an answer the node gave is stored. A failed read stores nothing and
 *    leaves the last answer where it was; the reader reports the failure.
 *  - Bounded: MAX_REMEMBERED launches per space, least recently answered out,
 *    and a payload past MAX_STORED_CHARS sheds its oldest launches before it
 *    is written — localStorage is one 5MB budget for the whole origin.
 *  - `clearLaunchDefaultsCache(nodeKey)` forgets every space's answers for a
 *    node, in memory and in storage. An explicit sign-out calls it
 *    (auth/session-reset.ts): the rows are graph content — titles, header
 *    text — from one viewer's spaces, keyed by node and space, never account.
 *
 * THE HONEST LIMIT. A remembered answer is a photograph. Its reader draws it
 * as `cached` until the node's answer confirms it, and Launch waits on any
 * group the person edits meanwhile (`domain/launch-defaults-read.ts`,
 * `launchBlock`), so a stale photograph is never what a launch SENDS: an
 * untouched group is omitted from the spawn and the node loads its own.
 * Two tabs share storage but not memory; the last to write wins.
 */
import type { LaunchDefaultsInput, LaunchDefaultsResult } from '@tm8/contract';

import { launchDefaultsKey } from '../domain/launch-defaults-read';
import type { LoadLaunchDefaults } from '../launch-selection/port';
import { browserStorage, forgetKeysWithPrefix } from './browser-store';
import { sharedRead } from './shared-read';

/** Bumped whenever the stored shape changes: a miss on this prefix ignores the old payload, never coerces it. */
const CACHE_VERSION = 'v1';
const KEY_PREFIX = `tm8.launch-defaults.${CACHE_VERSION}`;

/** Launches remembered per space — well past the teammate × task pairs one person opens in a sitting. */
const MAX_REMEMBERED = 24;
/** The stored payload's ceiling, in characters. */
const MAX_STORED_CHARS = 200_000;

interface StoredPayload {
  /** Most recently answered first. */
  entries: Array<{ key: string; result: LaunchDefaultsResult }>;
}

function storageKeyFor(nodeKey: string, spaceId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}`;
}

/**
 * This tab's answers per storage key, oldest first (Map insertion order, so
 * re-inserting moves a launch to the young end). Module state on purpose: it
 * outlives every card, which is the point.
 */
const memory = new Map<string, Map<string, LaunchDefaultsResult>>();

function isGroup(value: unknown): boolean {
  const group = value as { items?: unknown; total?: unknown } | null;
  return !!group && typeof group.total === 'number' && Array.isArray(group.items) && group.items.every((item) => {
    const row = item as { entityId?: unknown; title?: unknown; kind?: unknown } | null;
    return !!row && typeof row.entityId === 'string' && typeof row.title === 'string' && typeof row.kind === 'string';
  });
}

/** A structural check, not a cast: a row the strip reads must have the fields it reads. */
function isAnswer(value: unknown): value is LaunchDefaultsResult {
  const answer = value as Partial<Record<keyof LaunchDefaultsResult, unknown>> | null;
  return !!answer && isGroup(answer.memories) && isGroup(answer.skills) && isGroup(answer.references)
    && isGroup(answer.teammates) && Array.isArray(answer.warnings);
}

function readStored(storageKey: string): StoredPayload['entries'] {
  const store = browserStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredPayload> | null;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => !!entry && typeof entry.key === 'string' && isAnswer(entry.result));
  } catch {
    // Corrupt payload: drop it rather than fail every later open.
    try { store.removeItem(storageKey); } catch { /* nothing further to do */ }
    return [];
  }
}

function answersFor(storageKey: string): Map<string, LaunchDefaultsResult> {
  let answers = memory.get(storageKey);
  if (!answers) {
    answers = new Map(readStored(storageKey).reverse().map((entry) => [entry.key, entry.result]));
    memory.set(storageKey, answers);
  }
  return answers;
}

function persist(storageKey: string, answers: Map<string, LaunchDefaultsResult>): void {
  const store = browserStorage();
  if (!store) return;
  const entries: string[] = [];
  let size = 0;
  for (const [key, result] of [...answers].reverse()) {
    const entry = JSON.stringify({ key, result });
    if (size + entry.length > MAX_STORED_CHARS) break;
    entries.push(entry);
    size += entry.length + 1;
  }
  try {
    store.setItem(storageKey, `{"entries":[${entries.join(',')}]}`);
  } catch {
    // Quota or a storage policy. This tab still has its memory; the next
    // reload just opens cold. Nothing the viewer could act on.
  }
}

function remember(storageKey: string, key: string, result: LaunchDefaultsResult): void {
  const answers = answersFor(storageKey);
  answers.delete(key);
  answers.set(key, result);
  while (answers.size > MAX_REMEMBERED) answers.delete(answers.keys().next().value!);
  persist(storageKey, answers);
}

export function launchDefaultsLoader(
  read: (input: LaunchDefaultsInput) => Promise<LaunchDefaultsResult>,
  nodeKey: string,
  spaceId: string,
): LoadLaunchDefaults {
  const storageKey = storageKeyFor(nodeKey, spaceId);
  /* Never fresh (`freshForMs` 0): every call asks the node — the cache only
     ever answers `peek`, and the reader confirms what it drew. */
  const load = sharedRead(read, launchDefaultsKey, {
    onAnswer: (input, result) => { remember(storageKey, launchDefaultsKey(input), result); },
  });
  return Object.assign(load, {
    peek: (input: LaunchDefaultsInput) => answersFor(storageKey).get(launchDefaultsKey(input)) ?? null,
  });
}

export function clearLaunchDefaultsCache(nodeKey: string): void {
  const prefix = `${KEY_PREFIX}.${nodeKey}.`;
  for (const storageKey of [...memory.keys()]) if (storageKey.startsWith(prefix)) memory.delete(storageKey);
  forgetKeysWithPrefix(prefix);
}
