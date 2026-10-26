/**
 * The shipped foundations (§2.2, §11).
 *
 * NOT DATABASE ROWS, deliberately: they must exist before any space does, they
 * must be identical on every server, and a deploy that changes Atelier must
 * change them everywhere at once. A row cannot promise any of that.
 *
 * THE JSON IS GENERATED, NEVER HAND-EDITED. `packages/tm8-ui/scripts/extract-builtins.mjs`
 * writes it from `styles/tokens.css` + `styles/canvas-extra.css`, and
 * `packages/tm8-ui/src/styles/builtins-parity.test.ts` fails if the two ever
 * disagree. Editing a value here instead of in the CSS makes the palette and
 * the token file two different palettes, which renders fine and is wrong.
 *
 * `with { type: 'json' }` is required by this package's `NodeNext` module mode
 * and is understood by tsc (which copies the JSON into `dist/`), vitest and
 * vite — all three were verified before this shape was chosen over a generated
 * `.ts` literal.
 */
import atelierLight from './atelier-light.json' with { type: 'json' };
import atelierDark from './atelier-dark.json' with { type: 'json' };
import chatgptLight from './chatgpt-light.json' with { type: 'json' };
import chatgptDark from './chatgpt-dark.json' with { type: 'json' };

import type { BuiltinStyle, BuiltinStyleId } from '../style.js';

/* The JSON's inferred type is structurally right but nominally wide (`string`
   where the contract wants a `builtin:` template literal). One cast at the
   boundary, named, beats widening the contract's own types to fit a loader. */
export const ATELIER_LIGHT = atelierLight as unknown as BuiltinStyle;
export const ATELIER_DARK = atelierDark as unknown as BuiltinStyle;
export const CHATGPT_LIGHT = chatgptLight as unknown as BuiltinStyle;
export const CHATGPT_DARK = chatgptDark as unknown as BuiltinStyle;

/**
 * THE DEFAULT PAIR — what "light" and "dark" mean for a viewer who has not
 * chosen a style, for the light/dark toggle, and for the server's default
 * prefs. ChatGPT since 2026-10-14 (user ruling); Atelier before that.
 */
export const BUILTIN_STYLE_IDS = {
  light: 'builtin:chatgpt-light',
  dark: 'builtin:chatgpt-dark',
} as const satisfies Record<string, BuiltinStyleId>;

/**
 * THE RETIRED PAIR. Atelier stays BUNDLED — personal and space styles name it
 * as their foundation, and those must keep resolving — but it is no longer
 * offered as a choice. A stored `builtin:atelier-*` preference was written
 * when Atelier was the only built-in, so it meant "light" or "dark", not
 * "Atelier"; `RETIRED_BUILTIN_ALIASES` is how a client reads it that way.
 */
export const ATELIER_STYLE_IDS = {
  light: 'builtin:atelier-light',
  dark: 'builtin:atelier-dark',
} as const satisfies Record<string, BuiltinStyleId>;

export const RETIRED_BUILTIN_ALIASES: Readonly<Record<string, BuiltinStyleId>> = {
  [ATELIER_STYLE_IDS.light]: BUILTIN_STYLE_IDS.light,
  [ATELIER_STYLE_IDS.dark]: BUILTIN_STYLE_IDS.dark,
};

/** Keyed by id, which is the shape `resolveStyle(doc, builtins)` wants. */
export const BUILTIN_STYLES: Readonly<Record<string, BuiltinStyle>> = {
  [ATELIER_LIGHT.id]: ATELIER_LIGHT,
  [ATELIER_DARK.id]: ATELIER_DARK,
  [CHATGPT_LIGHT.id]: CHATGPT_LIGHT,
  [CHATGPT_DARK.id]: CHATGPT_DARK,
};

/** The built-ins a picker offers: every bundled one except the retired pair. */
export const OFFERED_BUILTIN_STYLES: readonly BuiltinStyle[] = Object.values(BUILTIN_STYLES).filter(
  (b) => !(b.id in RETIRED_BUILTIN_ALIASES),
);

/**
 * The default foundation for a viewer with no stored preference and no OS
 * signal. Light, matching `theme/useTheme.ts`'s pre-style default — changing it
 * here would change first paint for every new viewer, which is a product
 * decision and not a refactor (the 2026-10-14 move to ChatGPT was one).
 */
export const DEFAULT_BUILTIN_STYLE_ID: BuiltinStyleId = BUILTIN_STYLE_IDS.light;
