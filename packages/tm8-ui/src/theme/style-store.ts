/**
 * THE STYLE STORE — one resolved style, one injected stylesheet, one subscriber
 * list (design §5).
 *
 * WHAT THIS REPLACES. `useTheme.ts` held a `'light' | 'dark'` in React state
 * and the token swap happened entirely in CSS, through `data-theme` on the
 * roots. That works for exactly two palettes and nothing else, and `data-theme`
 * being the SWITCH is what made "always dark" have to spell itself
 * `data-theme="dark"` — a nested lie about the theme, which is why
 * `AlwaysDark`'s comment is three paragraphs long.
 *
 * WHAT IT IS INSTEAD. One `<style id="tm8-style-active">` in `document.head`
 * carrying the full token table (§3.1). `data-theme` survives as a DERIVED
 * attribute (§3.2) because a dozen component rules key on it, but it no longer
 * decides any token's value — the sheet does, and it wins because it is injected
 * after `tokens.css` at equal specificity. See `styleSheetText` in
 * `@tm8/contract` for the specificity argument; it is load-bearing and it is
 * written down there rather than here because the CLI emits the same bytes.
 *
 * A PAIR, NOT ONE STYLE (spec v8 §3.4, §3.6). The viewer's preference is a
 * CURRENT style plus an optional DARK style used while `followOs` is on and
 * the OS is dark. The painted style is derived from that pair and the OS, so
 * "follow the OS until you choose" is the same mechanism as "use Midnight when
 * dark" — a viewer with nothing stored is simply `{atelier-light, atelier-dark,
 * followOs}` and paints exactly what phase 1 painted.
 *
 * THE STORE IS STILL A PAINTER. Where the pair comes from — the server's prefs,
 * the space default, a legacy key — is `style-sync.ts`'s job. The store only
 * holds the documents, paints the active one, and remembers the pair in
 * `localStorage['tm8ui.style']` (spec §10.1) so the NEXT boot paints it before
 * any network answer.
 *
 * NOT A REACT STORE. `apply()` writes one string into a stylesheet; the browser
 * recalculates custom properties on the affected roots with no React involved.
 * Re-rendering the tree to change a colour would be the slowest possible way to
 * do it and would remount every terminal on a theme flip, which §5.1 exists to
 * prevent.
 */
import {
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  STYLE_REGISTRY,
  StyleDocSchema,
  formatStyleRef,
  parseStyleRef,
  resolveStyle,
  styleDocForBuiltin,
  styleSheetText,
  type BuiltinStyleId,
  type ResolvedStyle,
  type StyleDoc,
  type StyleRef,
} from '@tm8/contract';

/** The id of the sheet `apply()` owns. Nothing else may write to it. */
export const ACTIVE_STYLE_ELEMENT_ID = 'tm8-style-active';

/** The sheet for a style's sanitised extra `css`, after the vars sheet (spec §1.6). */
export const EXTRA_STYLE_ELEMENT_ID = 'tm8-style-extra';

/**
 * LEGACY KEY (spec §10.1). `'light' | 'dark'` is what every installed client
 * has in its storage. Read at boot when the new cache is absent, migrated to
 * the server's prefs on the first authenticated boot (`style-sync.ts`) and then
 * deleted. Signed-out surfaces with no server to write to still write it, so a
 * choice made on the sign-in screen survives into the first signed-in boot.
 */
export const LEGACY_THEME_KEY = 'tm8ui.theme';

/**
 * THE BOOT CACHE (spec §10.1): `{docs, hash, followOs, revision}`, written on
 * every apply and read synchronously before first paint. `docs` holds the
 * whole pair so an OS flip before the network answers still has the dark half.
 */
export const STYLE_CACHE_KEY = 'tm8ui.style';

export type Theme = 'light' | 'dark';

