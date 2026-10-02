/**
 * STYLE SYNC — where the painted style comes from once someone is signed in
 * (styles spec v8 §1.6, §3.6, §4.3, §10.1).
 *
 * `style-store.ts` is the painter: it holds a preference PAIR (current + dark)
 * and paints one half of it. This module decides the pair:
 *
 *   1. `identity.get` → `stylePrefs` (the viewer's row, or `null`).
 *   2. A row: its `currentStyle` / `darkStyle`, each LIVE when still readable
 *      (`styles.get`) and otherwise the row's `snapshot` (the picker says
 *      "removed" or "detached"). No row: the current space's default when the
 *      space has one, else the local choice / the OS (§3.6, see DEVIATION).
 *   3. Live: `entity.upsert` / `entity.deleted` of a style in play,
 *      `personal_style.updated`, `identity.style_prefs.updated` (stale
 *      revisions ignored) and `space.style_default.updated` — all folded into
 *      ONE commit per animation frame, so a burst of pushes is one repaint.
 *
 * WRITES go through `identity.stylePrefs.set` with `expectedRevision`. The
 * store paints first (a press must answer within a frame); the server's answer
 * then replaces the pair. A conflict re-reads and re-applies the press once; a
 * refusal re-reads and rethrows so the picker can say why.
 *
 * DEVIATION FROM §10.1 ROW 2, written down: "no legacy key ⇒ write prefs
 * {atelier-light, atelier-dark, followOs}" would give every new member a prefs
 * row on first boot, and a prefs row outranks the space default (§3.6) — so
 * acceptance a2 ("new members with no prefs get the space default") could
 * never hold. A viewer who has chosen nothing therefore gets NO row: they
 * follow the OS between the built-ins exactly as before, unless their space
 * has a default (revision > 0), which then applies. A real choice — the legacy
 * key, or a pick made signed out — is migrated as §10.1 row 1 says.
 */
import {
  BUILTIN_STYLE_IDS,
  parseStyleRef,
  type DurableWorkspaceEvent,
  type SpaceStyleDefaultView,
  type StyleDoc,
  type StylePrefsSetInput,
  type StylePrefsView,
  type StyleRef,
} from '@tm8/contract';

import type { Seam } from '../data/seam';
import {
  applySelection,
  builtinEntry,
  clearLegacyTheme,
  currentSelection,
  entryFor,
  getStyleState,
  osSelection,
  registerThemeWriter,
  selectStyle,
  type StyleEntry,
  type StyleEntryStatus,
  type StyleSelection,
  type Theme,
} from './style-store';

export type StyleSyncSeam = Pick<Seam, 'identity' | 'onEvent' | 'onResync'> &
  Partial<Pick<Seam, 'stylePrefs' | 'setStylePrefs' | 'styleDefault' | 'style'>>;

/** What this tab knows about one non-built-in style it may paint. */
interface KnownStyle {
  /** Absent when the style became unreadable before this tab ever read it. */
  doc?: StyleDoc;
  title?: string | null;
  /** Member who pushed the current version (space styles); their css runs for them. */
  pushedBy?: string | null;
  /** Personal: `version`; space: entity version. Drops stale duplicate events. */
  version?: number;
  status: StyleEntryStatus;
}

type CatalogListener = () => void;

interface SyncState {
  seam: StyleSyncSeam;
  spaceId: string | null;
  viewerMemberId: string | null;
  /** `undefined`: not known (loading, or a node that predates styles). */
  prefs: StylePrefsView | null | undefined;
  defaults: Map<string, SpaceStyleDefaultView>;
  known: Map<string, KnownStyle>;
  inflight: Set<string>;
  frame: number | null;
  alive: boolean;
}

let sync: SyncState | null = null;
let stopper: (() => void) | null = null;
const catalogListeners = new Set<CatalogListener>();

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function trustFor(s: SyncState, ref: string, known: KnownStyle | undefined): boolean {
  const parsed = parseStyleRef(ref);
  if (!parsed || parsed.kind !== 'space') return true;
  /* §6.8 item 3: a space style's css runs for the pusher of the current
     version always, and for anyone else only after their per-style opt-in. */
  if (s.prefs?.trustedCss.includes(parsed.id)) return true;
  return !!known?.pushedBy && known.pushedBy === s.viewerMemberId;
}

/**
 * The entry for `ref` in `slot`. Live when this tab holds the readable doc;
 * otherwise the prefs snapshot for that slot (the last version the viewer
 * could see); otherwise Atelier Light.
 */
