/**
 * extract-builtins — turn `styles/tokens.css` + `styles/canvas-extra.css` into
 * the two built-in style documents the resolver uses as foundations (§11).
 *
 * WHY A SCRIPT AND NOT A HAND-WRITTEN JSON FILE. `tokens.css` is a
 * byte-verbatim transplant guarded by `styles/tokens-verbatim.test.ts`: it is
 * the SOURCE OF TRUTH for the palette and it cannot be edited casually. A
 * hand-maintained copy of ~130 values would be a second palette the moment
 * anybody touched either one, and the drift would be invisible — every surface
 * would still render, just from the wrong table. So the table is EXTRACTED, and
 * `styles/builtins-parity.test.ts` re-runs this extraction in memory and fails
 * if the committed JSON no longer matches. Same "move both in one commit"
 * discipline the verbatim guard already uses, for the same reason.
 *
 * WHAT IS EXTRACTED, exactly:
 *   - light = every `--pn-*` declared in the `.cv2-root` block of BOTH files.
 *   - dark  = that table, with the `[data-theme='dark']` block of BOTH files
 *             applied over it. This is the inheritance the browser performs
 *             today, computed once instead of at paint.
 *
 * WHAT IS *NOT* EXTRACTED, and why each exclusion is deliberate:
 *   - `--cv2-status-*`. They are ALIASES (`var(--pn-run)`), they are not in the
 *     `--pn-` namespace, and `tokens.css` keeps declaring them. Emitting them
 *     would freeze an alias into a value and break the one thing they exist for.
 *   - Non-custom-property declarations (`font-family`, `background`, … at the
 *     end of the `.cv2-root` block). They are not tokens; `tokens.css` still
 *     applies them and they resolve through whatever this table sets.
 *
 * VALUES ARE COPIED VERBATIM, INCLUDING `color-mix(...)` AND `var(...)`. Those
 * cannot be evaluated without a layout engine and must not be: `--pn-x-block-hover`
 * is a derivation ON PURPOSE so it tracks the ramp. The injected sheet declares
 * them on the same element it declares their inputs on, so they resolve
 * correctly wherever they land.
 *
 * Run it:  node scripts/extract-builtins.mjs           (writes the JSON)
 *          node scripts/extract-builtins.mjs --check    (exit 1 on drift)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKENS_CSS = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
const CANVAS_EXTRA_CSS = fileURLToPath(new URL('../src/styles/canvas-extra.css', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../../contract/src/builtins/', import.meta.url));

/**
 * Bump when a deploy changes what these tables hold, so a client holding a
 * cached resolved style knows to drop it (§2.4). It is NOT the document
 * schemaVersion and not a git count — it is "the Atelier you cached is stale".
 */
export const BUILTIN_REVISION = 2;

/**
 * THE TERMINAL OPTION KEYS (spec v8 §1.7, §10.3). xterm paints a canvas and
 * reads none of these from CSS, so they have no declaration to extract: they
 * are today's constants from `src/terminal/terminalTheme.ts:12-21`, restated
 * as `--pn-term-*` values so a style can override them like any other key.
 * Two are decisions rather than transcriptions: bold is 600 (the bundled
 * JetBrains Mono has no 700 face — sign-off §13) and font size is `auto`
 * (the per-device setting wins until a style names a number — §15.4).
 * `builtins-parity.test.ts` holds the rest to terminalTheme.ts.
 */
export const TERMINAL_DEFAULTS = {
  '--pn-term-chrome': 'dark',
  '--pn-term-cursor-style': 'block',
  '--pn-term-font':
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--pn-term-font-size': 'auto',
  '--pn-term-font-weight': '400',
  '--pn-term-font-weight-bold': '600',
  '--pn-term-letter-spacing': '0',
  '--pn-term-line-height': '1.2',
  '--pn-term-padding': '0',
  '--pn-term-scrollback': '5000',
};

/** Comments can contain braces and `--pn-…:` examples; strip them before parsing. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declaration bodies of every rule whose selector list satisfies `match`.
 *
 * A hand-rolled scan rather than PostCSS: the two files are flat (no nesting,
 * no at-rules except one `@import` with no block), the dependency would be the
 * only build-time CSS parser in the package, and a 20-line scanner that fails
 * loudly on an unbalanced brace is easier to trust than a transitive tree.
 */
