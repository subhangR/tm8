/**
 * STYLE ENTITIES — the document, the layer registry and the pure resolver.
 *
 * Design: doc "Style entities — design" §2.3 (document shape), §2.4
 * (versioning), §2.5 (composition constraints), §3 (resolution algorithm).
 *
 * WHY THIS LIVES IN @tm8/contract AND NOT IN THE UI. Three callers have to
 * agree on what a style resolves to or the feature is a lie: the UI (which
 * paints it), the server (which validates it on write and stamps a
 * `resolved_hash`) and the CLI (`style resolve`). A resolver that lived in the
 * UI would make the server's validation a second implementation, and two
 * implementations of a token cascade diverge on the first clamp nobody
 * transcribed.
 *
 * THE OUTPUT IS A FULL TOKEN TABLE, NOT A DIFF (§3 step 7). The renderer sets
 * every variable it knows about, so switching from style A to style B can never
 * leave one of A's values behind — there is no "unset" path to get wrong, and
 * CSS `var()` fall-through is never load-bearing.
 *
 * THE KEYSPACE, stated once because two namings meet here:
 *   - A BUILT-IN's `tokens` is keyed by CSS CUSTOM PROPERTY NAME (`--pn-paper`).
 *     It is literally the table `styles/tokens.css` + `styles/canvas-extra.css`
 *     declare, extracted mechanically (§11), so `resolveStyle` on a built-in
 *     with no layers is the IDENTITY — which is what makes the parity test in
 *     `packages/tm8-ui/src/styles/builtins-parity.test.ts` able to prove the
 *     resolver has no accidental opinion of its own.
 *   - A LAYER's `tokens` is keyed by FRIENDLY NAME (`paper`, `lineHeight`).
 *     The mapping friendly -> custom property is DATA in `LAYER_TYPES` below,
 *     never a `switch`: adding a token is a row, per the no-branching law.
 */
import { z } from 'zod';
import { sha256Hex } from './artifact-manifest.js';

const UTF8 = new TextEncoder();

/** Bumped only when the on-disk document shape changes; see `migrateStyleDoc`. */
export const STYLE_SCHEMA_VERSION = 1;

/** A built-in is addressed by a reserved id prefix, never by a row id (§2.2). */
export type BuiltinStyleId = `builtin:${string}`;

/** A CSS custom property this system is allowed to set. */
export type StyleCssVar = `--pn-${string}`;

/** The flat, complete token table a foundation defines and a resolve returns. */
export type StyleTokenTable = Record<StyleCssVar, string>;

export interface StyleLayer {
  /** Open set; `LAYER_TYPES` holds the ones v1 knows. Unknown = skipped + warned. */
  type: string;
  /** Default true. A disabled layer stays in the document so toggling is lossless. */
  enabled?: boolean;
  /** Editor affordance only; never read by the resolver. */
  label?: string;
  /** Partial override, validated by the layer type's schema. */
  tokens: Record<string, unknown>;
}

export interface StyleDoc {
  schemaVersion: number;
  /** Always a built-in. Never another user style — see §2.5 for why. */
  foundation: BuiltinStyleId;
  /** Applied in order; later wins. */
  layers: StyleLayer[];
}

/**
 * A shipped foundation. `builtinRevision` exists so a client holding a cached
 * resolved style can tell that a DEPLOY changed Atelier underneath it (§2.4) —
 * the document did not change, so document versioning cannot carry that fact.
 */
export interface BuiltinStyle {
  id: BuiltinStyleId;
  title: string;
  builtinRevision: number;
  /**
   * The foundation used for ALWAYS-DARK scopes when `terminal.chrome` is
   * `'dark'` (§3.3). Atelier Light points at Atelier Dark; a dark built-in
   * points at itself.
   */
  darkSibling: BuiltinStyleId;
  tokens: StyleTokenTable;
}

export type StyleWarningCode =
  | 'unknown-layer-type'
  | 'unknown-token'
  | 'invalid-token'
  | 'clamped'
  | 'unresolved-alias'
  | 'low-contrast';

export interface StyleWarning {
  code: StyleWarningCode;
  /** Layer index the warning came from, or null for document-level findings. */
  layer: number | null;
  /** Friendly token key, custom property name, or layer type — whatever applies. */
  at: string;
  message: string;
}

