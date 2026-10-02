/**
 * THE VARIABLE REGISTRY (spec v8 §2) and the per-key grammar (§8.2).
 *
 * Every `--pn-*` key a style may set is one entry in `style-registry.json`:
 * its kind (which grammar validates it), its group (where the editor shows
 * it), its range and unit (what a value is clamped to), whether it is a
 * SURFACE key (one that flips between Atelier Light and Dark, and so is
 * replaced by the dark sibling's value inside always-dark scopes), and where
 * the terminal reads it (`xtermSink`).
 *
 * The JSON is hand-maintained data. `packages/tm8-ui/src/styles/builtins-parity.test.ts`
 * fails when a key is in `tokens.css`/`canvas-extra.css` but not here or the
 * reverse, and when `surface` disagrees with what actually flips — so a
 * release that adds a variable touches CSS, registry and built-ins in one
 * commit (§10.4).
 *
 * ONE GRAMMAR, THREE CALLERS. The server validates on write, the client on
 * apply and the CLI on `style resolve`; all three call `validateStyleVar`.
 */
import registryJson from './style-registry.json' with { type: 'json' };

export type StyleVarKind =
  | 'colour'
  | 'derived'
  | 'length'
  | 'ratio'
  | 'number'
  | 'font'
  | 'shadow'
  | 'easing'
  | 'duration'
  | 'enum';

export type StyleVarGroup =
  | 'surface'
  | 'status'
  | 'type'
  | 'scale'
  | 'spacing'
  | 'radius'
  | 'elevation'
  | 'motion'
  | 'terminal-colour'
  | 'terminal-option'
  | 'extras';

export interface StyleRegistryEntry {
  key: `--pn-${string}`;
  kind: StyleVarKind;
  group: StyleVarGroup;
  label: string;
  /** Clamp range, in `unit`. Absent for kinds that are not numeric. */
  range?: { min: number; max: number };
  unit?: 'px' | 'em' | 'ms';
  /**
   * `enum`: the accepted values. `number`: extra KEYWORDS accepted besides a
   * number (`--pn-term-font-size` accepts `auto`).
   */
  values?: readonly string[];
  /** Flips between light and dark; replaced by the dark sibling in always-dark scopes. */
  surface: boolean;
  /** Where xterm reads it: `theme.<ITheme key>` or `option.<ITerminalOptions key>`. */
  xtermSink?: string;
}

export interface StyleRegistry {
  registryVersion: number;
  entries: readonly StyleRegistryEntry[];
}

/* The JSON's inferred type is structurally right but nominally wide (`string`
   where the union types are). One cast at the boundary, named. */
export const STYLE_REGISTRY = registryJson as unknown as StyleRegistry;