function blocksMatching(css, match) {
  const out = [];
  const text = stripComments(css);
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const close = text.indexOf('}', open);
    if (close === -1) throw new Error('extract-builtins: unbalanced brace in CSS');
    /* A BLOCKLESS STATEMENT BEFORE THE RULE IS NOT PART OF ITS SELECTOR.
       tokens.css opens with `@import './fonts.css';`, so the raw slice up to
       the first `{` reads "@import './fonts.css'; .cv2-root" — which matched
       nothing and silently dropped the ENTIRE light palette, leaving only
       canvas-extra's 37 tokens. The `< 60` guard below is what surfaced it;
       without that guard this would have shipped a palette missing the whole
       type scale and still rendered, because tokens.css would have filled the
       gaps from underneath. Everything up to the last `;` is dropped here. */
    const raw = text.slice(i, open);
    const lastStatement = raw.lastIndexOf(';');
    const selector = raw.slice(lastStatement + 1).trim();
    if (selector && !selector.startsWith('@') && match(selector)) {
      out.push(text.slice(open + 1, close));
    }
    i = close + 1;
  }
  return out;
}

/** `--pn-foo: value;` pairs from a declaration body, in source order. */
function pnDeclarations(body) {
  const pairs = [];
  for (const m of body.matchAll(/(--pn-[\w-]+)\s*:\s*([^;]+);/g)) {
    pairs.push([m[1], m[2].trim().replace(/\s+/g, ' ')]);
  }
  return pairs;
}

/**
 * The LIGHT selector is the bare `.cv2-root` rule — and "bare" has to be
 * checked rather than assumed: `.cv2-root .t-display` is also a rule whose
 * selector starts with `.cv2-root`, and swallowing it would put `font-weight`
 * into the token table.
 */
const isLightRoot = (sel) =>
  sel.split(',').some((s) => s.trim() === '.cv2-root');

/** The DARK selector is tokens.css:137 / canvas-extra.css:163, either quoting style. */
const isDarkRoot = (sel) =>
  sel
    .split(',')
    .some((s) => /^\.cv2-root\[data-theme=['"]dark['"]\]$/.test(s.trim()));

export function extractBuiltins() {
  const files = [readFileSync(TOKENS_CSS, 'utf8'), readFileSync(CANVAS_EXTRA_CSS, 'utf8')];

  const light = {};
  for (const css of files) {
    for (const body of blocksMatching(css, isLightRoot)) {
      for (const [name, value] of pnDeclarations(body)) light[name] = value;
    }
  }

  /* Dark INHERITS light and overrides it — exactly what the browser does with
     tokens.css:137, which re-declares only the tokens that flip. Starting the
     dark table empty would drop every token the dark block does not mention
     (the whole type scale, spacing, radii, the terminal ANSI set) and the
     resolver's full-table contract would be a lie. */
  const dark = { ...light };
  const lightCssKeys = Object.keys(light).length;
  for (const css of files) {
    for (const body of blocksMatching(css, isDarkRoot)) {
      for (const [name, value] of pnDeclarations(body)) dark[name] = value;
    }
  }

  const sorted = (table) =>
    Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]]));

  if (lightCssKeys < 60) {
    throw new Error(
      `extract-builtins: only ${lightCssKeys} light tokens found — the selector scan is broken, not the palette`,
    );
  }
  /* The terminal options do not flip with the theme: one set for both. */
  Object.assign(light, TERMINAL_DEFAULTS);
  Object.assign(dark, TERMINAL_DEFAULTS);

  return {
    'atelier-light': {
      id: 'builtin:atelier-light',
      title: 'Atelier Light',
      builtinRevision: BUILTIN_REVISION,
      darkSibling: 'builtin:atelier-dark',
      tokens: sorted(light),
    },
    'atelier-dark': {
      id: 'builtin:atelier-dark',
      title: 'Atelier Dark',
      builtinRevision: BUILTIN_REVISION,
      /* A dark built-in is its OWN dark sibling. The always-dark scope still
         resolves through the same code path rather than through a null check,
         which is why this is a self-reference and not an optional field. */
      darkSibling: 'builtin:atelier-dark',
      tokens: sorted(dark),
    },
  };
}

/** The exact bytes committed, so `--check` compares like with like. */
export function serialise(builtin) {
  return `${JSON.stringify(builtin, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const built = extractBuiltins();
  let drift = 0;
  for (const [name, builtin] of Object.entries(built)) {
    const path = `${OUT_DIR}${name}.json`;
    const text = serialise(builtin);
    if (check) {
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = null;
      }
      if (current !== text) {
        console.error(`DRIFT: ${name}.json does not match the CSS`);
        drift += 1;
      } else {
        console.log(`ok: ${name}.json (${Object.keys(builtin.tokens).length} tokens)`);
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${name}.json (${Object.keys(builtin.tokens).length} tokens)`);
    }
  }
  if (drift) process.exit(1);
}
