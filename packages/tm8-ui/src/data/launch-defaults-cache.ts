/**
 * THE LAUNCH DEFAULTS CACHE — the loader every launch surface reads its
 * defaults through, and this browser's stored copy of its answers.
 *
 * WHY. The defaults were read fresh on every open, so the launch card's strip
 * opened on "Reading what this launch starts with…" for as long as the node
 * took — every time, for the same teammate and task. The answer only moves
 * when the graph does (a memory remembered, a skill equipped, a doc linked),
 * which is rarely between two opens.
 *
 * CONTRACT
 *  - `launchDefaultsLoader(read, nodeKey, spaceId)` returns a
 *    `LoadLaunchDefaults`: a `sharedRead` (data/shared-read.ts) over
 *    `launch.defaults`, never fresh, so every call asks the node — joining a
 *    read already in flight — and resolves with the NODE'S answer. `peek`
 *    answers synchronously: the answer this loader kept, else the one this
 *    browser stored (the reader's `seed`), so a reload keeps the first frame
 *    warm too.
 *  - Keyed by node, space and `launchDefaultsKey(input)` — exactly what the
 *    answer is a function of, so a hit answers THIS question, never a
 *    neighbour's (another subject's references are not this launch's).
 *  - Only an answer the node gave is stored. A failed read stores nothing and
 *    leaves the last answer where it was; the reader reports the failure.
 *  - The store is bounded: MAX_REMEMBERED launches per space, least recently
 *    answered out, and a payload past MAX_STORED_CHARS sheds its oldest
 *    launches before it is written — localStorage is one 5MB origin budget.
 *    Every stored row is checked field by field before it is drawn.
 *  - `clearLaunchDefaultsCache(nodeKey)` forgets every space's answers for a
 *    node. An explicit sign-out calls it (auth/session-reset.ts): the rows are
 *    graph content — titles, header text — from one viewer's spaces, keyed by
 *    node and space, never account. An answer still in flight then is never
 *    stored, and a loader built before the sweep forgets what it kept the next
 *    time it is used.
 *
 * THE HONEST LIMIT. A remembered answer is a photograph. Its reader draws it
 * as `confirming` until the node's answer confirms it, and Launch waits on any
 * group the person edits meanwhile (`domain/launch-defaults-read.ts`,
 * `launchBlock`), so a stale photograph is never what a launch SENDS unless
 * the node could not be asked — and then the card says so. Two tabs share
 * storage, not memory; the last to write wins.
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

interface StoredEntry {
  key: string;
  result: LaunchDefaultsResult;
}

function storageKeyFor(nodeKey: string, spaceId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}`;
}

/**
 * Sign-out sweeps per node. A read asked before its node's sweep is never
 * stored after it: an answer still in flight when the viewer signed out is
 * the previous viewer's rows, and the sweep exists to forget exactly those.
 * Per node, because signing out of one server must not forget another's.
 */
const sweeps = new Map<string, number>();
const sweepOf = (nodeKey: string): number => sweeps.get(nodeKey) ?? 0;

const isText = (value: unknown) => typeof value === 'string';
const isTextOrNull = (value: unknown) => value === null || typeof value === 'string';

/** Every field `defaultRow` reads, checked — a row missing one would draw as derived text that is not there. */
function isGroup(value: unknown): boolean {
  const group = value as { items?: unknown; total?: unknown } | null;
  return !!group && typeof group.total === 'number' && Array.isArray(group.items) && group.items.every((item) => {
    const row = item as Partial<Record<'entityId' | 'kind' | 'title' | 'via' | 'headerText' | 'headerSource', unknown>> | null;
    return !!row && isText(row.entityId) && isText(row.kind) && isText(row.title) && isText(row.via)
      && isTextOrNull(row.headerText) && isTextOrNull(row.headerSource);
  });
}

/** A structural check, not a cast. */
function isAnswer(value: unknown): value is LaunchDefaultsResult {
  const answer = value as Partial<Record<keyof LaunchDefaultsResult, unknown>> | null;
  return !!answer && isGroup(answer.memories) && isGroup(answer.skills) && isGroup(answer.references)
    && isGroup(answer.teammates) && Array.isArray(answer.warnings) && answer.warnings.every(isText);
}

/** The stored answers, most recently answered first; [] when none, none readable, or none well-formed. */
function readStored(storageKey: string): StoredEntry[] {
  const store = browserStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return (parsed.entries as Array<Partial<StoredEntry> | null>).filter(
      (entry): entry is StoredEntry => !!entry && isText(entry.key) && isAnswer(entry.result),
    );
  } catch {
    // Corrupt payload: drop it rather than fail every later open.
    try { store.removeItem(storageKey); } catch { /* nothing further to do */ }
    return [];
  }
}

function store(storageKey: string, key: string, result: LaunchDefaultsResult): void {
  const browser = browserStorage();
  if (!browser) return;
  const entries = [{ key, result }, ...readStored(storageKey).filter((entry) => entry.key !== key)].slice(0, MAX_REMEMBERED);
  const kept: string[] = [];
  let size = 0;
  for (const entry of entries) {
    const json = JSON.stringify(entry);
    if (size + json.length > MAX_STORED_CHARS) break;
    kept.push(json);
    size += json.length + 1;
  }
  try {
    browser.setItem(storageKey, `{"entries":[${kept.join(',')}]}`);
  } catch {
    // Quota or a storage policy. The loader still keeps it for this tab; the
    // next reload just opens cold. Nothing the viewer could act on.
  }
}

export function launchDefaultsLoader(
  read: (input: LaunchDefaultsInput) => Promise<LaunchDefaultsResult>,
  nodeKey: string,
  spaceId: string,
): LoadLaunchDefaults {
  const storageKey = storageKeyFor(nodeKey, spaceId);
  const reader = sharedRead(
    (input: LaunchDefaultsInput) => {
      const asked = sweepOf(nodeKey);
      return read(input).then((result) => {
        if (asked === sweepOf(nodeKey)) store(storageKey, launchDefaultsKey(input), result);
        return result;
      });
    },
    launchDefaultsKey,
    {
      seed: (input) => readStored(storageKey).find((entry) => entry.key === launchDefaultsKey(input))?.result ?? null,
      maxKept: MAX_REMEMBERED,
    },
  );
  /* A sweep since this loader was last used: what it kept is the previous viewer's. */
  let sweptAt = sweepOf(nodeKey);
  const current = () => {
    if (sweptAt !== sweepOf(nodeKey)) { reader.forgetAll(); sweptAt = sweepOf(nodeKey); }
    return reader;
  };
  return Object.assign((input: LaunchDefaultsInput) => current()(input), {
    peek: (input: LaunchDefaultsInput) => current().peek(input),
  });
}

export function clearLaunchDefaultsCache(nodeKey: string): void {
  sweeps.set(nodeKey, sweepOf(nodeKey) + 1);
  forgetKeysWithPrefix(`${KEY_PREFIX}.${nodeKey}.`);
}