export function registryByKey(registry: StyleRegistry): ReadonlyMap<string, StyleRegistryEntry> {
  return new Map(registry.entries.map((e) => [e.key, e]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-key grammar (§8.2)
// ─────────────────────────────────────────────────────────────────────────────

export type StyleVarCheck =
  | { ok: true; value: string }
  | { ok: true; value: string; clamped: { from: string; to: string } }
  | { ok: false; reason: string };

/** Anything that can fetch, execute, or break out of a declaration (§8.2 "everything"). */
const BANNED = [
  /url\s*\(/i,
  /image\s*\(/i,
  /image-set\s*\(/i,
  /src\s*\(/i,
  /attr\s*\(/i,
  /element\s*\(/i,
  /expression\s*\(/i,
  /javascript:/i,
  /@import/i,
  /[;{}<]/,
  /\\(?!["'])/,
];

const MAX_VALUE_LENGTH: Partial<Record<StyleVarKind, number>> = {
  colour: 128,
  shadow: 256,
  font: 512,
};

export const STYLE_MAX_VAR_LENGTH = 512;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** CSS Color 4 named colours, lower-cased. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred ' +
    'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink ' +
    'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold ' +
    'goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
    'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey ' +
    'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
    'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow ' +
    'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen ' +
    'transparent currentcolor'
  ).split(' '),
);

const COLOUR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch', 'color']);
const COLOUR_SPACES = /^in\s+(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|oklab|xyz|xyz-d50|xyz-d65|hsl|hwb|lch|oklch)(\s+(shorter|longer|increasing|decreasing)\s+hue)?$/i;

/** Split on `sep` at paren depth 0. */
export function splitTopLevel(text: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return [text]; // unbalanced: let the caller's grammar refuse it
    const isSep = sep === ',' ? ch === ',' : /\s/.test(ch);
    if (isSep && depth === 0) {
      if (current.trim() || sep === ',') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() || sep === ',') out.push(current.trim());
  return sep === ' ' ? out.filter(Boolean) : out;
}

/** `var(--pn-x)` exactly, returning the key. */
export function varReference(value: string): string | null {
  const m = /^var\(\s*(--pn-[a-z0-9-]{1,64})\s*\)$/.exec(value.trim());
  return m?.[1] ?? null;
}

/**
 * A colour value (§8.2 colour row). `colourKeys` is the set a `var()` may
 * name: only colour keys, so a colour can never be pointed at a length.
 */
export function isColour(value: string, colourKeys: ReadonlySet<string>): boolean {
  const v = value.trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
  if (NAMED_COLOURS.has(v.toLowerCase())) return true;
  const ref = varReference(v);
  if (ref) return colourKeys.has(ref);
  const fn = /^([a-z-]+)\((.*)\)$/is.exec(v);
  if (!fn?.[1] || fn[2] === undefined) return false;
  const name = fn[1].toLowerCase();
  const body = fn[2];
  if (COLOUR_FUNCTIONS.has(name)) {
    // Numbers, percentages, angles, `none`, `/`, a colour-space ident for color(),
    // and var(--pn-*) channels. No nested functions other than var/calc.
    const stripped = body.replace(/var\(\s*--pn-[a-z0-9-]{1,64}\s*\)/g, '0').replace(/calc\([0-9.%+\-*/\s]*\)/g, '0');
    return /^[0-9a-z.%+\-\s,/]*$/i.test(stripped) && !/[a-z]{2,}\(/i.test(stripped);
  }
  if (name === 'color-mix') {
    const parts = splitTopLevel(body, ',');
    if (parts.length !== 3 || !COLOUR_SPACES.test(parts[0] ?? '')) return false;
    return parts.slice(1).every((p) => {
      const tokens = splitTopLevel(p, ' ');
      const pct = tokens.length === 2 ? tokens[1] : undefined;
      if (tokens.length < 1 || tokens.length > 2) return false;
      if (pct !== undefined && !/^(\d+\.?\d*|\.\d+)%$/.test(pct)) return false;
      return isColour(tokens[0]!, colourKeys);
    });
  }
  return false;
}

function isLength(token: string): boolean {
  return token === '0' || /^[+-]?(\d+\.?\d*|\.\d+)(px|rem|em)$/.test(token);
}

function isFont(value: string): boolean {
  const parts = splitTopLevel(value, ',');
  if (parts.length === 0) return false;
  return parts.every(
    (p) =>
      /^"[^"\\]{1,128}"$/.test(p) ||
      /^'[^'\\]{1,128}'$/.test(p) ||
      /^-?[a-z_][a-z0-9_-]*(\s+-?[a-z_][a-z0-9_-]*)*$/i.test(p),
  );
}

function isShadow(value: string, colourKeys: ReadonlySet<string>): boolean {
  if (value.trim() === 'none') return true;
  return splitTopLevel(value, ',').every((group) => {
    const tokens = splitTopLevel(group, ' ');
    let i = 0;
    if (tokens[i] === 'inset') i += 1;
    let lengths = 0;
    while (i < tokens.length && isLength(tokens[i]!)) {
      lengths += 1;
      i += 1;
    }
    if (lengths < 2 || lengths > 4) return false;
    if (i < tokens.length && isColour(tokens[i]!, colourKeys)) i += 1;
    if (i < tokens.length && tokens[i] === 'inset') i += 1;
    return i === tokens.length;
  });
}

function isEasing(value: string): boolean {
  const v = value.trim();
  if (/^(ease|linear|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(v)) return true;
  const n = '\\s*[+-]?(\\d+\\.?\\d*|\\.\\d+)\\s*';
  if (new RegExp(`^cubic-bezier\\((${n},){3}${n}\\)$`).test(v)) return true;
  return /^steps\(\s*\d+\s*(,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.test(v);
}

/** Six decimals at most, no float noise, no trailing zeros. */
export function cssNumber(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

function clampTo(
  n: number,
  range: { min: number; max: number } | undefined,
  render: (n: number) => string,
  original: string,
): StyleVarCheck {
  if (!range || (n >= range.min && n <= range.max)) return { ok: true, value: render(n) };
  const c = Math.min(range.max, Math.max(range.min, n));
  return { ok: true, value: render(c), clamped: { from: original, to: render(c) } };
}

/**
 * Validate (and clamp) ONE value against its registry entry. Pure; never
 * throws. A failure carries the reason the warning will show the author.
 */
export function validateStyleVar(
  entry: StyleRegistryEntry,
  raw: unknown,
  colourKeys: ReadonlySet<string>,
): StyleVarCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'value must be a string' };
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'value is empty' };
  const max = MAX_VALUE_LENGTH[entry.kind] ?? STYLE_MAX_VAR_LENGTH;
  if (value.length > max) return { ok: false, reason: `value is longer than ${max} characters` };
  for (const ban of BANNED) {
    if (ban.test(value)) return { ok: false, reason: `value contains a forbidden construct (${ban.source})` };
  }

  switch (entry.kind) {
    case 'derived':
      return { ok: false, reason: `${entry.key} is derived and cannot be set` };
    case 'colour':
      return isColour(value, colourKeys) ? { ok: true, value } : { ok: false, reason: 'not a colour' };
    case 'font':
      return isFont(value) ? { ok: true, value } : { ok: false, reason: 'not a font list' };
    case 'shadow':
      return isShadow(value, colourKeys) ? { ok: true, value } : { ok: false, reason: 'not a shadow' };
    case 'easing':
      return isEasing(value) ? { ok: true, value } : { ok: false, reason: 'not an easing' };
    case 'enum':
      return entry.values?.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: `expected one of ${(entry.values ?? []).join(', ')}` };
    case 'duration': {
      const m = /^(\d+\.?\d*|\.\d+)(ms|s)$/.exec(value);
      if (!m?.[1]) return { ok: false, reason: 'not a duration (ms or s)' };
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      return clampTo(ms, entry.range, (n) => `${cssNumber(Math.round(n))}ms`, value);
    }
    case 'ratio':
    case 'number': {
      if (entry.values?.includes(value)) return { ok: true, value };
      const unit = entry.unit ?? '';
      const bare = unit && value.endsWith(unit) ? value.slice(0, -unit.length) : value;
      if (!NUMBER.test(bare)) return { ok: false, reason: 'not a number' };
      return clampTo(Number(bare), entry.range, cssNumber, value);
    }
    case 'length': {
      if (value === '0') return { ok: true, value };
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/.exec(value);
      if (!m?.[1] || !m[2]) return { ok: false, reason: 'not a length (px, rem or em)' };
      const n = Number(m[1]);
      const unit = m[2];
      /* Ranges are in the entry's unit. A px-ranged key given in rem is
         compared at 16px per rem and, if clamped, written back in px — a
         clamp has to land on a value the range was written in. `em` on a
         px-ranged key is relative to an unknown font size, so only rem
         converts and em is refused there. */
      if (entry.unit === 'em') {
        if (unit !== 'em') return { ok: false, reason: 'expected an em length' };
        return clampTo(n, entry.range, (x) => `${cssNumber(x)}em`, value);
      }
      if (unit === 'em') return { ok: false, reason: 'expected px or rem' };
      const px = unit === 'rem' ? n * 16 : n;
      const check = clampTo(px, entry.range, (x) => `${cssNumber(x)}px`, value);
      return 'clamped' in check ? check : { ok: true, value };
    }
  }
}