function entryForRef(s: SyncState, ref: string, slot: 'current' | 'dark' | 'default'): StyleEntry {
  const parsed = parseStyleRef(ref);
  if (parsed?.kind === 'builtin') {
    const builtin = builtinEntry(ref as StyleRef);
    if (builtin) return builtin;
  }
  const known = parsed ? s.known.get(ref) : undefined;
  if (parsed && known?.doc && known.status === 'live') {
    return { ref: ref as StyleRef, doc: known.doc, title: known.title ?? null, trustCss: trustFor(s, ref, known), status: 'live' };
  }
  const snapshot = slot === 'current' ? s.prefs?.snapshot.current : slot === 'dark' ? s.prefs?.snapshot.dark : null;
  const doc = snapshot ?? known?.doc ?? null;
  if (parsed && doc) {
    return {
      ref: ref as StyleRef,
      doc,
      title: known?.title ?? (slot === 'current' ? s.prefs?.snapshot.currentTitle ?? null : null),
      trustCss: trustFor(s, ref, known),
      /* Not yet read in this tab: the snapshot stands in as live until the
         read answers, because the server refreshes it on every push. */
      status: known?.status ?? 'live',
    };
  }
  return builtinEntry(BUILTIN_STYLE_IDS.light)!;
}

/** §3.6, as a pure function of what this tab knows. `null` = keep the local pair. */
function compose(s: SyncState): StyleSelection | null {
  if (s.prefs === undefined) return null;
  if (s.prefs) {
    return {
      current: entryForRef(s, s.prefs.currentStyle, 'current'),
      dark: s.prefs.darkStyle ? entryForRef(s, s.prefs.darkStyle, 'dark') : null,
      followOs: s.prefs.followOs,
      revision: s.prefs.revision,
      source: 'prefs',
    };
  }
  const def = s.spaceId ? s.defaults.get(s.spaceId) : undefined;
  if (def && def.revision > 0) {
    const current = entryForRef(s, def.defaultStyle, 'default');
    return { current, dark: null, followOs: false, revision: 0, source: 'default' };
  }
  /* No row and no space default. The pair on screen is the local choice or
     the OS — unless it came from a prefs row or a default that no longer
     applies (another account's cache on this device, a space switch). */
  const source = getStyleState().source;
  return source === 'os' || source === 'local' ? null : osSelection();
}

function notifyCatalog(): void {
  for (const listener of [...catalogListeners]) listener();
}

function commitNow(s: SyncState): void {
  s.frame = null;
  if (!s.alive || sync !== s) return;
  const next = compose(s);
  if (next) applySelection(next);
  notifyCatalog();
}

/** Coalesce: every change in one frame becomes one apply (one repaint). */
function scheduleCommit(s: SyncState): void {
  if (s.frame !== null || !s.alive) return;
  s.frame =
    typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(() => commitNow(s))
      : (setTimeout(() => commitNow(s), 0) as unknown as number);
}

/** The non-built-in refs the current §3.6 answer may paint. */
function refsInPlay(s: SyncState): string[] {
  const refs: string[] = [];
  if (s.prefs) {
    refs.push(s.prefs.currentStyle);
    if (s.prefs.darkStyle) refs.push(s.prefs.darkStyle);
  } else if (s.prefs === null && s.spaceId) {
    const def = s.defaults.get(s.spaceId);
    if (def && def.revision > 0) refs.push(def.defaultStyle);
  }
  return refs.filter((ref) => parseStyleRef(ref)?.kind !== 'builtin');
}

async function readStyle(s: SyncState, ref: string): Promise<KnownStyle | null> {
  if (!s.seam.style) return null;
  try {
    const got = await s.seam.style(ref);
    const known: KnownStyle = {
      doc: got.doc,
      title: got.title,
      pushedBy: got.space?.pushedBy ?? null,
      version: got.version,
      status: 'live',
    };
    s.known.set(ref, known);
    return known;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'not_found' || code === 'forbidden') {
      /* Not readable now. A space style that is gone was removed by an admin;
         anything else (a deleted personal style, a space this viewer left)
         is detached. Either way the snapshot paints (§3.6). */
      const prior = s.known.get(ref);
      const removed = code === 'not_found' && parseStyleRef(ref)?.kind === 'space';
      s.known.set(ref, { ...prior, status: removed ? 'removed' : 'detached' });
    }
    return null;
  }
}

