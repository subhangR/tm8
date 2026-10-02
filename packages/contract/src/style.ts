/**
 * STYLES — the document, typed references and the pure resolver.
 *
 * Spec: doc "Styles as Entities — full design" v8 (01a0fc22): §1.3 (the three
 * parts), §1.5 (resolution), §1.7 (terminal), §2 (registry), §8 (validation),
 * §10.3 (what changed from Phase 1).
 *
 * WHY THIS LIVES IN @tm8/contract. The UI paints a style, the server
 * validates it on write and stamps `resolved_hash`, the CLI resolves it for
 * `tm8 style resolve`. Three callers, one implementation, or the hash the
 * server stores is not the hash the client computes.
 *
 * A STYLE IS `foundation` + `vars` + `css`. `vars` is literally the key-value
 * content of `tokens.css` + `canvas-extra.css` (plus the `--pn-term-*`
 * terminal options): any subset of the registry's keys, overlaid on the
 * foundation built-in, which supplies everything the style does not set. The
 * layout CSS changes with every release; the variables are the contract
 * between it and the theme, so a style that only sets variables keeps working.
 *
 * Phase 1 shipped a `layers` document. None was ever persisted, so
 * `schemaVersion: 1` is REDEFINED as this shape (§10.3) and there is nothing
 * to migrate.
 */
import { sha256Hex } from './artifact-manifest.js';
import { sanitizeStyleCss } from './style-css.js';
import {
  STYLE_REGISTRY,
  registryByKey,
  validateStyleVar,
  varReference,
  type StyleRegistry,
} from './style-registry.js';
import { BUILTIN_STYLES } from './builtins/index.js';

const UTF8 = new TextEncoder();

/** Bumped only when the document shape changes; see `migrateStyleDoc`. */
export const STYLE_SCHEMA_VERSION = 1;

/** §8.1 limits, exported so the server, CLI and editor share one number. */
export const STYLE_MAX_VARS = 200;
export const STYLE_MAX_DOC_BYTES = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// References (§1.2)
// ─────────────────────────────────────────────────────────────────────────────

export type BuiltinStyleId = `builtin:${string}`;
export type PersonalStyleRef = `personal:${string}`;
export type SpaceStyleRef = `space:${string}`;

/** The one way any surface names a style: a built-in, a personal style, a space style. */
export type StyleRef = BuiltinStyleId | PersonalStyleRef | SpaceStyleRef;

/** `id` is the part after the colon: a built-in's slug, or a personal/space uuid. */
export interface ParsedStyleRef {
  kind: 'builtin' | 'personal' | 'space';
  id: string;
}