/**
 * Where the pair came from. `os`: nothing chosen anywhere (follow the OS
 * between the two built-ins). `local`: chosen on this device without a
 * server to record it. `prefs`: the server's `identity_style_prefs` row.
 * `default`: no prefs row, the space default applies (§3.6).
 */
export type StyleSource = 'os' | 'local' | 'prefs' | 'default';

/**
 * Whether the entry's document is the live one (`live`), the prefs snapshot
 * because the style is no longer readable (`detached`: a personal style that
 * was deleted, a space this viewer left), or a space style an admin removed
 * (`removed`). The picker labels the last two (§3.6, §9.1).
 */
export type StyleEntryStatus = 'live' | 'detached' | 'removed';

export interface StyleEntry {
  ref: StyleRef;
  doc: StyleDoc;
  /** Display title when known (built-ins, prefs snapshot, the style row). */
  title: string | null;
  /** Whether the style's extra css runs for this viewer (spec §6.8). */
  trustCss: boolean;
  status: StyleEntryStatus;
}

export interface StyleState {
  /** Which style is painted: a built-in, personal or space ref. */
  ref: StyleRef;
  /** What is painted right now. */
  active: ResolvedStyle;
  /** The document `active` resolved from. */
  doc: StyleDoc;
  /** True while the OS decides between `current` and `dark`. */
  followOs: boolean;
  /** Whether the PAINTED style's extra css runs (spec §6.8). */
  trustCss: boolean;
  /** The preference pair the painted style is derived from. */
  current: StyleEntry;
  dark: StyleEntry | null;
  /** `identity_style_prefs.revision` this pair reflects; 0 when there is no row. */
  revision: number;
  source: StyleSource;
}

/** The inputs a state is derived from — everything except what is painted. */
export interface StyleSelection {
  current: StyleEntry;
  dark: StyleEntry | null;
  followOs: boolean;
  revision: number;
  source: StyleSource;
}

type Listener = (state: StyleState) => void;

const listeners = new Set<Listener>();

function osPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function storedTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    /* Private mode / blocked storage. Not fatal: the session still themes, it
       just cannot remember. Never let storage take the shell down — the same
       rule `useTheme.ts` already held. */
    return null;
  }
}

/** Read the legacy key (for the one-time migration in `style-sync.ts`). */
export function readLegacyTheme(): Theme | null {
  return storedTheme();
}

/** Delete the legacy key once the server holds the choice (spec §10.1). */
export function clearLegacyTheme(): void {
  try {
    window.localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    /* As above. */
  }
}

function builtinFor(theme: Theme): BuiltinStyleId {
  return theme === 'dark' ? BUILTIN_STYLE_IDS.dark : BUILTIN_STYLE_IDS.light;
}

function resolveDoc(doc: StyleDoc): ResolvedStyle {
  return resolveStyle(doc, BUILTIN_STYLES, STYLE_REGISTRY);
}

/** A built-in as a pair entry. `null` for a slug this bundle does not ship. */
export function builtinEntry(id: StyleRef): StyleEntry | null {
  const builtin = BUILTIN_STYLES[id];
  if (!builtin) return null;
  return { ref: builtin.id, doc: styleDocForBuiltin(builtin.id), title: builtin.title, trustCss: true, status: 'live' };
}

function lightEntry(): StyleEntry {
  return builtinEntry(BUILTIN_STYLE_IDS.light)!;
}

function darkEntry(): StyleEntry {
  return builtinEntry(BUILTIN_STYLE_IDS.dark)!;
}

/** Nothing chosen anywhere: follow the OS between the two built-ins (§10.1 row 2). */
export function osSelection(): StyleSelection {
  return { current: lightEntry(), dark: darkEntry(), followOs: true, revision: 0, source: 'os' };
}

function themeSelection(theme: Theme, source: StyleSource): StyleSelection {
  return { current: theme === 'dark' ? darkEntry() : lightEntry(), dark: null, followOs: false, revision: 0, source };
}