function fetchMissing(s: SyncState): void {
  for (const ref of refsInPlay(s)) {
    if (s.known.has(ref) || s.inflight.has(ref)) continue;
    s.inflight.add(ref);
    void readStyle(s, ref).finally(() => {
      s.inflight.delete(ref);
      scheduleCommit(s);
    });
  }
}

async function loadDefault(s: SyncState, spaceId: string): Promise<void> {
  if (!s.seam.styleDefault) return;
  try {
    const view = await s.seam.styleDefault(spaceId);
    const prior = s.defaults.get(spaceId);
    if (!prior || view.revision >= prior.revision) s.defaults.set(spaceId, view);
  } catch {
    /* A failed read leaves the default unknown — the local pair stands. */
  }
}

async function reloadPrefs(s: SyncState): Promise<void> {
  if (!s.seam.stylePrefs) return;
  try {
    const { prefs } = await s.seam.stylePrefs();
    if (!s.alive) return;
    adoptPrefs(s, prefs);
  } catch {
    /* Keep what we have; the next event or resync tries again. */
  }
}

function adoptPrefs(s: SyncState, prefs: StylePrefsView | null): void {
  const known = s.prefs?.revision ?? 0;
  /* Never step backwards: a slow read can land after a newer write. A row
     that disappears (revision 0) is only believed from a full read. */
  if (prefs && s.prefs && prefs.revision < known) return;
  s.prefs = prefs;
  fetchMissing(s);
  scheduleCommit(s);
}

/**
 * THE ONE-TIME MIGRATION (§10.1 row 1). Runs only when the server has no row
 * AND this device holds a real choice (`source: 'local'`: the legacy key, or a
 * pick made signed out). The legacy key goes once the server has the choice.
 */
async function migrateLocalChoice(s: SyncState): Promise<void> {
  const local = getStyleState();
  if (local.source !== 'local' || !s.seam.setStylePrefs) return;
  /* A local pick can only have been a built-in (no server, no other docs),
     but the guard costs nothing. */
  if (parseStyleRef(local.current.ref)?.kind !== 'builtin') return;
  try {
    const result = await s.seam.setStylePrefs({
      expectedRevision: 0,
      currentStyle: local.current.ref,
      darkStyle: local.dark && local.followOs ? local.dark.ref : null,
      followOs: local.followOs,
    });
    clearLegacyTheme();
    adoptPrefs(s, result.prefs);
  } catch (error) {
    /* Another tab migrated first (conflict): read what it wrote. */
    if (errorCode(error) === 'version_conflict') await reloadPrefs(s);
  }
}

async function boot(s: SyncState): Promise<void> {
  let prefs: StylePrefsView | null | undefined;
  try {
    prefs = (await s.seam.identity()).stylePrefs;
  } catch {
    return;
  }
  if (!s.alive) return;
  /* ABSENT means a node that predates styles: keep the local pair, write
     nothing, and do not touch the legacy key — it is still the only record. */
  if (prefs === undefined) return;
  if (s.spaceId) await loadDefault(s, s.spaceId);
  if (!s.alive) return;
  if (prefs) {
    clearLegacyTheme();
    adoptPrefs(s, prefs);
    return;
  }
  s.prefs = null;
  await migrateLocalChoice(s);
  fetchMissing(s);
  scheduleCommit(s);
}

// ── events ──────────────────────────────────────────────────────────────────

function inPlay(s: SyncState, ref: string): boolean {
  return refsInPlay(s).includes(ref) || s.known.has(ref);
}