/** The subset of xterm's `ITheme` this system drives. Shape-compatible by design. */
export interface ResolvedXtermTheme {
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

/**
 * The xterm options a style drives. `fontSize` is DELIBERATELY OPTIONAL and
 * absent by default: §15.4 rules the PER-DEVICE setting
 * (`localStorage['tm8.terminal-font-size']`) the default, with a style allowed
 * to override it. `undefined` therefore means "the device decides" and is not
 * the same as any number — a resolver that defaulted it to 13 would silently
 * take the device setting away from every user.
 */
export interface ResolvedXtermOptions {
  fontFamily: string;
  fontSize?: number;
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  letterSpacing: number;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  /** Terminal host padding, in px. Not an xterm option — the host box reads it. */
  padding: number;
}

export interface ResolvedStyle {
  /** The foundation this resolved from, for cache invalidation (§2.4). */
  foundation: BuiltinStyleId;
  builtinRevision: number;
  /** Every token `tokens.css` + `canvas-extra.css` declares. */
  cssVars: StyleTokenTable;
  /**
   * The ramp for `[data-always-dark="true"]` scopes (§3.3), or `null` when
   * `terminal.chrome === 'follow'` — in which case the chrome takes the main
   * ramp and the caller emits no second rule.
   */
  alwaysDarkCssVars: StyleTokenTable | null;
  /** True when the main ramp's paper is dark; drives the derived `data-theme` (§3.2). */
  darkish: boolean;
  xterm: { theme: ResolvedXtermTheme; options: ResolvedXtermOptions };
  terminalChrome: 'dark' | 'follow';
  warnings: StyleWarning[];
  /** sha256 of the resolved output. Cheap equality for "did anything change". */
  hash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The layer-type registry (§2.3). DATA, not control flow.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A colour token accepts any CSS `<color>` the browser parses, so this schema
 * is deliberately a LOOSE string here and a conservative grammar at SAVE time
 * (§2.3) — clamping the render path to a grammar would make a perfectly good
 * `oklch()` render as nothing. It also accepts `"@otherToken"`, the one-hop
 * alias form resolved in step 3.
 */
const ColourValue = z.string().min(1).max(256);

/** A numeric token with its render-time clamp. Both halves live in one place. */
interface NumberSpec {
  min: number;
  max: number;
}

/**
 * How a friendly layer token reaches the output.
 *
 *  - `var`: writes one custom property verbatim.
 *  - `vars`: writes an indexed family (`ansi` -> `--pn-x-term-ansi-0..15`).
 *  - `derive`: feeds a DERIVED quantity (§3 step 5) rather than a property —
 *    `scale.factor` multiplies twelve font sizes, it is not a token.
 *  - `xterm`: drives an xterm option, which is not CSS at all.
 */
type TokenSink =
  | { sink: 'var'; cssVar: StyleCssVar; kind: 'colour' | 'text' }
  | { sink: 'var'; cssVar: StyleCssVar; kind: 'number'; unit: string; range: NumberSpec }
  | { sink: 'vars'; cssVars: readonly StyleCssVar[]; kind: 'colour' }
  | { sink: 'derive'; derived: DerivedKnob; range: NumberSpec }
  | { sink: 'xterm'; option: keyof ResolvedXtermOptions; kind: 'colour' | 'text' }
  | { sink: 'xterm'; option: keyof ResolvedXtermOptions; kind: 'number'; range: NumberSpec }
  | { sink: 'chrome' };

type DerivedKnob = 'scaleFactor' | 'spacingUnit' | 'radiusFactor' | 'durationFactor';

export interface LayerTypeSpec {
  /** Validates and strips a layer's `tokens`; unknown keys are dropped + warned. */
  schema: z.ZodTypeAny;
  /** Friendly key -> where it lands. */
  tokens: Readonly<Record<string, TokenSink>>;
  /**
   * True for layer types that recolour the surface. Always-dark scopes skip
   * these when `chrome === 'dark'` (§3.3: the chrome takes the dark SIBLING's
   * colours, which is what keeps today's pixels) but still take the type,
   * spacing and motion layers, so a user's scale slider reaches the terminal
   * strip like it reaches everything else.
   */
  recolours: boolean;
}

const COLOUR_VARS: Readonly<Record<string, StyleCssVar>> = {
  paper: '--pn-paper',
  surface: '--pn-surface',
  card: '--pn-card',
  hover: '--pn-hover',
  active: '--pn-active',
  line: '--pn-line',
  line2: '--pn-line-2',
  ink: '--pn-ink',
  ink2: '--pn-ink-2',
  ink3: '--pn-ink-3',
  ink4: '--pn-ink-4',
  brand: '--pn-brand',
  brand2: '--pn-brand-2',
  brandSoft: '--pn-brand-soft',
  run: '--pn-run',
  runSoft: '--pn-run-soft',
  wait: '--pn-wait',
  waitSoft: '--pn-wait-soft',
  block: '--pn-block',
  blockSoft: '--pn-block-soft',
  info: '--pn-info',
  infoSoft: '--pn-info-soft',
  idle: '--pn-idle',
  idleSoft: '--pn-idle-soft',
  prMerged: '--pn-pr-merged',
  prMergedSoft: '--pn-pr-merged-soft',
  scrim: '--pn-scrim',
  shSm: '--pn-sh-sm',
  shMd: '--pn-sh-md',
  shPop: '--pn-sh-pop',
};

const ANSI_VARS: readonly StyleCssVar[] = [
  '--pn-x-term-ansi-0', '--pn-x-term-ansi-1', '--pn-x-term-ansi-2', '--pn-x-term-ansi-3',
  '--pn-x-term-ansi-4', '--pn-x-term-ansi-5', '--pn-x-term-ansi-6', '--pn-x-term-ansi-7',
  '--pn-x-term-ansi-8', '--pn-x-term-ansi-9', '--pn-x-term-ansi-10', '--pn-x-term-ansi-11',
  '--pn-x-term-ansi-12', '--pn-x-term-ansi-13', '--pn-x-term-ansi-14', '--pn-x-term-ansi-15',
];

const DIA_VARS: readonly StyleCssVar[] = [
  '--pn-x-dia-1', '--pn-x-dia-2', '--pn-x-dia-3', '--pn-x-dia-4',
  '--pn-x-dia-5', '--pn-x-dia-6', '--pn-x-dia-7', '--pn-x-dia-8',
];

/** ANSI slot -> xterm `ITheme` key, in standard ANSI order. */
const ANSI_THEME_SLOTS: readonly (keyof ResolvedXtermTheme)[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/** The twelve `--pn-fs-*` the type scale multiplies, longest name first is irrelevant. */
const FS_VARS: readonly StyleCssVar[] = [
  '--pn-fs-display', '--pn-fs-h1', '--pn-fs-h2', '--pn-fs-h3', '--pn-fs-title',
  '--pn-fs-body', '--pn-fs-sm', '--pn-fs-label', '--pn-fs-micro', '--pn-fs-fine',
  '--pn-fs-tick', '--pn-fs-mono',
];

/** `--pn-space-N` where N is the step. Every step is N x the spacing unit. */
const SPACE_STEPS: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];

/**
 * Radii the radius factor scales. `--pn-r-pill` is EXCLUDED on purpose: 999px
 * is a "fully round" sentinel, not a measurement, and multiplying it by 0.5
 * would still be fully round while multiplying it by 2 overflows nothing — the
 * token means "pill", so scaling it is meaningless rather than wrong.
 */
const RADIUS_VARS: readonly StyleCssVar[] = ['--pn-r-xs', '--pn-r-sm', '--pn-r-md', '--pn-r-lg'];

const DURATION_VARS: readonly StyleCssVar[] = ['--pn-dur-fast', '--pn-dur-base', '--pn-dur-slow'];

const colourLayerTokens: Record<string, TokenSink> = {};
for (const [key, cssVar] of Object.entries(COLOUR_VARS)) {
  colourLayerTokens[key] = { sink: 'var', cssVar, kind: 'colour' };
}

export const LAYER_TYPES: Readonly<Record<string, LayerTypeSpec>> = {
  colour: {
    recolours: true,
    tokens: colourLayerTokens,
    schema: z
      .object(Object.fromEntries(Object.keys(COLOUR_VARS).map((k) => [k, ColourValue.optional()])))
      .partial()
      .strip(),
  },
  typography: {
    recolours: false,
    tokens: {
      fontUi: { sink: 'var', cssVar: '--pn-ui', kind: 'text' },
      fontSerif: { sink: 'var', cssVar: '--pn-serif', kind: 'text' },
      fontMono: { sink: 'var', cssVar: '--pn-mono', kind: 'text' },
      lhTight: { sink: 'var', cssVar: '--pn-lh-tight', kind: 'number', unit: '', range: { min: 1, max: 2.5 } },
      lhSnug: { sink: 'var', cssVar: '--pn-lh-snug', kind: 'number', unit: '', range: { min: 1, max: 2.5 } },
      lhBody: { sink: 'var', cssVar: '--pn-lh-body', kind: 'number', unit: '', range: { min: 1, max: 2.5 } },
      trackMega: { sink: 'var', cssVar: '--pn-track-mega', kind: 'number', unit: 'em', range: { min: -0.1, max: 0.5 } },
      trackLabel: { sink: 'var', cssVar: '--pn-track-label', kind: 'number', unit: 'em', range: { min: -0.1, max: 0.5 } },
      trackTight: { sink: 'var', cssVar: '--pn-track-tight', kind: 'number', unit: 'em', range: { min: -0.1, max: 0.5 } },
    },
    schema: z
      .object({
        fontUi: z.string().min(1).max(512).optional(),
        fontSerif: z.string().min(1).max(512).optional(),
        fontMono: z.string().min(1).max(512).optional(),
        lhTight: z.number().finite().optional(),
        lhSnug: z.number().finite().optional(),
        lhBody: z.number().finite().optional(),
        trackMega: z.number().finite().optional(),
        trackLabel: z.number().finite().optional(),
        trackTight: z.number().finite().optional(),
      })
      .strip(),
  },
  /**
   * ONE SLIDER, NOT TWELVE FIELDS. The ratios between the twelve sizes ARE the
   * type scale; exposing each size separately would let a user flatten it into
   * twelve equal numbers, and `type-scale-ban.test.ts` exists because that is
   * the failure the package already paid for once.
   */
  scale: {
    recolours: false,
    tokens: { factor: { sink: 'derive', derived: 'scaleFactor', range: { min: 0.8, max: 1.4 } } },
    schema: z.object({ factor: z.number().finite().optional() }).strip(),
  },
  spacing: {
    recolours: false,
    tokens: {
      unit: { sink: 'derive', derived: 'spacingUnit', range: { min: 3, max: 6 } },
      radiusFactor: { sink: 'derive', derived: 'radiusFactor', range: { min: 0, max: 2 } },
      readMeasure: { sink: 'var', cssVar: '--pn-read-measure', kind: 'number', unit: 'px', range: { min: 560, max: 960 } },
    },
    schema: z
      .object({
        unit: z.number().finite().optional(),
        radiusFactor: z.number().finite().optional(),
        readMeasure: z.number().finite().optional(),
      })
      .strip(),
  },
  motion: {
    recolours: false,
    tokens: {
      durationFactor: { sink: 'derive', derived: 'durationFactor', range: { min: 0, max: 2 } },
      easeOut: { sink: 'var', cssVar: '--pn-ease-out', kind: 'text' },
      easeStandard: { sink: 'var', cssVar: '--pn-ease-standard', kind: 'text' },
    },
    schema: z
      .object({
        durationFactor: z.number().finite().optional(),
        easeOut: z.string().min(1).max(128).optional(),
        easeStandard: z.string().min(1).max(128).optional(),
      })
      .strip(),
  },
  terminal: {
    recolours: true,
    tokens: {
      background: { sink: 'var', cssVar: '--pn-x-term-bg', kind: 'colour' },
      liveBackground: { sink: 'var', cssVar: '--pn-x-term-live-bg', kind: 'colour' },
      foreground: { sink: 'var', cssVar: '--pn-x-term-fg', kind: 'colour' },
      cursor: { sink: 'var', cssVar: '--pn-x-term-cursor', kind: 'colour' },
      cursorAccent: { sink: 'var', cssVar: '--pn-x-term-cursor-accent', kind: 'colour' },
      selectionBackground: { sink: 'var', cssVar: '--pn-x-term-sel-bg', kind: 'colour' },
      selectionForeground: { sink: 'var', cssVar: '--pn-x-term-sel-fg', kind: 'colour' },
      ansi: { sink: 'vars', cssVars: ANSI_VARS, kind: 'colour' },
      fontFamily: { sink: 'xterm', option: 'fontFamily', kind: 'text' },
      fontSize: { sink: 'xterm', option: 'fontSize', kind: 'number', range: { min: 8, max: 24 } },
      fontWeight: { sink: 'xterm', option: 'fontWeight', kind: 'number', range: { min: 100, max: 900 } },
      fontWeightBold: { sink: 'xterm', option: 'fontWeightBold', kind: 'number', range: { min: 100, max: 900 } },
      lineHeight: { sink: 'xterm', option: 'lineHeight', kind: 'number', range: { min: 1, max: 1.8 } },
      letterSpacing: { sink: 'xterm', option: 'letterSpacing', kind: 'number', range: { min: -1, max: 2 } },
      scrollback: { sink: 'xterm', option: 'scrollback', kind: 'number', range: { min: 500, max: 50_000 } },
      cursorStyle: { sink: 'xterm', option: 'cursorStyle', kind: 'text' },
      padding: { sink: 'xterm', option: 'padding', kind: 'number', range: { min: 0, max: 24 } },
      chrome: { sink: 'chrome' },
    },
    schema: z
      .object({
        background: ColourValue.optional(),
        liveBackground: ColourValue.optional(),
        foreground: ColourValue.optional(),
        cursor: ColourValue.optional(),
        cursorAccent: ColourValue.optional(),
        selectionBackground: ColourValue.optional(),
        selectionForeground: ColourValue.optional(),
        ansi: z.array(ColourValue).length(16).optional(),
        fontFamily: z.string().min(1).max(512).optional(),
        fontSize: z.number().finite().optional(),
        fontWeight: z.number().finite().optional(),
        fontWeightBold: z.number().finite().optional(),
        lineHeight: z.number().finite().optional(),
        letterSpacing: z.number().finite().optional(),
        scrollback: z.number().finite().optional(),
        cursorStyle: z.enum(['block', 'underline', 'bar']).optional(),
        padding: z.number().finite().optional(),
        chrome: z.enum(['dark', 'follow']).optional(),
      })
      .strip(),
  },
  extras: {
    recolours: true,
    tokens: {
      warnFill: { sink: 'var', cssVar: '--pn-x-warn-fill', kind: 'colour' },
      hairlineSoft: { sink: 'var', cssVar: '--pn-x-hairline-soft', kind: 'colour' },
      blockHover: { sink: 'var', cssVar: '--pn-x-block-hover', kind: 'colour' },
      proseInk: { sink: 'var', cssVar: '--pn-x-prose-ink', kind: 'colour' },
      btnInkHover: { sink: 'var', cssVar: '--pn-x-btn-ink-hover', kind: 'colour' },
      termGhost: { sink: 'var', cssVar: '--pn-x-term-ghost', kind: 'colour' },
      dia: { sink: 'vars', cssVars: DIA_VARS, kind: 'colour' },
    },
    schema: z
      .object({
        warnFill: ColourValue.optional(),
        hairlineSoft: ColourValue.optional(),
        blockHover: ColourValue.optional(),
        proseInk: ColourValue.optional(),
        btnInkHover: ColourValue.optional(),
        termGhost: ColourValue.optional(),
        dia: z.array(ColourValue).length(8).optional(),
      })
      .strip(),
  },
};

/** §2.5 server checks, exported so the server and the editor use one number. */
export const STYLE_MAX_LAYERS = 32;
export const STYLE_MAX_DOC_BYTES = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Migration (§2.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step per version, applied in order, pure and total.
 *
 * STUB BY CONSTRUCTION, NOT BY OMISSION. v1 is the first shape, so there is
 * nothing to migrate FROM and the only honest body is the identity. It exists
 * now rather than later because the call site (server read path, editor
 * "upgrade and save") is the thing that must not be retrofitted — a migration
 * added after the read path shipped has to find every caller.
 */
export function migrateStyleDoc(doc: StyleDoc): StyleDoc {
  if (doc.schemaVersion >= STYLE_SCHEMA_VERSION) return doc;
  // No v0 ever shipped; a document claiming one is corrupt, not old. Re-stamping
  // it would launder the corruption, so the shape is returned untouched with
  // only the version normalised and validation left to say no.
  return { ...doc, schemaVersion: STYLE_SCHEMA_VERSION };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (§3)
// ─────────────────────────────────────────────────────────────────────────────

/** Default document for a foundation: no layers, so resolve is the identity. */
export function styleDocForBuiltin(id: BuiltinStyleId): StyleDoc {
  return { schemaVersion: STYLE_SCHEMA_VERSION, foundation: id, layers: [] };
}

interface DerivedKnobs {
  scaleFactor: number;
  spacingUnit: number;
  radiusFactor: number;
  durationFactor: number;
}

const DEFAULT_KNOBS: DerivedKnobs = {
  scaleFactor: 1,
  spacingUnit: 4,
  radiusFactor: 1,
  durationFactor: 1,
};

function clampNumber(
  value: number,
  range: NumberSpec,
  at: string,
  layer: number | null,
  warnings: StyleWarning[],
): number {
  if (value < range.min || value > range.max) {
    const clamped = Math.min(range.max, Math.max(range.min, value));
    warnings.push({
      code: 'clamped',
      layer,
      at,
      message: `${at} ${value} is outside [${range.min}, ${range.max}]; using ${clamped}`,
    });
    return clamped;
  }
  return value;
}

/**
 * Numbers in CSS must not arrive as `4.000000000000001`. Six decimals is far
 * beyond any token's meaningful precision and kills float noise from the
 * multiplications in step 5 — without it, `1 * 12.5` can print differently from
 * `12.5` on some paths and the parity test would fail for a reason that is not
 * about styling at all.
 */
function cssNumber(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

/** A px size rounded to the nearest half pixel (§3 step 5). */
function halfPixel(n: number): number {
  return Math.round(n * 2) / 2;
}

/** Parses the numeric prefix of a token value like `40px` or `120ms`. */
function numericPrefix(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*(-?\d*\.?\d+)/.exec(value);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

interface LayerPass {
  table: StyleTokenTable;
  knobs: DerivedKnobs;
  xtermOverrides: Partial<ResolvedXtermOptions>;
  chrome: 'dark' | 'follow';
}

/**
 * Steps 1-2 and 4 for ONE base table. Called twice per resolve — once for the
 * main ramp and once for the always-dark ramp — rather than recursing, so
 * there is no cycle to detect and the two passes provably share one code path.
 *
 * `recolourFilter` is how §3.3's "the chrome takes the dark sibling's colours"
 * is expressed without a second resolver: the always-dark pass runs the same
 * layers with the recolouring types dropped.
 */
function applyLayers(
  base: StyleTokenTable,
  layers: readonly StyleLayer[],
  warnings: StyleWarning[],
  opts: { skipRecolouring: boolean; collectWarnings: boolean },
): LayerPass {
  const table: StyleTokenTable = { ...base };
  const knobs: DerivedKnobs = { ...DEFAULT_KNOBS };
  const xtermOverrides: Partial<ResolvedXtermOptions> = {};
  let chrome: 'dark' | 'follow' = 'dark';

  const warn = (w: StyleWarning): void => {
    if (opts.collectWarnings) warnings.push(w);
  };
  const sink = opts.collectWarnings ? warnings : [];

  layers.forEach((layer, index) => {
    if (layer.enabled === false) return;
    const spec = LAYER_TYPES[layer.type];
    if (!spec) {
      warn({
        code: 'unknown-layer-type',
        layer: index,
        at: layer.type,
        message: `unknown layer type "${layer.type}"; skipped`,
      });
      return;
    }
    if (opts.skipRecolouring && spec.recolours) return;

    const parsed = spec.schema.safeParse(layer.tokens ?? {});
    if (!parsed.success) {
      warn({
        code: 'invalid-token',
        layer: index,
        at: layer.type,
        message: `layer ${index} (${layer.type}) failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      });
      return;
    }

    /* Unknown keys are reported from the RAW tokens against the registry, not
       from zod: `.strip()` removes them silently, which is the behaviour we
       want for rendering and exactly the wrong behaviour for telling the author
       they typed `papper`. */
    for (const key of Object.keys(layer.tokens ?? {})) {
      if (!spec.tokens[key]) {
        warn({
          code: 'unknown-token',
          layer: index,
          at: `${layer.type}.${key}`,
          message: `unknown token "${key}" on a ${layer.type} layer; dropped`,
        });
      }
    }

    for (const [key, raw] of Object.entries(parsed.data as Record<string, unknown>)) {
      if (raw === undefined) continue;
      const target = spec.tokens[key];
      if (!target) continue;
      const at = `${layer.type}.${key}`;

      if (target.sink === 'chrome') {
        chrome = raw === 'follow' ? 'follow' : 'dark';
        continue;
      }
      if (target.sink === 'derive') {
        knobs[target.derived] = clampNumber(raw as number, target.range, at, index, sink);
        continue;
      }
      if (target.sink === 'vars') {
        (raw as string[]).forEach((v, i) => {
          const cssVar = target.cssVars[i];
          if (cssVar) table[cssVar] = v;
        });
        continue;
      }
      if (target.sink === 'xterm') {
        if (target.kind === 'number') {
          const n = clampNumber(raw as number, target.range, at, index, sink);
          (xtermOverrides as Record<string, unknown>)[target.option] = n;
        } else {
          (xtermOverrides as Record<string, unknown>)[target.option] = raw;
        }
        continue;
      }
      // sink === 'var'
      if (target.kind === 'number') {
        const n = clampNumber(raw as number, target.range, at, index, sink);
        table[target.cssVar] = `${cssNumber(n)}${target.unit}`;
      } else {
        table[target.cssVar] = String(raw);
      }
    }
  });

  return { table, knobs, xtermOverrides, chrome };
}

/**
 * Step 3: `"@otherToken"` resolves against the table, ONE HOP ONLY.
 *
 * One hop is a design constraint and not a shortcut: a chain needs cycle
 * detection, cycle detection needs an error path, and an error path in a
 * renderer that runs before first paint is a blank screen. One hop cannot
 * cycle, so the resolver has no failure mode here — an alias that does not
 * resolve warns and keeps the foundation's value.
 */
function resolveAliases(
  table: StyleTokenTable,
  warnings: StyleWarning[],
  base: StyleTokenTable,
): void {
  /* SNAPSHOT FIRST. Substituting in place would make the hop count depend on
     key ITERATION ORDER: `cursor: "@brand", brand: "@ink"` would chain to ink
     if `brand` happened to be visited first and stop at `"@ink"` if it did not.
     Reading every alias against the pre-substitution table makes one hop one
     hop regardless of insertion order. */
  const before: StyleTokenTable = { ...table };
  for (const [cssVar, value] of Object.entries(before) as [StyleCssVar, string][]) {
    if (typeof value !== 'string' || !value.startsWith('@')) continue;
    const friendly = value.slice(1);
    const targetVar = COLOUR_VARS[friendly] ?? (`--pn-${friendly}` as StyleCssVar);
    const resolved = before[targetVar];
    /* The TARGET is read before aliases are substituted, so `a: "@b", b: "@c"`
       leaves `a` holding `"@c"` — which is not a colour. That is the one-hop
       rule made observable rather than silently chained. */
    if (resolved === undefined || resolved.startsWith('@')) {
      warnings.push({
        code: 'unresolved-alias',
        layer: null,
        at: cssVar,
        message: `alias "${value}" on ${cssVar} does not resolve in one hop; kept the foundation value`,
      });
      table[cssVar] = base[cssVar] ?? '';
      continue;
    }
    table[cssVar] = resolved;
  }
}

/** Step 5's derived families, applied to a table in place. */
function applyDerived(table: StyleTokenTable, base: StyleTokenTable, knobs: DerivedKnobs): void {
  // --pn-brand-rgb is DERIVED from --pn-brand and never authored: a layer that
  // could set them independently could set them inconsistently, and every
  // `rgba(var(--pn-brand-rgb), a)` in the package would then disagree with
  // `var(--pn-brand)` by a hue nobody chose.
  const brandRgb = toRgb(table['--pn-brand']);
  if (brandRgb) table['--pn-brand-rgb'] = `${brandRgb[0]}, ${brandRgb[1]}, ${brandRgb[2]}`;

  if (knobs.scaleFactor !== 1) {
    for (const cssVar of FS_VARS) {
      const n = numericPrefix(base[cssVar]);
      if (n !== null) table[cssVar] = `${cssNumber(halfPixel(n * knobs.scaleFactor))}px`;
    }
  }
  if (knobs.spacingUnit !== DEFAULT_KNOBS.spacingUnit) {
    for (const step of SPACE_STEPS) {
      table[`--pn-space-${step}`] = `${cssNumber(step * knobs.spacingUnit)}px`;
    }
  }
  if (knobs.radiusFactor !== 1) {
    for (const cssVar of RADIUS_VARS) {
      const n = numericPrefix(base[cssVar]);
      if (n !== null) table[cssVar] = `${cssNumber(Math.round(n * knobs.radiusFactor))}px`;
    }
  }
  if (knobs.durationFactor !== 1) {
    for (const cssVar of DURATION_VARS) {
      const n = numericPrefix(base[cssVar]);
      if (n !== null) table[cssVar] = `${cssNumber(Math.round(n * knobs.durationFactor))}ms`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour maths for the contrast lint (§3 step 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sRGB triple from the colour forms a TOKEN TABLE actually carries: `#rgb`,
 * `#rrggbb`, `rgb()`/`rgba()`. Everything else — `color-mix()`, `var()`,
 * `oklch()` — returns null and is SKIPPED rather than guessed.
 *
 * WHY SKIPPING IS CORRECT HERE and would be wrong in a validator: this is a
 * LINT that only ever produces warnings. A `color-mix()` we cannot evaluate
 * without a layout engine yields "no finding", which is honest. Guessing at it
 * would produce a contrast number about a colour nobody is going to see.
 */
export function toRgb(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
  if (hex?.[1]) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0]! + h[0]!, 16),
        parseInt(h[1]! + h[1]!, 16),
        parseInt(h[2]! + h[2]!, 16),
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
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

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return null;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The pairs §3 step 6 lints, with their floors. */
const CONTRAST_RULES: readonly { fg: StyleCssVar; bg: StyleCssVar; min: number }[] = [
  { fg: '--pn-ink', bg: '--pn-paper', min: 4.5 },
  { fg: '--pn-ink-3', bg: '--pn-paper', min: 3 },
  { fg: '--pn-x-term-fg', bg: '--pn-x-term-live-bg', min: 4.5 },
];

function lintContrast(table: StyleTokenTable, warnings: StyleWarning[]): void {
  for (const rule of CONTRAST_RULES) {
    const ratio = contrastRatio(table[rule.fg], table[rule.bg]);
    if (ratio !== null && ratio < rule.min) {
      warnings.push({
        code: 'low-contrast',
        layer: null,
        at: `${rule.fg} on ${rule.bg}`,
        message: `contrast ${ratio.toFixed(2)}:1 is below ${rule.min}:1`,
      });
    }
  }
  /**
   * ANSI SLOT 0 IS EXCLUDED, and this is a correction to §3 step 6 rather than
   * an omission. Slot 0 is the terminal's own "black": every palette worth
   * shipping places it within a few units of the background, because that is
   * what the slot MEANS. Atelier's own #322D24 on #131009 is 1.39:1 — so a
   * literal 16-slot floor makes the SHIPPED DEFAULT carry a permanent warning,
   * and a warning that is always on is a warning nobody reads. Slots 1-15 are
   * foreground colours and are linted.
   */
  for (const ansiVar of ANSI_VARS.slice(1)) {
    const ratio = contrastRatio(table[ansiVar], table['--pn-x-term-live-bg']);
    if (ratio !== null && ratio < 2) {
      warnings.push({
        code: 'low-contrast',
        layer: null,
        at: `${ansiVar} on --pn-x-term-live-bg`,
        message: `contrast ${ratio.toFixed(2)}:1 is below 2:1`,
      });
    }
  }
}

function buildXtermTheme(table: StyleTokenTable): ResolvedXtermTheme {
  const background = table['--pn-x-term-live-bg'] ?? '';
  const theme: ResolvedXtermTheme = {
    background,
    foreground: table['--pn-x-term-fg'] ?? '',
    cursor: table['--pn-x-term-cursor'] ?? '',
    // §3 step 5: `cursorAccent ??= background`. A cursor with no accent paints
    // the glyph under a block cursor in the default colour, which on a block
    // cursor is the cursor's own fill — i.e. an invisible character.
    cursorAccent: table['--pn-x-term-cursor-accent'] ?? background,
    selectionBackground: table['--pn-x-term-sel-bg'] ?? '',
    selectionForeground: table['--pn-x-term-sel-fg'] ?? '',
    black: '', red: '', green: '', yellow: '', blue: '', magenta: '', cyan: '', white: '',
    brightBlack: '', brightRed: '', brightGreen: '', brightYellow: '',
    brightBlue: '', brightMagenta: '', brightCyan: '', brightWhite: '',
  };
  ANSI_THEME_SLOTS.forEach((slot, i) => {
    theme[slot] = table[ANSI_VARS[i]!] ?? '';
  });
  return theme;
}

/**
 * xterm option defaults. These are the CONSTANTS the terminal already shipped
 * (`terminal/terminalTheme.ts:12-21`), restated here as the foundation's own
 * answer so a style that sets none of them lands on today's terminal exactly.
 * `fontSize` is absent on purpose — see `ResolvedXtermOptions`.
 */
const DEFAULT_XTERM_OPTIONS: ResolvedXtermOptions = {
  fontFamily:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontWeight: 400,
  fontWeightBold: 700,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 5000,
  cursorStyle: 'block',
  padding: 0,
};

/** Stable (key-sorted) JSON, so the hash is a function of the VALUES only. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/** Key-sorted copy, so a resolved table serialises identically however it was built. */
function sortedTable(table: StyleTokenTable): StyleTokenTable {
  const out: StyleTokenTable = {};
  for (const key of (Object.keys(table) as StyleCssVar[]).sort()) out[key] = table[key]!;
  return out;
}

/**
 * THE RESOLVER (§3). Pure, synchronous, total — it has no failure mode. Every
 * problem it can find is a WARNING, because the one caller that matters runs it
 * before first paint and a throw there is a white screen.
 *
 * `builtins` is passed in rather than imported so a test can resolve against a
 * two-token fixture and a future preset catalogue needs no change here.
 */
export function resolveStyle(
  doc: StyleDoc,
  builtins: Readonly<Record<string, BuiltinStyle>>,
): ResolvedStyle {
  const warnings: StyleWarning[] = [];
  const foundation = builtins[doc.foundation];
  if (!foundation) {
    /* An unknown foundation is the one input that leaves nothing to resolve.
       It still must not throw, so it falls back to the first registered
       built-in and says so — a named wrong palette is debuggable; a blank
       screen is not. */
    const fallbackId = Object.keys(builtins)[0];
    const fallback = fallbackId ? builtins[fallbackId] : undefined;
    if (!fallback) {
      throw new Error('resolveStyle: no built-in styles registered');
    }
    warnings.push({
      code: 'invalid-token',
      layer: null,
      at: 'foundation',
      message: `unknown foundation "${doc.foundation}"; fell back to ${fallback.id}`,
    });
    const resolved = resolveStyle({ ...doc, foundation: fallback.id }, builtins);
    return { ...resolved, warnings: [...warnings, ...resolved.warnings] };
  }

  const layers = doc.layers ?? [];
  const main = applyLayers(foundation.tokens, layers, warnings, {
    skipRecolouring: false,
    collectWarnings: true,
  });
  resolveAliases(main.table, warnings, foundation.tokens);
  applyDerived(main.table, foundation.tokens, main.knobs);
  lintContrast(main.table, warnings);

  /* The always-dark pass. Warnings are NOT collected twice — they would be the
     same findings from the same layers, reported against a table the author
     never edited, and a warnings strip that says everything twice is a strip
     nobody reads. */
  let alwaysDarkCssVars: StyleTokenTable | null = null;
  if (main.chrome === 'dark') {
    const darkBase = builtins[foundation.darkSibling]?.tokens ?? foundation.tokens;
    const chromePass = applyLayers(darkBase, layers, warnings, {
      skipRecolouring: true,
      collectWarnings: false,
    });
    resolveAliases(chromePass.table, [], darkBase);
    applyDerived(chromePass.table, darkBase, chromePass.knobs);
    alwaysDarkCssVars = sortedTable(chromePass.table);
  }

  const cssVars = sortedTable(main.table);
  const xterm = {
    /* The xterm canvas lives inside the always-dark scope, so its colours come
       from THAT table when one exists — reading them off the main ramp would
       paint a light terminal inside a dark box the moment a light style shipped. */
    theme: buildXtermTheme(alwaysDarkCssVars ?? cssVars),
    options: { ...DEFAULT_XTERM_OPTIONS, ...main.xtermOverrides },
  };

  const paperRgb = toRgb(cssVars['--pn-paper']);
  const darkish = paperRgb ? relativeLuminance(paperRgb) < 0.5 : false;

  const hash = sha256Hex(
    UTF8.encode(stableStringify({ cssVars, alwaysDarkCssVars, xterm, chrome: main.chrome })),
  );

  return {
    foundation: foundation.id,
    builtinRevision: foundation.builtinRevision,
    cssVars,
    alwaysDarkCssVars,
    darkish,
    xterm,
    terminalChrome: main.chrome,
    warnings,
    hash,
  };
}

/**
 * The injected stylesheet's text (§3.1). Here rather than in the UI because the
 * CLI's `style resolve --css` and any future SSR path need the same bytes, and
 * two emitters of one cascade is the bug class §3 exists to close.
 *
 * THE ACTIVE RULE CLAIMS ONLY THE ROOTS WHOSE THEME AGREES WITH THE STYLE.
 * tokens.css decides a root's ramp like this: dark if the root, or ANY
 * ancestor, carries `data-theme="dark"`; light otherwise (`data-theme="light"`
 * forces nothing). Product roots take `data-theme` from the store (§3.2), so
 * they always agree with it. Review boards and dev harnesses stamp their own
 * theme, though — `SettingsBoard`'s light/dark pair side by side — and a rule on
 * every `.cv2-root` would paint both halves in one ramp. So the active rule
 * selects exactly the roots tokens.css would put in the derived theme, and a
 * root explicitly in the other theme falls through to tokens.css unchanged:
 *
 *   derived dark : `.cv2-root[data-theme="dark"]`, `[data-theme="dark"] .cv2-root`
 *                  — tokens.css's own dark selector, (0,2,0), later in head.
 *   derived light: `.cv2-root:not([data-theme="dark"]):not([data-theme="dark"] *)`
 *                  — every root tokens.css leaves light, (0,3,0).
 *
 * The always-dark rule comes second. Every always-dark scope also carries
 * `data-theme="dark"`, so the light rule never matches inside one; in the dark
 * case both rules are (0,2,0) and SOURCE ORDER decides — swap them and every
 * terminal takes the active ramp.
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