const SLUG = /^[a-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `builtin:<slug>`, `personal:<uuid>` or `space:<uuid>`; anything else is null. */
export function parseStyleRef(input: string): ParsedStyleRef | null {
  const m = /^(builtin|personal|space):(.+)$/.exec(input.trim());
  if (!m?.[1] || !m[2]) return null;
  const rest = m[2];
  if (m[1] === 'builtin') return SLUG.test(rest) ? { kind: 'builtin', id: rest } : null;
  const id = rest.toLowerCase();
  if (!UUID.test(id)) return null;
  return { kind: m[1] as 'personal' | 'space', id };
}

export function formatStyleRef(ref: ParsedStyleRef): StyleRef {
  return `${ref.kind}:${ref.id}` as StyleRef;
}

export function isStyleRef(input: string): input is StyleRef {
  return parseStyleRef(input) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document (§1.3, §8.1)
// ─────────────────────────────────────────────────────────────────────────────

/** A CSS custom property this system is allowed to set. */
export type StyleCssVar = `--pn-${string}`;

/** A flat token table: a built-in's complete set, or a resolve's full output. */
export type StyleTokenTable = Record<StyleCssVar, string>;

export interface StyleDoc {
  schemaVersion: 1;
  /** Always a built-in. Supplies every variable `vars` does not set. */
  foundation: BuiltinStyleId;
  /** Any subset of the registry's keys. Unknown keys are dropped (with a warning) at resolve. */
  vars: Record<string, string>;
  /** Extra CSS, sanitised and re-scoped under `.cv2-root` (§8.3); null when none. */
  css: string | null;
}

/**
 * A shipped foundation: code-shipped JSON, never a row. `builtinRevision`
 * bumps when a deploy changes a built-in's values, so a cached resolved style
 * knows to re-resolve (§10.4).
 */
export interface BuiltinStyle {
  id: BuiltinStyleId;
  title: string;
  builtinRevision: number;
  /** The built-in whose surface keys paint always-dark scopes (§1.5 step 6). */
  darkSibling: BuiltinStyleId;
  /** Every registry key, complete by definition. */
  tokens: StyleTokenTable;
}

export type StyleWarningCode = 'unknown-key' | 'invalid-value' | 'clamped' | 'low-contrast' | 'css-dropped';

export interface StyleWarning {
  code: StyleWarningCode;
  /** The `--pn-*` key, `'css'`, `'foundation'`, or a contrast pair. */
  key: string | null;
  message: string;
}

/** One clamped value: what was given and what is used/stored (§8.2 "flag on write"). */
export interface StyleClamp {
  key: string;
  from: string;
  to: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved output (§1.5, §1.7)
// ─────────────────────────────────────────────────────────────────────────────

/** The xterm `ITheme` subset a style drives. Shape-compatible with ITheme. */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface XtermOptions {
  fontFamily: string;
  /**
   * `'auto'` = the device decides (`tm8.terminal-font-size` ?? 13); a number
   * = the style wins (§1.7, sign-off §15.4). Never defaulted to 13 here, or
   * every user would silently lose their device setting.
   */
  fontSize: number | 'auto';
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  letterSpacing: number;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  /** Host padding in px. Not an xterm option; the terminal host box reads it. */
  padding: number;
}

export interface ResolvedStyle {
  /** The foundation this resolved from, for cache invalidation. */
  foundation: BuiltinStyleId;
  builtinRevision: number;
  /** ALL registry keys, sorted: a full table, never a diff. */
  cssVars: StyleTokenTable;
  /** Ramp for `[data-always-dark]` scopes; null when `--pn-term-chrome` is `follow`. */
  alwaysDarkCssVars: StyleTokenTable | null;
  /** `luminance(paper) < 0.5`; drives the derived `data-theme` attribute. */
  darkish: boolean;
  xterm: { theme: XtermTheme; options: XtermOptions };
  /** Sanitised, scoped extra CSS; null when absent or fully rejected. */
  css: string | null;
  warnings: StyleWarning[];
  /** Every value that was clamped; each also has a `clamped` warning. */
  clamped: StyleClamp[];
  /** `sha256:<hex>` over cssVars + alwaysDark + xterm + css + builtinRevision. */
  hash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration (§10.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step per version, applied in order, pure. v1 is the first shape that
 * was ever persisted, so the body is the identity; it exists now so the server
 * read path and the editor's "upgrade and save" call it from day one.
 */
export function migrateStyleDoc(doc: StyleDoc): StyleDoc {
  return doc;
}

/** The document for a built-in: no vars, no css — resolve is the identity. */
export function styleDocForBuiltin(id: BuiltinStyleId): StyleDoc {
  return { schemaVersion: STYLE_SCHEMA_VERSION, foundation: id, vars: {}, css: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour maths for the contrast lint and `darkish`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sRGB triple from `#rgb`, `#rrggbb`, `rgb()`/`rgba()`. Everything else
 * (`color-mix()`, `oklch()`, named colours) is null and SKIPPED by the lint:
 * it only warns, so "no finding" about a colour it cannot evaluate is honest.
 */
export function toRgb(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
  if (hex?.[1]) {
    const h = hex[1];
    const pair = (i: number) => (h.length === 3 ? h[i]! + h[i]! : h.slice(i * 2, i * 2 + 2));
    return [parseInt(pair(0), 16), parseInt(pair(1), 16), parseInt(pair(2), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) {
    const nums = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (nums.every((n) => Number.isFinite(n))) {
      return [Math.round(nums[0]!), Math.round(nums[1]!), Math.round(nums[2]!)];
    }
  }
  return null;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.x contrast ratio, 1..21, or null when either colour cannot be evaluated. */
export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return null;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ANSI_SLOTS: readonly (keyof XtermTheme)[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
const ansiVar = (i: number): StyleCssVar => `--pn-x-term-ansi-${i}`;

const CONTRAST_RULES: readonly { fg: StyleCssVar; bg: StyleCssVar; min: number }[] = [
  { fg: '--pn-ink', bg: '--pn-paper', min: 4.5 },
  { fg: '--pn-ink-3', bg: '--pn-paper', min: 3 },
  { fg: '--pn-x-term-fg', bg: '--pn-x-term-live-bg', min: 4.5 },
];

function lintContrast(table: StyleTokenTable, warnings: StyleWarning[]): void {
  const check = (fg: StyleCssVar, bg: StyleCssVar, min: number) => {
    const ratio = contrastRatio(table[fg], table[bg]);
    if (ratio !== null && ratio < min) {
      warnings.push({
        code: 'low-contrast',
        key: `${fg} on ${bg}`,
        message: `contrast ${ratio.toFixed(2)}:1 is below ${min}:1`,
      });
    }
  };
  for (const rule of CONTRAST_RULES) check(rule.fg, rule.bg, rule.min);
  /* ANSI slot 0 is excluded: it is the terminal's own black and sits next to
     the background in every palette worth shipping (Atelier's is 1.39:1), so
     a floor on it would make the shipped default warn forever. Slots 1-15 are
     foreground colours and are linted at 2:1. */
  for (let i = 1; i < 16; i++) check(ansiVar(i), '--pn-x-term-live-bg', 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (§1.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Stable (key-sorted) JSON, so the hash is a function of the values only. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(',')}}`;
}

function sortedTable(table: StyleTokenTable): StyleTokenTable {
  const out: StyleTokenTable = {};
  for (const key of (Object.keys(table) as StyleCssVar[]).sort()) out[key] = table[key]!;
  return out;
}

function numberOf(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) ? n : fallback;
}

function buildXterm(table: StyleTokenTable): { theme: XtermTheme; options: XtermOptions } {
  const background = table['--pn-x-term-live-bg'] ?? '';
  const theme = {
    background,
    foreground: table['--pn-x-term-fg'] ?? '',
    cursor: table['--pn-x-term-cursor'] ?? '',
    /* An accent-less block cursor paints the glyph under it in the cursor's
       own fill — an invisible character — so it defaults to the background. */
    cursorAccent: table['--pn-x-term-cursor-accent'] ?? background,
    selectionBackground: table['--pn-x-term-sel-bg'] ?? '',
    selectionForeground: table['--pn-x-term-sel-fg'] ?? '',
  } as XtermTheme;
  ANSI_SLOTS.forEach((slot, i) => {
    theme[slot] = table[ansiVar(i)] ?? '';
  });

  const size = table['--pn-term-font-size'];
  const cursor = table['--pn-term-cursor-style'];
  const options: XtermOptions = {
    fontFamily: table['--pn-term-font'] ?? 'monospace',
    fontSize: size === undefined || size === 'auto' ? 'auto' : numberOf(size, 13),
    fontWeight: numberOf(table['--pn-term-font-weight'], 400),
    fontWeightBold: numberOf(table['--pn-term-font-weight-bold'], 600),
    lineHeight: numberOf(table['--pn-term-line-height'], 1.2),
    letterSpacing: numberOf(table['--pn-term-letter-spacing'], 0),
    scrollback: numberOf(table['--pn-term-scrollback'], 5000),
    cursorStyle: cursor === 'underline' || cursor === 'bar' ? cursor : 'block',
    padding: numberOf(table['--pn-term-padding'], 0),
  };
  return { theme, options };
}

interface CheckedVars {
  /** Accepted key -> validated (and clamped) value, in input order. */
  accepted: Record<StyleCssVar, string>;
  warnings: StyleWarning[];
  clamped: StyleClamp[];
}

/**
 * Validate a `vars` map against the registry (§1.5 step 4, §8.2): unknown key
 * dropped, invalid value dropped, out-of-range value clamped. Shared by
 * `resolveStyle` (read) and `normalizeStyleDoc` (write) so both apply one
 * grammar. `invalidSuffix` is what the warning says happens to the value.
 */
function checkVars(vars: unknown, registry: StyleRegistry, invalidSuffix: string): CheckedVars {
  const entries = registryByKey(registry);
  const colourKeys = new Set<string>(registry.entries.filter((e) => e.kind === 'colour').map((e) => e.key));
  const out: CheckedVars = { accepted: {}, warnings: [], clamped: [] };
  const map: Record<string, unknown> = vars && typeof vars === 'object' ? (vars as Record<string, unknown>) : {};
  for (const [key, raw] of Object.entries(map)) {
    const entry = entries.get(key);
    if (!entry) {
      out.warnings.push({ code: 'unknown-key', key, message: `unknown variable ${key}; dropped` });
      continue;
    }
    const check = validateStyleVar(entry, raw, colourKeys);
    if (!check.ok) {
      out.warnings.push({ code: 'invalid-value', key, message: `${key}: ${check.reason}; ${invalidSuffix}` });
      continue;
    }
    if ('clamped' in check) {
      out.clamped.push({ key, from: check.clamped.from, to: check.clamped.to });
      out.warnings.push({
        code: 'clamped',
        key,
        message: `${key} ${check.clamped.from} is out of range; using ${check.clamped.to}`,
      });
    }
    out.accepted[entry.key] = check.value;
  }
  return out;
}

/**
 * THE WRITE-TIME FORM (§8.2 "clamp on read AND flag on write"): what the
 * server stores. Unknown keys and invalid values are dropped, out-of-range
 * values are stored CLAMPED, and `css` is replaced by its sanitised text (null
 * when nothing survives), so a stored document is always valid. A key that a
 * LATER release removes survives in documents already stored and is dropped
 * only by `resolveStyle` (§10.4).
 */
export function normalizeStyleDoc(
  doc: StyleDoc,
  registry: StyleRegistry = STYLE_REGISTRY,
): { doc: StyleDoc; warnings: StyleWarning[]; clamped: StyleClamp[] } {
  const checked = checkVars(doc.vars, registry, 'dropped');
  const css = sanitizeStyleCss(doc.css);
  return {
    doc: {
      schemaVersion: STYLE_SCHEMA_VERSION,
      foundation: doc.foundation,
      vars: checked.accepted,
      css: css.css,
    },
    warnings: [...checked.warnings, ...css.warnings],
    clamped: checked.clamped,
  };
}

/**
 * THE RESOLVER (§1.5). Pure, synchronous, never throws on user data: the one
 * caller that matters runs it before first paint, where a throw is a white
 * screen. Every problem it finds is a warning.
 *
 *  1 shape: unknown foundation → first registered built-in + warning
 *  2 table = foundation tokens (complete by definition)
 *  3+4 overlay `vars`, each key validated by its registry kind: unknown key
 *      dropped, invalid value keeps the foundation's, out of range clamped,
 *      a bare `var(--pn-<colour>)` resolved ONE hop against the overlaid table
 *  5 derive `--pn-brand-rgb` from `--pn-brand`; `darkish` from paper
 *  6 always-dark ramp when `--pn-term-chrome` is `dark`: the dark sibling's
 *    SURFACE keys over this style's table
 *  7 xterm theme + options from the table (always-dark ramp when present)
 *  8 css → sanitised, scoped text or null
 *  9 contrast lint → warnings
 * 10 hash
 *
 * Foundation values are NOT re-validated: they are the extracted CSS, and the
 * parity test proves a built-in resolves to itself with no warnings.
 */
export function resolveStyle(
  doc: StyleDoc,
  builtins: Readonly<Record<string, BuiltinStyle>> = BUILTIN_STYLES,
  registry: StyleRegistry = STYLE_REGISTRY,
): ResolvedStyle {
  const warnings: StyleWarning[] = [];

  // 1
  let foundation = builtins[doc?.foundation];
  if (!foundation) {
    const fallbackId = Object.keys(builtins)[0];
    foundation = fallbackId ? builtins[fallbackId] : undefined;
    if (!foundation) throw new Error('resolveStyle: no built-in styles registered'); // a deploy bug, not user data
    warnings.push({
      code: 'invalid-value',
      key: 'foundation',
      message: `unknown foundation "${String(doc?.foundation)}"; fell back to ${foundation.id}`,
    });
  }

  // 2
  const table: StyleTokenTable = { ...foundation.tokens };

  // 3 + 4
  const checked = checkVars(doc?.vars, registry, 'kept the foundation value');
  warnings.push(...checked.warnings);
  const aliases: [StyleCssVar, StyleCssVar][] = [];
  const colourKeys = new Set<string>(registry.entries.filter((e) => e.kind === 'colour').map((e) => e.key));
  for (const [key, value] of Object.entries(checked.accepted) as [StyleCssVar, string][]) {
    table[key] = value;
    const target = colourKeys.has(key) ? varReference(value) : null;
    if (target) aliases.push([key, target as StyleCssVar]);
  }
  /* ONE HOP, read against the table as it stood after the overlay and before
     any substitution, so the result never depends on key order: `a: var(b),
     b: var(c)` leaves `a` unresolved (warned), it does not chain to c. */
  const beforeAliases = { ...table };
  for (const [key, target] of aliases) {
    const value = beforeAliases[target];
    if (value === undefined || varReference(value) !== null) {
      warnings.push({
        code: 'invalid-value',
        key,
        message: `${key}: var(${target}) does not resolve in one hop; kept the foundation value`,
      });
      table[key] = foundation.tokens[key] ?? '';
    } else {
      table[key] = value;
    }
  }

  // 5
  const brand = toRgb(table['--pn-brand']);
  if (brand) table['--pn-brand-rgb'] = `${brand[0]}, ${brand[1]}, ${brand[2]}`;
  const paper = toRgb(table['--pn-paper']);
  const darkish = paper ? relativeLuminance(paper) < 0.5 : false;

  // 6
  let alwaysDarkCssVars: StyleTokenTable | null = null;
  if (table['--pn-term-chrome'] !== 'follow') {
    const sibling = builtins[foundation.darkSibling] ?? foundation;
    const ramp: StyleTokenTable = { ...table };
    for (const entry of registry.entries) {
      const v = sibling.tokens[entry.key];
      if (entry.surface && v !== undefined) ramp[entry.key] = v;
    }
    alwaysDarkCssVars = sortedTable(ramp);
  }

  // 7
  const cssVars = sortedTable(table);
  const xterm = buildXterm(alwaysDarkCssVars ?? cssVars);

  // 8
  const sanitised = sanitizeStyleCss(doc?.css);
  warnings.push(...sanitised.warnings);

  // 9
  lintContrast(cssVars, warnings);

  // 10
  const hash = `sha256:${sha256Hex(
    UTF8.encode(
      stableStringify({
        cssVars,
        alwaysDarkCssVars,
        xterm,
        css: sanitised.css,
        builtinRevision: foundation.builtinRevision,
      }),
    ),
  )}`;

  return {
    foundation: foundation.id,
    builtinRevision: foundation.builtinRevision,
    cssVars,
    alwaysDarkCssVars,
    darkish,
    xterm,
    css: sanitised.css,
    warnings,
    clamped: checked.clamped,
    hash,
  };
}

/**
 * The injected variables sheet (§1.6). Here rather than in the UI because the
 * CLI and any future SSR path need the same bytes.
 *
 * THE ACTIVE RULE CLAIMS ONLY THE ROOTS WHOSE THEME AGREES WITH THE STYLE.
 * tokens.css decides a root's ramp like this: dark if the root, or ANY
 * ancestor, carries `data-theme="dark"`; light otherwise. Product roots take
 * `data-theme` from the store, so they always agree with it; review boards
 * and dev harnesses stamp their own theme (`SettingsBoard`'s light/dark pair),
 * and a root explicitly in the other theme must fall through to tokens.css
 * unchanged:
 *
 *   darkish : `.cv2-root[data-theme="dark"]`, `[data-theme="dark"] .cv2-root`
 *             — tokens.css's own dark selector, (0,2,0), later in head.
 *   light   : `.cv2-root:not([data-theme="dark"]):not([data-theme="dark"] *)`
 *             — every root tokens.css leaves light, (0,3,0).
 *
 * The always-dark rule comes second. Every always-dark scope also carries
 * `data-theme="dark"`, so the light rule never matches inside one; in the
 * dark case both rules are (0,2,0) and SOURCE ORDER decides — swap them and
 * every terminal takes the active ramp.
 *
 * The style's `css` is NOT in this sheet: it goes in its own element after
 * this one (§1.6), so a style's rules can never be out-ordered by its vars.
 */
export function styleSheetText(resolved: ResolvedStyle): string {
  const decls = (table: StyleTokenTable): string =>
    Object.entries(table)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');

  const selector = resolved.darkish
    ? '.cv2-root[data-theme="dark"],\n[data-theme="dark"] .cv2-root'
    : '.cv2-root:not([data-theme="dark"]):not([data-theme="dark"] *)';
  const main = `${selector} {\n${decls(resolved.cssVars)}\n}`;
  if (!resolved.alwaysDarkCssVars) return `${main}\n`;
  const dark = `.cv2-root[data-always-dark="true"],\n[data-always-dark="true"] .cv2-root {\n${decls(
    resolved.alwaysDarkCssVars,
  )}\n}`;
  return `${main}\n${dark}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export (§5 `tm8 style export`, §9.2 "export")
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportStyleOptions {
  /** `css`: a `.cv2-root { --pn-*: … }` block plus the style's css. `json`: the StyleDoc. */
  format: 'css' | 'json';
  /** `set`: only the vars the style sets. `all`: the full resolved table (all registry keys). */
  only: 'set' | 'all';
}

/** The header line an exported CSS file carries, so an import can recover the foundation. */
export const STYLE_EXPORT_FOUNDATION_MARKER = 'tm8-style foundation:';

/**
 * Serialise a style for a file. Pure. `only: 'all'` resolves first, so the
 * output is exactly what the style paints (clamped, aliases resolved, unknown
 * keys gone); `only: 'set'` writes the document's own vars as stored.
 */
export function exportStyle(doc: StyleDoc, options: ExportStyleOptions): string {
  const resolved = options.only === 'all' ? resolveStyle(doc) : null;
  const vars: Record<string, string> = resolved ? { ...resolved.cssVars } : { ...doc.vars };
  const css = resolved ? resolved.css : doc.css;
  if (options.format === 'json') {
    const out: StyleDoc = { schemaVersion: STYLE_SCHEMA_VERSION, foundation: doc.foundation, vars, css: css ?? null };
    return `${JSON.stringify(out, null, 2)}\n`;
  }
  const decls = Object.keys(vars)
    .sort()
    .map((k) => `  ${k}: ${vars[k]};`)
    .join('\n');
  const head = `/* ${STYLE_EXPORT_FOUNDATION_MARKER} ${doc.foundation} */\n.cv2-root {\n${decls}\n}\n`;
  return css ? `${head}\n${css.endsWith('\n') ? css : `${css}\n`}` : head;
}

/**
 * Read a style file back (the inverse of `exportStyle`), as the stored form:
 * the parsed document goes through `normalizeStyleDoc`, so an imported file is
 * held to exactly the rules a written one is.
 *
 *  - JSON (`.tm8style.json`): a StyleDoc. A missing or unknown foundation
 *    falls back to Atelier Light with a warning.
 *  - CSS: the first `.cv2-root { … }` (or `:root { … }`) block supplies `vars`
 *    (its `--pn-*` declarations); everything else in the file becomes `css`
 *    and is sanitized. The foundation comes from the export marker comment;
 *    without one it is Atelier Light.
 *
 * Never throws: unparseable input yields an empty document and a warning.
 */
export function importStyle(text: string): { doc: StyleDoc; warnings: StyleWarning[]; clamped: StyleClamp[] } {
  const warnings: StyleWarning[] = [];
  const fallback: BuiltinStyleId = 'builtin:atelier-light';
  const foundationOf = (raw: unknown): BuiltinStyleId => {
    if (typeof raw === 'string' && raw in BUILTIN_STYLES) return raw as BuiltinStyleId;
    if (raw !== undefined) {
      warnings.push({
        code: 'invalid-value',
        key: 'foundation',
        message: `unknown foundation "${String(raw)}"; using ${fallback}`,
      });
    }
    return fallback;
  };
  const finish = (doc: StyleDoc) => {
    const n = normalizeStyleDoc(doc);
    return { doc: n.doc, warnings: [...warnings, ...n.warnings], clamped: n.clamped };
  };
  const source = typeof text === 'string' ? text.trim() : '';

  if (source.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(source) as Record<string, unknown>;
    } catch {
      warnings.push({ code: 'invalid-value', key: 'import', message: 'file is not valid JSON; nothing imported' });
      return finish(styleDocForBuiltin(fallback));
    }
    const vars: Record<string, string> = {};
    if (parsed.vars && typeof parsed.vars === 'object') {
      for (const [k, v] of Object.entries(parsed.vars as Record<string, unknown>)) {
        if (typeof v === 'string') vars[k] = v;
        else warnings.push({ code: 'invalid-value', key: k, message: `${k}: value must be a string; dropped` });
      }
    }
    return finish({
      schemaVersion: STYLE_SCHEMA_VERSION,
      foundation: foundationOf(parsed.foundation),
      vars,
      css: typeof parsed.css === 'string' ? parsed.css : null,
    });
  }

  const markerRe = new RegExp(`/\\*\\s*${STYLE_EXPORT_FOUNDATION_MARKER}\\s*(\\S+)\\s*\\*/`);
  const marker = markerRe.exec(source);
  let rest = marker ? source.replace(marker[0], '') : source;
  const vars: Record<string, string> = {};
  const block = /(^|[\s}])(\.cv2-root|:root)\s*\{([^{}]*)\}/.exec(rest);
  if (block?.[3] !== undefined) {
    for (const m of block[3].matchAll(/(--pn-[a-z0-9-]+)\s*:\s*([^;]+?)\s*(;|$)/g)) vars[m[1]!] = m[2]!;
    rest = rest.slice(0, block.index + block[1]!.length) + rest.slice(block.index + block[0].length);
  }
  const css = rest.trim();
  return finish({
    schemaVersion: STYLE_SCHEMA_VERSION,
    foundation: foundationOf(marker?.[1]),
    vars,
    css: css ? css : null,
  });
}