function onEvent(s: SyncState, event: DurableWorkspaceEvent): void {
  switch (event.type) {
    case 'entity.upsert':
    case 'entity.deleted': {
      if (event.entity.kind !== 'style') return;
      const ref = `space:${event.entity.id}`;
      const prior = s.known.get(ref);
      if (event.type === 'entity.deleted' || event.entity.deletedAt) {
        if (inPlay(s, ref)) s.known.set(ref, { ...prior, status: 'removed' });
      } else if (event.entity.state.kind === 'style') {
        if (prior?.version !== undefined && event.entity.version < prior.version) return;
        /* The event carries the full document (sign-off decision): no fetch. */
        if (inPlay(s, ref)) {
          s.known.set(ref, {
            doc: event.entity.state.doc,
            title: event.entity.title,
            pushedBy: event.entity.state.pushedBy,
            version: event.entity.version,
            status: 'live',
          });
        }
      }
      scheduleCommit(s);
      return;
    }
    case 'personal_style.updated': {
      const ref = `personal:${event.id}`;
      const prior = s.known.get(ref);
      if (prior?.version !== undefined && event.version < prior.version) return;
      if (event.deleted || !event.doc) {
        if (inPlay(s, ref)) s.known.set(ref, { ...prior, version: event.version, status: 'detached' });
      } else if (inPlay(s, ref)) {
        s.known.set(ref, { ...prior, doc: event.doc, version: event.version, status: 'live' });
      }
      scheduleCommit(s);
      return;
    }
    case 'identity.style_prefs.updated': {
      /* One row per active membership reaches every open space: dedupe on
         revision, and ignore anything this tab has already seen or written. */
      if (event.revision <= (s.prefs?.revision ?? 0)) return;
      void reloadPrefs(s);
      return;
    }
    case 'space.style_default.updated': {
      const prior = s.defaults.get(event.spaceId);
      if (prior && event.revision <= prior.revision) return;
      s.defaults.set(event.spaceId, {
        spaceId: event.spaceId,
        defaultStyle: event.defaultStyle,
        setBy: prior?.setBy ?? null,
        revision: event.revision,
        updatedAt: event.occurredAt,
      });
      fetchMissing(s);
      scheduleCommit(s);
      return;
    }
    default:
      return;
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export interface StyleSyncOptions {
  spaceId: string | null;
  viewerMemberId: string | null;
}

/**
 * Start syncing for a signed-in shell. One at a time: a second start stops the
 * first. Returns the stop function.
 */
export function startStyleSync(seam: StyleSyncSeam, options: StyleSyncOptions): () => void {
  stopStyleSync();
  const s: SyncState = {
    seam,
    spaceId: options.spaceId,
    viewerMemberId: options.viewerMemberId,
    prefs: undefined,
    defaults: new Map(),
    known: new Map(),
    inflight: new Set(),
    frame: null,
    alive: true,
  };
  sync = s;
  const offEvent = seam.onEvent((event) => onEvent(s, event));
  const offResync = seam.onResync((spaceId) => {
    /* Catch-up lost: anything may have changed. Re-read the row, this space's
       default, and every style in play. */
    s.known.clear();
    void Promise.all([reloadPrefs(s), spaceId === s.spaceId ? loadDefault(s, spaceId) : null]).then(() => {
      fetchMissing(s);
      scheduleCommit(s);
    });
  });
  const offWriter = registerThemeWriter((theme: Theme) => {
    void chooseStyle(theme === 'dark' ? BUILTIN_STYLE_IDS.dark : BUILTIN_STYLE_IDS.light).catch(() => {});
  });
  void boot(s);
  const stop = (): void => {
    s.alive = false;
    offEvent();
    offResync();
    offWriter();
    if (sync === s) sync = null;
  };
  stopper = stop;
  return stop;
}

export function stopStyleSync(): void {
  stopper?.();
  stopper = null;
}

/** The shell moved to another space (or learned the viewer's member id there). */
export function setStyleSyncSpace(spaceId: string | null, viewerMemberId: string | null): void {
  const s = sync;
  if (!s) return;
  const moved = s.spaceId !== spaceId;
  s.spaceId = spaceId;
  s.viewerMemberId = viewerMemberId;
  if (moved && spaceId && !s.defaults.has(spaceId)) {
    void loadDefault(s, spaceId).then(() => {
      fetchMissing(s);
      scheduleCommit(s);
    });
  } else {
    scheduleCommit(s);
  }
}

/** Re-render the picker when a style event or commit lands. */
export function subscribeStyleCatalog(listener: CatalogListener): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

/** A write outside the sync layer (the editor's save, push, pull, delete): lists re-read. */
export function notifyStyleCatalogChanged(): void {
  for (const listener of [...catalogListeners]) listener();
}

// ── writes ──────────────────────────────────────────────────────────────────

/** True when choices are recorded on the server (signed in, styles-aware node). */
export function stylePrefsWritable(): boolean {
  return !!sync && sync.prefs !== undefined && !!sync.seam.setStylePrefs;
}

/** The viewer's prefs row as this tab knows it (`undefined`: unknown). */
export function knownStylePrefs(): StylePrefsView | null | undefined {
  return sync?.prefs;
}

/** The current space's default (`undefined`: unknown). */
export function knownSpaceDefault(): SpaceStyleDefaultView | undefined {
  return sync?.spaceId ? sync.defaults.get(sync.spaceId) : undefined;
}

type PrefsPatch = Omit<StylePrefsSetInput, 'clientMutationId' | 'expectedRevision'>;

/**
 * Write the prefs row with `expectedRevision`. On a conflict, re-read and
 * apply the same intent once more against the fresh revision; on any other
 * refusal, re-read (which repaints the truth) and rethrow.
 */
async function writePrefs(s: SyncState, patch: (base: StyleSelection) => PrefsPatch): Promise<void> {
  const set = s.seam.setStylePrefs;
  if (!set) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = currentSelection();
    try {
      const result = await set({ ...patch(base), expectedRevision: s.prefs?.revision ?? 0 });
      adoptPrefs(s, result.prefs);
      return;
    } catch (error) {
      if (errorCode(error) === 'version_conflict' && attempt === 0) {
        await reloadPrefs(s);
        continue;
      }
      await reloadPrefs(s);
      scheduleCommit(s);
      throw error;
    }
  }
}

function pairPatch(base: StyleSelection): PrefsPatch {
  return { currentStyle: base.current.ref, darkStyle: base.dark?.ref ?? null, followOs: base.followOs };
}

async function docFor(s: SyncState | null, ref: string): Promise<KnownStyle | null> {
  if (parseStyleRef(ref)?.kind === 'builtin') return null;
  if (!s) return null;
  const known = s.known.get(ref);
  if (known?.doc && known.status === 'live') return known;
  return readStyle(s, ref);
}

export interface ChooseStyleOptions {
  /** Opt in to a space style's custom css (§6.8 item 3). */
  trustCss?: boolean;
}

/**
 * USE `ref` (spec §1.4, §9.1): paint it now, then record it. Rejects when the
 * style cannot be read or the server refuses; the painted style is then the
 * server's truth again.
 */
export async function chooseStyle(ref: StyleRef, options: ChooseStyleOptions = {}): Promise<void> {
  const s = sync;
  const known = await docFor(s, ref);
  const parsed = parseStyleRef(ref);
  if (!parsed) throw new Error(`not a style reference: ${ref}`);
  if (parsed.kind !== 'builtin' && !known?.doc) throw new Error('That style is not readable any more.');
  const trusted = options.trustCss || (s ? trustFor(s, ref, known ?? undefined) : parsed.kind !== 'space');
  selectStyle(ref, known?.doc, { trustCss: trusted, title: known?.title ?? null });
  if (!s || !stylePrefsWritable()) return;
  const trustAdd = options.trustCss && parsed.kind === 'space' ? { trustedCss: { add: [parsed.id] } } : {};
  await writePrefs(s, (base) => ({ ...pairPatch(base), currentStyle: ref, followOs: false, ...trustAdd }));
}

/**
 * Follow the OS: paint `darkRef` (default: the current dark half, else Atelier
 * Dark) while the OS is dark. Off: the current style everywhere.
 */
export async function setStyleFollowOs(on: boolean, darkRef?: StyleRef): Promise<void> {
  const s = sync;
  const base = currentSelection();
  let dark = base.dark;
  if (on) {
    const ref = darkRef ?? base.dark?.ref ?? BUILTIN_STYLE_IDS.dark;
    const known = await docFor(s, ref);
    dark = entryFor(ref, known?.doc, { title: known?.title ?? null, trustCss: s ? trustFor(s, ref, known ?? undefined) : true });
    if (!dark) throw new Error('That style is not readable any more.');
  }
  applySelection({ ...base, dark, followOs: on, source: base.source === 'os' ? 'local' : base.source });
  if (!s || !stylePrefsWritable()) return;
  await writePrefs(s, (next) => ({ ...pairPatch(next), followOs: on, darkStyle: on ? dark?.ref ?? null : next.dark?.ref ?? null }));
}

/** Allow or revoke a space style's custom css for this viewer (§6.8 item 3). */
export async function setStyleCssTrust(styleId: string, trusted: boolean): Promise<void> {
  const s = sync;
  if (!s || !stylePrefsWritable()) return;
  await writePrefs(s, (base) => ({
    ...pairPatch(base),
    trustedCss: trusted ? { add: [styleId] } : { remove: [styleId] },
  }));
}

/** True when `ref` is the viewer's current style or follow-OS dark style. */
export function isStyleInUse(ref: string): boolean {
  const { current, dark, followOs } = getStyleState();
  return current.ref === ref || (followOs && dark?.ref === ref);
}

/** The status the tab holds for `ref` (`removed` / `detached` drive picker labels). */
export function knownStyleStatus(ref: string): StyleEntryStatus | null {
  return sync?.known.get(ref)?.status ?? null;
}

/** TEST SEAM: stop and forget everything. */
export function __resetStyleSyncForTests(): void {
  stopStyleSync();
  catalogListeners.clear();
}