/** The entry the OS picks from a selection right now. */
function activeEntry(selection: StyleSelection): StyleEntry {
  return selection.followOs && selection.dark && osPrefersDark() ? selection.dark : selection.current;
}

function deriveState(selection: StyleSelection): StyleState {
  const entry = activeEntry(selection);
  return {
    ...selection,
    ref: entry.ref,
    doc: entry.doc,
    active: resolveDoc(entry.doc),
    trustCss: entry.trustCss,
  };
}

// ── the boot cache ──────────────────────────────────────────────────────────

interface CachedEntry {
  ref: string;
  doc: unknown;
  title?: string | null;
  trustCss?: boolean;
  status?: StyleEntryStatus;
}

interface StyleCache {
  docs: { current: CachedEntry; dark: CachedEntry | null };
  hash: string;
  followOs: boolean;
  revision: number;
  source?: StyleSource;
}

function entryFromCache(cached: CachedEntry | null | undefined): StyleEntry | null {
  if (!cached || typeof cached.ref !== 'string') return null;
  const parsed = parseStyleRef(cached.ref);
  if (!parsed) return null;
  /* A cached document is UNTRUSTED storage — another bundle wrote it, or a
     person with devtools did. It goes through the same schema the server
     validates with, and `resolveStyle` re-checks every value and re-sanitises
     the css before anything reaches the DOM (§8). */
  const doc = StyleDocSchema.safeParse(cached.doc);
  if (!doc.success) return parsed.kind === 'builtin' ? builtinEntry(cached.ref as StyleRef) : null;
  const status = cached.status === 'detached' || cached.status === 'removed' ? cached.status : 'live';
  return {
    ref: formatStyleRef(parsed),
    doc: doc.data,
    title: typeof cached.title === 'string' ? cached.title : null,
    trustCss: cached.trustCss === true,
    status,
  };
}

function readCache(): StyleSelection | null {
  try {
    const raw = window.localStorage.getItem(STYLE_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Partial<StyleCache> | null;
    if (!cache || typeof cache !== 'object' || !cache.docs) return null;
    const current = entryFromCache(cache.docs.current);
    if (!current) return null;
    const source: StyleSource =
      cache.source === 'os' || cache.source === 'local' || cache.source === 'prefs' || cache.source === 'default'
        ? cache.source
        : 'local';
    return {
      current,
      dark: entryFromCache(cache.docs.dark),
      followOs: cache.followOs === true,
      revision: typeof cache.revision === 'number' && cache.revision >= 0 ? cache.revision : 0,
      source,
    };
  } catch {
    return null;
  }
}

function cachedEntry(entry: StyleEntry): CachedEntry {
  return { ref: entry.ref, doc: entry.doc, title: entry.title, trustCss: entry.trustCss, status: entry.status };
}

function writeCache(next: StyleState): void {
  const cache: StyleCache = {
    docs: { current: cachedEntry(next.current), dark: next.dark ? cachedEntry(next.dark) : null },
    hash: next.active.hash,
    followOs: next.followOs,
    revision: next.revision,
    source: next.source,
  };
  try {
    window.localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* Quota or blocked storage: the style still applies, the next boot just
       starts from the legacy key or the OS. */
  }
}

/** Forget the cache (sign-out: the next person on this device is not this one). */
export function clearStyleCache(): void {
  try {
    window.localStorage.removeItem(STYLE_CACHE_KEY);
  } catch {
    /* As above. */
  }
}

/**
 * THE INITIAL STATE IS COMPUTED IN A MODULE INITIALISER, not in an effect.
 *
 * `useTheme.ts:54-62` already made this call and its comment is the reason:
 * resolving in an effect renders light, then flips, which is a visible flash for
 * every dark-mode viewer on every load. The style store has to be even earlier
 * than that hook was — the sheet must exist before the FIRST paint, not before
 * the first render — which is why `installActiveStyle()` is called from
 * `main.tsx` above `createRoot`.
 *
 * Order (spec §1.6): the `tm8ui.style` cache, else the legacy key, else the
 * OS between the two built-ins.
 */
function initialSelection(): StyleSelection {
  const cached = readCache();
  if (cached) return cached;
  const stored = storedTheme();
  return stored ? themeSelection(stored, 'local') : osSelection();
}

let state: StyleState = deriveState(initialSelection());

/** The last text written to the sheet, so an identical apply is a no-op. */
let appliedHash: string | null = null;

/**
 * The sheet element with `id`, created on first use and APPENDED TO HEAD,
 * LAST. Vite injects `tokens.css` and `canvas-extra.css` into head too, and at
 * equal specificity the later rule wins — so "last" is not tidiness, it is the
 * whole mechanism. In a production build the CSS is a <link> in the
 * document's own head, which is also earlier than this. The extra-css element
 * is created after the vars element, so a style's own rules come after its
 * variables (spec §1.6).
 */
function sheetElement(id: string): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  const el = document.createElement('style');
  el.id = id;
  document.head.appendChild(el);
  return el;
}

