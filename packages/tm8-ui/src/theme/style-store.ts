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
  resolveStyle,
  styleDocForBuiltin,
  styleSheetText,
  type BuiltinStyleId,
  type ResolvedStyle,
  type StyleDoc,
} from '@tm8/contract';

/** The id of the sheet `apply()` owns. Nothing else may write to it. */
export const ACTIVE_STYLE_ELEMENT_ID = 'tm8-style-active';

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
  /** What is painted right now. */
  active: ResolvedStyle;
  /** The document `active` resolved from, so a later phase can edit it. */
  doc: StyleDoc;
  /** True while no explicit choice has been made and the OS is in charge. */
  followOs: boolean;
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

function resolveBuiltin(theme: Theme): { doc: StyleDoc; active: ResolvedStyle } {
  const doc = styleDocForBuiltin(builtinFor(theme));
  return { doc, active: resolveStyle(doc, BUILTIN_STYLES) };
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
  const { doc, active } = resolveBuiltin(theme);
  return { active, doc, followOs: stored === null };
}

let state: StyleState = initialState();

/** The last text written to the sheet, so an identical apply is a no-op. */
let appliedHash: string | null = null;

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById(ACTIVE_STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const el = document.createElement('style');
  el.id = ACTIVE_STYLE_ELEMENT_ID;
  /* APPENDED TO HEAD, LAST. Vite injects `tokens.css` and `canvas-extra.css`
     into head too, and at equal specificity the later rule wins — so "last"
     is not tidiness, it is the whole mechanism. In a production build the CSS
     is a <link> in the document's own head, which is also earlier than this. */
  document.head.appendChild(el);
  return el;
}

/**
 * Write the resolved style to the DOM. Idempotent on `hash`, so a redundant
 * call costs one string comparison rather than a style recalculation.
 */
function paint(resolved: ResolvedStyle): void {
  const el = styleElement();
  if (!el) return;
  if (appliedHash === resolved.hash && el.textContent) return;
  el.textContent = styleSheetText(resolved);
  appliedHash = resolved.hash;
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
  paint(state.active);
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
  paint(next.active);
  for (const listener of [...listeners]) listener(next);
}

/**
 * The derived `data-theme` value (§3.2) — `luminance(paper) < 0.5`, not a
 * stored string. For the two built-ins it is exactly the old answer, which is
 * what makes phase 1 invisible; for a user style it is the only answer that
 * can be right, because the component rules keyed on `data-theme` are asking
 * "is the paper dark" and nothing else.
 */
export function derivedTheme(): Theme {
  return state.active.darkish ? 'dark' : 'light';
}

/** An explicit choice. Stops OS following, exactly as before. */
export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(LEGACY_THEME_KEY, theme);
  } catch {
    /* As above: the choice applies now even if it cannot be remembered. */
  }
  const { doc, active } = resolveBuiltin(theme);
  setState({ active, doc, followOs: false });
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
    const { doc, active } = resolveBuiltin(query.matches ? 'dark' : 'light');
    setState({ active, doc, followOs: true });
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
  state = initialState();
}
