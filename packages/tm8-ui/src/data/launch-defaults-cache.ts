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
 *  - `launchDefaultsLoader(read, nodeKey, spaceId, viewerOf)` returns a
 *    `LoadLaunchDefaults`: a `sharedRead` (data/shared-read.ts) over
 *    `launch.defaults`, never fresh, so every call asks the node — joining a
 *    read already in flight — and resolves with the NODE'S answer. `peek`
 *    answers synchronously: the answer this loader kept, else the one this
 *    browser stored for the viewer (the reader's `seed`), so a reload keeps
 *    the first frame warm too.
 *  - Stored per node, space and VIEWER (`viewerOf()`, read at each use, so the
 *    loader keeps one identity while the viewer resolves; no viewer yet means
 *    nothing is stored), and keyed by `launchDefaultsKey(input)` — exactly
 *    what the answer is a function of, so a hit answers THIS question.
 *  - Only an answer the node gave is stored. A failed read stores nothing and
 *    leaves the last answer where it was; the reader reports the failure.
 *  - The store is bounded and recency wins: the newest answer first, older
 *    launches while they fit MAX_STORED_CHARS (localStorage is one 5MB origin
 *    budget), at most MAX_REMEMBERED. Every stored row is checked against
 *    every field its readers use before it is drawn.
 *  - `clearLaunchDefaultsCache(nodeKey)` forgets every space's and viewer's
 *    answers for a node. An explicit sign-out calls it (auth/session-reset.ts);
 *    an expired pass does not — the store is viewer-keyed, so the next person
 *    reads their own key, and the same person keeps a warm first frame. An
 *    answer still in flight at a sweep is never stored, and a loader built
 *    before it forgets what it kept the next time it is used.
 *
 * THE HONEST LIMIT. A remembered answer is a photograph. Its reader draws it
 * unconfirmed until the node's answer confirms it, and an EDITED group never
 * launches on it (`domain/launch-defaults-read.ts`, `launchBlock`): an
 * untouched group is omitted and the node loads its own. Two tabs share
 * storage, not memory; the last to write wins.
 */
import type { LaunchDefaultsInput, LaunchDefaultsResult } from '@tm8/contract';

import { launchDefaultsKey } from '../domain/launch-defaults-read';
import type { LoadLaunchDefaults } from '../launch-selection/port';
import { browserStorage, forgetKeysWithPrefix } from './browser-store';
import { sharedRead } from './shared-read';

/**
 * Bumped whenever the stored shape changes: a miss on this prefix ignores the
 * old payload, never coerces it. v2: entries are stored as their own JSON
 * strings, so reading them never re-serialises.
 */
const CACHE_VERSION = 'v2';
const KEY_PREFIX = `tm8.launch-defaults.${CACHE_VERSION}`;

/** Launches remembered per space — well past the teammate × task pairs one person opens in a sitting. */
const MAX_REMEMBERED = 24;
/** The stored payload's ceiling, in characters. */
const MAX_STORED_CHARS = 200_000;

/** One stored launch: its key, its answer, and the exact JSON string stored for it. */
interface StoredEntry {
  key: string;
  result: LaunchDefaultsResult;
  json: string;
}

/**
 * Node, space AND viewer: two people on one browser never seed each other's
 * first frame. Each segment is URI-encoded and joined with `|` (which encoding
 * never leaves bare), so one node's segment can never be a prefix of another's
 * — `https___host` must not sweep `https___host.example`.
 */
const segment = (part: string) => encodeURIComponent(part);
function nodePrefix(nodeKey: string): string {
  return `${KEY_PREFIX}|${segment(nodeKey)}|`;
}
function storageKeyFor(nodeKey: string, spaceId: string, viewerId: string): string {
  return `${nodePrefix(nodeKey)}${segment(spaceId)}|${segment(viewerId)}`;
}

/**
 * Sign-out sweeps per node. A read asked before its node's sweep is never
 * stored after it: an answer still in flight when the viewer signed out is
 * the previous viewer's rows, and the sweep exists to forget exactly those.
 * Per node, because signing out of one server must not forget another's.
 */
const sweeps = new Map<string, number>();
const sweepOf = (nodeKey: string): number => sweeps.get(nodeKey) ?? 0;

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown) => value === null || typeof value === 'string';
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * Every field the contract requires, checked — the typed shape this returns
 * is the full `LaunchDefaultsResult`, so nothing is assumed: a stored row with
 * `budget: "12k"` or no `minEntries` is not drawn (it is simply not cached;
 * the node's own answer still arrives).
 */
function isGroup(value: unknown): boolean {
  const group = value as Partial<Record<'items' | 'total' | 'budget' | 'floor' | 'minEntries', unknown>> | null;
  return !!group && isNumber(group.total) && (group.budget === null || isNumber(group.budget))
    && isNumber(group.floor) && isNumber(group.minEntries) && Array.isArray(group.items) && group.items.every((item) => {
      const row = item as Partial<Record<'entityId' | 'kind' | 'title' | 'via' | 'headerText' | 'headerSource' | 'promptBytes', unknown>> | null;
      return !!row && isText(row.entityId) && isText(row.kind) && isText(row.title) && isText(row.via)
        && isTextOrNull(row.headerText) && isTextOrNull(row.headerSource) && isNumber(row.promptBytes);
    });
}

/** A structural check, not a cast. */
function isAnswer(value: unknown): value is LaunchDefaultsResult {
  const answer = value as Partial<Record<keyof LaunchDefaultsResult, unknown>> | null;
  return !!answer && isGroup(answer.memories) && isGroup(answer.skills) && isGroup(answer.references)
    && isGroup(answer.teammates) && Array.isArray(answer.warnings) && answer.warnings.every(isText)
    && isTextOrNull(answer.taskId) && (answer.contextIndex === 'on' || answer.contextIndex === 'off');
}

/** The stored answers, most recently answered first; [] when none, none readable, or none well-formed. */
function readStored(storageKey: string): StoredEntry[] {
  const browser = browserStorage();
  if (!browser) return [];
  try {
    const raw = browser.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((json): StoredEntry[] => {
      if (!isText(json)) return [];
      try {
        const entry = JSON.parse(json) as { key?: unknown; result?: unknown } | null;
        return entry && isText(entry.key) && isAnswer(entry.result) ? [{ key: entry.key, result: entry.result, json }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    // Corrupt payload: drop it rather than fail every later open.
    try { browser.removeItem(storageKey); } catch { /* nothing further to do */ }
    return [];
  }
}

/**
 * The next stored list after an answer: RECENCY WINS. The new answer goes
 * first, then older launches while they fit the ceiling. An answer too big to
 * ever fit is the one thing skipped — and then that launch's previous entry
 * stays, rather than the launch losing its cache altogether.
 */
function nextStored(stored: readonly StoredEntry[], fresh: StoredEntry): StoredEntry[] {
  const fits = fresh.json.length <= MAX_STORED_CHARS;
  const out: StoredEntry[] = fits ? [fresh] : [];
  let size = fits ? fresh.json.length + 1 : 0;
  for (const entry of stored) {
    if (out.length >= MAX_REMEMBERED) break;
    if (fits && entry.key === fresh.key) continue;
    if (size + entry.json.length > MAX_STORED_CHARS) continue;
    out.push(entry);
    size += entry.json.length + 1;
  }
  return out;
}

/** The store for one viewer: parsed once, kept in memory until a write or a sweep. */
function storeFor(storageKey: string) {
  let entries: StoredEntry[] | null = null;
  const current = () => (entries ??= readStored(storageKey));
  return {
    find(key: string): LaunchDefaultsResult | null {
      return current().find((entry) => entry.key === key)?.result ?? null;
    },
    write(key: string, result: LaunchDefaultsResult): void {
      const fresh = { key, result, json: JSON.stringify({ key, result }) };
      const stored = current();
      /* The same answer already newest: nothing to write (the common reopen). */
      if (stored[0]?.json === fresh.json) return;
      const next = nextStored(stored, fresh);
      /* Nothing changed (the answer could not fit, and the rest stands): no write. */
      if (next.length === stored.length && next.every((entry, i) => entry.json === stored[i]!.json)) return;
      entries = next;
      try {
        browserStorage()?.setItem(storageKey, JSON.stringify({ entries: next.map((entry) => entry.json) }));
      } catch {
        // Quota or a storage policy. The loader still keeps it for this tab; the
        // next reload just opens cold. Nothing the viewer could act on.
      }
    },
  };
}

export function launchDefaultsLoader(
  read: (input: LaunchDefaultsInput) => Promise<LaunchDefaultsResult>,
  nodeKey: string,
  spaceId: string,
  /** Who is viewing, read at each use; null while not known yet — answers are then kept for this tab only. */
  viewerOf: () => string | null,
): LoadLaunchDefaults {
  let stores = new Map<string, ReturnType<typeof storeFor>>();
  const storeOf = (): ReturnType<typeof storeFor> | null => {
    const viewerId = viewerOf();
    if (!viewerId) return null;
    let store = stores.get(viewerId);
    if (!store) { store = storeFor(storageKeyFor(nodeKey, spaceId, viewerId)); stores.set(viewerId, store); }
    return store;
  };
  const reader = sharedRead(read, launchDefaultsKey, {
    seed: (input) => storeOf()?.find(launchDefaultsKey(input)) ?? null,
    maxKept: MAX_REMEMBERED,
  });
  /* What the reader keeps in memory belongs to ONE viewer, exactly like the
     store: a sweep since this loader was last used, or a different viewer
     now, and it is forgotten before anything is peeked or kept. */
  let sweptAt = sweepOf(nodeKey);
  let keptFor = viewerOf();
  const current = () => {
    const viewer = viewerOf();
    if (sweptAt !== sweepOf(nodeKey) || viewer !== keptFor) {
      reader.forgetAll();
      if (sweptAt !== sweepOf(nodeKey)) stores = new Map();
      sweptAt = sweepOf(nodeKey);
      keptFor = viewer;
    }
    return reader;
  };
  /* The sweep a call is asked under is taken AT the call: an answer that lands
     after a sign-out is never stored for the next viewer. */
  const call = (input: LaunchDefaultsInput) => {
    const asked = sweepOf(nodeKey);
    const reading = current();
    /* The store of the viewer who ASKED: an answer landing after the viewer
       changed is never written under the next one's key. */
    const store = storeOf();
    return reading(input).then((result) => {
      if (asked === sweepOf(nodeKey)) store?.write(launchDefaultsKey(input), result);
      return result;
    });
  };
  return Object.assign(call, {
    peek: (input: LaunchDefaultsInput) => current().peek(input),
  });
}

export function clearLaunchDefaultsCache(nodeKey: string): void {
  sweeps.set(nodeKey, sweepOf(nodeKey) + 1);
  forgetKeysWithPrefix(nodePrefix(nodeKey));
}