/**
 * Write the resolved style to the DOM. Idempotent on `hash`, so a redundant
 * call costs one string comparison rather than a style recalculation.
 */
function paint(resolved: ResolvedStyle, trustCss: boolean): void {
  const vars = sheetElement(ACTIVE_STYLE_ELEMENT_ID);
  if (!vars) return;
  const key = `${resolved.hash}|${trustCss}`;
  if (appliedHash === key && vars.textContent) return;
  vars.textContent = styleSheetText(resolved);
  /* `resolved.css` was already sanitised by `resolveStyle` in THIS client —
     a stored string is never injected as-is (§8.3). It only runs when this
     viewer trusts it: always for their own styles, opt-in for space styles. */
  const css = trustCss ? resolved.css : null;
  if (css) {
    sheetElement(EXTRA_STYLE_ELEMENT_ID)!.textContent = css;
  } else {
    document.getElementById(EXTRA_STYLE_ELEMENT_ID)?.remove();
  }
  appliedHash = key;
}

/**
 * Install the sheet. Call once, before first render.
 *
 * Separate from the module initialiser on purpose: importing a module must not
 * have a DOM side effect, or the unit suite gets a stylesheet it never asked for
 * and the import ORDER of two unrelated files starts deciding whether a test
 * sees tokens.
 */
export function installActiveStyle(): void {
  paint(state.active, state.trustCss);
}

export function getStyleState(): StyleState {
  return state;
}

export function subscribeStyle(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: StyleState): void {
  state = next;
  paint(next.active, next.trustCss);
  writeCache(next);
  for (const listener of [...listeners]) listener(next);
}

/**
 * Replace the whole preference pair (the sync layer's one write). Re-derives
 * the painted style from the pair and the OS; an unchanged result repaints
 * nothing (`paint` is idempotent on hash).
 */
export function applySelection(selection: StyleSelection): void {
  setState(deriveState(selection));
}

/** The pair the current state was derived from. */
export function currentSelection(): StyleSelection {
  const { current, dark, followOs, revision, source } = state;
  return { current, dark, followOs, revision, source };
}

/**
 * The derived `data-theme` value — `luminance(paper) < 0.5`, not a stored
 * string. For the two built-ins it is exactly the old answer; for a user
 * style it is the only answer that can be right, because the component rules
 * keyed on `data-theme` are asking "is the paper dark" and nothing else.
 */
export function derivedTheme(): Theme {
  return state.active.darkish ? 'dark' : 'light';
}

export interface SelectStyleOptions {
  /**
   * Run the style's extra `css`. Defaults to true for built-ins and personal
   * styles (the viewer's own) and false for space styles, whose css runs for
   * other viewers only after a per-viewer opt-in (spec §6.8).
   */
  trustCss?: boolean;
  /** Display title for the picker; built-ins carry their own. */
  title?: string | null;
}

