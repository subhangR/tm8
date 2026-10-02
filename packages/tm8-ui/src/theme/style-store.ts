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
 * PHASE 1 IS DELIBERATELY NOT PERSISTENT BEYOND THE LEGACY KEY. There is no
 * `style` entity, no server pointer and no picker yet (§13 phase 2). The store
 * therefore has exactly two reachable states — the two built-ins — and
 * `useTheme` keeps its old API over the top of them, so nothing that compiles
 * today has to change. Every seam a later phase needs (a document rather than a
 * builtin id, a subscriber list, an idempotent `apply`) is already here, because
 * retrofitting the subscriber list is the part that would touch every caller.
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
 * LEGACY KEY, read and still written (§6). `'light' | 'dark'` is what every
 * installed client has in its storage right now, and phase 1 must not strand
 * them: a viewer who chose dark yesterday gets dark today, with no migration
 * step and no flash. It is still WRITTEN as well as read so that a rollback to
 * the pre-style bundle does not lose the choice either — the cheapest possible
 * answer to "what if we have to revert", and it costs one `setItem`.
 */
const LEGACY_THEME_KEY = 'tm8ui.theme';

export type Theme = 'light' | 'dark';

export interface StyleState {
  /** Which style is current: a built-in, personal or space ref. */
  ref: StyleRef;
  /** What is painted right now. */
  active: ResolvedStyle;
  /** The document `active` resolved from, so a later phase can edit it. */
  doc: StyleDoc;
  /** True while no explicit choice has been made and the OS is in charge. */
  followOs: boolean;
  /** Whether the style's extra css runs for this viewer (spec §6.8). */
  trustCss: boolean;
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

function builtinFor(theme: Theme): BuiltinStyleId {
  return theme === 'dark' ? BUILTIN_STYLE_IDS.dark : BUILTIN_STYLE_IDS.light;
}

function resolveDoc(doc: StyleDoc): ResolvedStyle {
  return resolveStyle(doc, BUILTIN_STYLES, STYLE_REGISTRY);
}

function builtinState(id: BuiltinStyleId, followOs: boolean): StyleState {
  const doc = styleDocForBuiltin(id);
  return { ref: id, doc, active: resolveDoc(doc), followOs, trustCss: true };
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
 */
function initialState(): StyleState {
  const stored = storedTheme();
  const theme: Theme = stored ?? (osPrefersDark() ? 'dark' : 'light');
  return builtinState(builtinFor(theme), stored === null);
}

let state: StyleState = initialState();

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
  for (const listener of [...listeners]) listener(next);
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
}

/**
 * USE a style (spec §1.4 "use"): make `ref` current, live. An explicit choice,
 * so OS following stops.
 *
 * A built-in resolves from the shipped JSON. A personal or space style needs
 * its document passed in — fetching it is the persistence layer's job
 * (Phase 2), and the store stays a pure painter. Returns false, changing
 * nothing, when the ref is malformed or a non-built-in arrives without a doc.
 *
 * Named `selectStyle`, not `use`: a bare `use` collides with React's `use`
 * and the hooks lint treats every `use*` call as a hook.
 */
export function selectStyle(ref: StyleRef, doc?: StyleDoc, options: SelectStyleOptions = {}): boolean {
  const parsed = parseStyleRef(ref);
  if (!parsed) return false;
  const canonical = formatStyleRef(parsed);
  if (parsed.kind === 'builtin' && !doc) {
    if (!(canonical in BUILTIN_STYLES)) return false;
    setState(builtinState(canonical as BuiltinStyleId, false));
    return true;
  }
  if (!doc) return false;
  setState({
    ref: canonical,
    doc,
    active: resolveDoc(doc),
    followOs: false,
    trustCss: options.trustCss ?? parsed.kind !== 'space',
  });
  return true;
}

/**
 * LEGACY SURFACE: an explicit light/dark choice. Writes the legacy key (so the
 * choice survives reloads and a rollback to the pre-style bundle) and USES
 * the matching built-in.
 */
export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(LEGACY_THEME_KEY, theme);
  } catch {
    /* As above: the choice applies now even if it cannot be remembered. */
  }
  selectStyle(builtinFor(theme));
}

/**
 * Follow `prefers-color-scheme` while the viewer has expressed no preference.
 * Returns an unsubscribe, so the caller owns the listener's lifetime.
 */
export function watchOsTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (!state.followOs) return;
    setState(builtinState(builtinFor(query.matches ? 'dark' : 'light'), true));
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
  document.getElementById(ACTIVE_STYLE_ELEMENT_ID)?.remove();
  document.getElementById(EXTRA_STYLE_ELEMENT_ID)?.remove();
  state = initialState();
}