/**
 * The entry `selectStyle` would make current, or null when the ref is
 * malformed or a non-built-in arrives without a doc.
 */
export function entryFor(ref: StyleRef, doc?: StyleDoc, options: SelectStyleOptions = {}): StyleEntry | null {
  const parsed = parseStyleRef(ref);
  if (!parsed) return null;
  const canonical = formatStyleRef(parsed);
  /* Prefix tests on the canonical ref, not `parsed.kind` against a literal
     (phase 1b's convention). */
  if (canonical.startsWith('builtin:') && !doc) return builtinEntry(canonical);
  if (!doc) return null;
  return {
    ref: canonical,
    doc,
    title: options.title ?? BUILTIN_STYLES[canonical]?.title ?? null,
    trustCss: options.trustCss ?? !canonical.startsWith('space:'),
    status: 'live',
  };
}

/**
 * USE a style LOCALLY (spec §1.4 "use"): make `ref` current, painted now. An
 * explicit choice, so OS following stops.
 *
 * A built-in resolves from the shipped JSON. A personal or space style needs
 * its document passed in. Returns false, changing nothing, when the ref is
 * malformed or a non-built-in arrives without a doc. Recording the choice on
 * the server is `style-sync.ts`'s `chooseStyle`, which calls this first.
 *
 * Named `selectStyle`, not `use`: a bare `use` collides with React's `use`
 * and the hooks lint treats every `use*` call as a hook.
 */
export function selectStyle(ref: StyleRef, doc?: StyleDoc, options: SelectStyleOptions = {}): boolean {
  const entry = entryFor(ref, doc, options);
  if (!entry) return false;
  const prev = state;
  applySelection({
    current: entry,
    dark: prev.dark,
    followOs: false,
    revision: prev.revision,
    source: prev.source === 'prefs' ? 'prefs' : 'local',
  });
  return true;
}

/**
 * THE PERSISTENCE HOOK. While a signed-in shell is mounted, `style-sync.ts`
 * registers its writer here, and the legacy `setTheme` routes through it so a
 * light/dark press is recorded in the server's prefs rather than in the legacy
 * key. With nothing registered (the sign-in screen) the legacy path runs.
 */
type ThemeWriter = (theme: Theme) => void;
let themeWriter: ThemeWriter | null = null;

export function registerThemeWriter(writer: ThemeWriter): () => void {
  themeWriter = writer;
  return () => {
    if (themeWriter === writer) themeWriter = null;
  };
}

/**
 * LEGACY SURFACE: an explicit light/dark choice, USING the matching built-in.
 * Signed in, the sync layer records it; signed out, the legacy key does.
 */
export function setTheme(theme: Theme): void {
  if (themeWriter) {
    themeWriter(theme);
    return;
  }
  try {
    window.localStorage.setItem(LEGACY_THEME_KEY, theme);
  } catch {
    /* As above: the choice applies now even if it cannot be remembered. */
  }
  selectStyle(builtinFor(theme));
}

/**
 * Re-derive the painted half when `prefers-color-scheme` changes, while the
 * selection follows the OS. Returns an unsubscribe, so the caller owns the
 * listener's lifetime.
 */
export function watchOsTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (!state.followOs) return;
    applySelection(currentSelection());
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * TEST SEAM. The store is a module singleton — which is correct for a thing the
 * document has exactly one of, and awkward for a suite that wants a fresh one.
 * Exported rather than worked around with module mocking, because a test that
 * re-imports the module gets a second sheet and then measures the wrong one.
 */
export function __resetStyleStoreForTests(): void {
  appliedHash = null;
  listeners.clear();
  themeWriter = null;
  document.getElementById(ACTIVE_STYLE_ELEMENT_ID)?.remove();
  document.getElementById(EXTRA_STYLE_ELEMENT_ID)?.remove();
  state = deriveState(initialSelection());
}
