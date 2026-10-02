/**
 * THE `css` SANITISER (spec v8 §8.3).
 *
 * A style's optional extra CSS runs in other people's browsers (space styles,
 * after opt-in), so this is a security boundary, not a linter. Its shape:
 *
 *   parse → decode escapes → allow-list every at-rule, selector, property and
 *   function → RE-EMIT from the parsed structure.
 *
 * RE-EMISSION IS THE DEFENCE. Nothing from the input is copied through as
 * raw text: every selector and value is written back out from its DECODED
 * form, after that decoded form passed a character allow-list that contains
 * no backslash, brace, semicolon, `<` or `@`. So a parser differential between
 * this scanner and the browser's cannot smuggle anything — the browser only
 * ever sees text this function produced. Decoding before matching is what
 * closes `u\72l(` (= `url(`), `\40import`, and escaped braces.
 *
 * Why not postcss (the spec's suggestion): `@tm8/contract` runs in the UI,
 * the server and the CLI and depends on zod alone. A dependency here would
 * ship to all three, and postcss's job (faithful round-tripping, including
 * every escape) is the opposite of what a sanitiser wants. The grammar this
 * accepts is small enough to scan directly.
 *
 * The client re-runs this before injecting, so it never trusts a stored
 * string (§8.3 OUT).
 */
import { splitTopLevel } from './style-registry.js';
import type { StyleWarning } from './style.js';

export const STYLE_MAX_CSS_BYTES = 16 * 1024;
export const STYLE_CSS_MAX_RULES = 200;
export const STYLE_CSS_MAX_DECLARATIONS = 20;
export const STYLE_CSS_MAX_COMPOUNDS = 8;
const MAX_AT_RULE_DEPTH = 3;

export interface SanitizedStyleCss {
  /** Scoped, re-emitted CSS; null when absent or nothing survived. */
  css: string | null;
  /** One `css-dropped` warning per thing removed. */
  warnings: StyleWarning[];
}

/** Exact names, or prefixes where the entry ends in `*`. */
const ALLOWED_PROPERTIES = [
  'color', 'background-color', 'background', 'border*', 'outline*', 'box-shadow', 'text-shadow', 'opacity',
  'font*', 'line-height', 'letter-spacing', 'text-transform', 'text-decoration*', 'font-variant*',
  'font-feature-settings', 'padding*', 'margin*', 'gap', 'row-gap', 'column-gap', 'width', 'height',
  'min-*', 'max-*', 'transition*', 'animation-duration', 'caret-color', 'accent-color', 'scrollbar-color',
  'content', '-webkit-font-smoothing',
];

const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch', 'color', 'color-mix',
  'calc', 'min', 'max', 'clamp', 'var', 'cubic-bezier', 'steps',
]);

/** Selectors that would reach outside the app shell or into trust-bearing UI. */
const FORBIDDEN_SELECTOR = [
  /(^|[\s>+~(,])(html|body|dialog)(?![a-z0-9_-])/i,
  /:root/i,
  /\[\s*data-shell/i,
  /\.auth-/i,
  /\.account-menu/i,
  /:host/i,
  /::?part\(/i,
];

/** Decoded selector text may contain only these. No backslash, brace, `;`, `<`, `@`. */
const SELECTOR_CHARS = /^[a-zA-Z0-9_\-.#:[\]="' >+~(),*^$|%]+$/;
/** Decoded value text may contain only these. */
const VALUE_CHARS = /^[a-zA-Z0-9_\-.#%,()/*+ !"']+$/;
/** Decoded at-rule prelude. */
const PRELUDE_CHARS = /^[a-zA-Z0-9_\-.:()%, /<>=]+$/;
const FORBIDDEN_TEXT = /(url|image|image-set|src|attr|element|expression)\s*\(|javascript:|@import/i;

const warn = (warnings: StyleWarning[], message: string): void => {
  warnings.push({ code: 'css-dropped', key: 'css', message });
};

// ─────────────────────────────────────────────────────────────────────────────
// Escapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSS Syntax §4.3.7: `\` + 1-6 hex digits (+ one optional whitespace) is a
 * code point; `\` + any other character is that character; `\` + newline is
 * removed. Applied to whole selector / value / prelude text before ANY check.
 */
export function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g, (_, hex, nl, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    }
    if (nl) return '';
    return ch ?? '';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure
// ─────────────────────────────────────────────────────────────────────────────

interface Block {
  /** Raw text before `{` (or before `;` for a blockless statement). */
  prelude: string;
  /** Raw text between the braces; null for a blockless statement. */
  body: string | null;
}

/**
 * Split a stylesheet (or an at-rule body) into top-level statements. Tracks
 * strings and escapes so an escaped or quoted brace is not structure.
 * Returns null on unbalanced input — the caller drops the whole field.
 */
function statements(text: string): Block[] | null {
  const out: Block[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch === ';') {
      const prelude = text.slice(start, i).trim();
      if (prelude) out.push({ prelude, body: null });
      start = i + 1;
      i += 1;
      continue;
    }
    if (ch === '}') return null;
    if (ch === '{') {
      const close = matchBrace(text, i);
      if (close < 0) return null;
      out.push({ prelude: text.slice(start, i).trim(), body: text.slice(i + 1, close) });
      i = close + 1;
      start = i;
      continue;
    }
    i += 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ prelude: tail, body: null });
  return out;
}

function skipString(text: string, open: number): number {
  const q = text[open];
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === q) return i + 1;
    if (text[i] === '\n') return -1;
    i += 1;
  }
  return -1;
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Remove comments outside strings. Null when a comment never closes. */
function stripComments(text: string): string | null {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      if (end < 0) return null;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return null;
      out += ' ';
      i = close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Declarations of a rule body, split on top-level `;`. */
function declarations(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '\\') {
      current += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(body, i);
      if (end < 0) return [body]; // the per-declaration check will refuse it
      current += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += ch;
    i += 1;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

function propertyAllowed(name: string): boolean {
  return ALLOWED_PROPERTIES.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

function functionsAllowed(value: string): boolean {
  for (const m of value.matchAll(/([a-zA-Z-]+)\s*\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(m[1]!.toLowerCase())) return false;
  }
  // A bare `(` not preceded by a name is a grouping paren only inside calc etc.
  for (const m of value.matchAll(/var\(\s*([^),\s]+)/g)) {
    if (!/^--pn-[a-z0-9-]{1,64}$/.test(m[1]!)) return false;
  }
  return true;
}

/** Returns the scoped selector, or a reason it was refused. */
function scopeSelector(raw: string): { ok: true; selector: string } | { ok: false; reason: string } {
  const selector = decodeCssEscapes(raw).replace(/\s+/g, ' ').trim();
  if (!selector) return { ok: false, reason: 'empty selector' };
  if (!SELECTOR_CHARS.test(selector)) return { ok: false, reason: `selector "${selector}" has forbidden characters` };
  if (FORBIDDEN_TEXT.test(selector)) return { ok: false, reason: `selector "${selector}" names a forbidden function` };
  const parts = splitTopLevel(selector, ',');
  const scoped: string[] = [];
  for (const part of parts) {
    if (!part) return { ok: false, reason: 'empty selector in a list' };
    for (const bad of FORBIDDEN_SELECTOR) {
      if (bad.test(` ${part}`)) return { ok: false, reason: `selector "${part}" targets UI outside a style's reach` };
    }
    const compounds = part.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    if (compounds.length > STYLE_CSS_MAX_COMPOUNDS) {
      return { ok: false, reason: `selector "${part}" has more than ${STYLE_CSS_MAX_COMPOUNDS} compounds` };
    }
    if (/^\.cv2-root(?![a-zA-Z0-9_-])/.test(part)) {
      /* Already scoped. A sibling combinator straight after the root would
         select OUTSIDE it, which is the one way an unprefixed selector escapes. */
      if (/^\.cv2-root[^\s>+~]*\s*[+~]/.test(part)) {
        return { ok: false, reason: `selector "${part}" reaches a sibling of the app root` };
      }
      scoped.push(part);
    } else {
      scoped.push(`.cv2-root ${part}`);
    }
  }
  return { ok: true, selector: scoped.join(', ') };
}

function checkDeclaration(raw: string): { ok: true; decl: string } | { ok: false; reason: string } {
  const colon = raw.indexOf(':');
  if (colon < 1) return { ok: false, reason: `"${raw}" is not a declaration` };
  const name = decodeCssEscapes(raw.slice(0, colon)).trim().toLowerCase();
  let value = decodeCssEscapes(raw.slice(colon + 1)).replace(/\s+/g, ' ').trim();
  if (!/^-?[a-z][a-z0-9-]*$/.test(name)) return { ok: false, reason: `property "${name}" is not a plain name` };
  if (name.startsWith('--')) return { ok: false, reason: `custom property ${name} belongs in vars, not css` };
  if (!propertyAllowed(name)) return { ok: false, reason: `property ${name} is not allowed` };
  if (!value) return { ok: false, reason: `${name} has no value` };

  let important = '';
  const imp = /\s*!\s*important$/i.exec(value);
  if (imp) {
    important = ' !important';
    value = value.slice(0, imp.index).trim();
  }
  if (!VALUE_CHARS.test(value) || value.includes('!')) {
    return { ok: false, reason: `${name} value has forbidden characters` };
  }
  if (FORBIDDEN_TEXT.test(value)) return { ok: false, reason: `${name} value names a forbidden function` };
  if (!functionsAllowed(value)) return { ok: false, reason: `${name} value uses a function outside the allow-list` };
  // Quotes are only meaningful in font families and `content`; balanced, plain.
  if (/["']/.test(value) && !(/^font(-family)?$/.test(name) || name === 'content')) {
    return { ok: false, reason: `${name} value may not contain quotes` };
  }
  for (const s of value.matchAll(/(["'])(.*?)\1/g)) {
    if (/["'\\]/.test(s[2]!)) return { ok: false, reason: `${name} value has a malformed string` };
  }
  if ((value.match(/["']/g)?.length ?? 0) % 2 !== 0) return { ok: false, reason: `${name} value has an unclosed string` };
  if (name === 'content' && !/^(none|''|"")$/.test(value)) {
    return { ok: false, reason: 'content may only be none or an empty string' };
  }
  if (name === 'background' && /\b(repeat|no-repeat|cover|contain|fixed|scroll)\b/i.test(value)) {
    return { ok: false, reason: 'background may only set a colour' };
  }
  return { ok: true, decl: `${name}: ${value}${important};` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────────────────────────────────────

interface WalkState {
  rules: number;
  warnings: StyleWarning[];
}

function walk(blocks: Block[], depth: number, state: WalkState, indent: string): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.prelude.startsWith('@') || decodeCssEscapes(block.prelude).trim().startsWith('@')) {
      const prelude = decodeCssEscapes(block.prelude).replace(/\s+/g, ' ').trim();
      const name = /^@([a-zA-Z-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if ((name !== 'media' && name !== 'supports') || block.body === null) {
        warn(state.warnings, `@${name || '?'} is not allowed; only @media and @supports`);
        continue;
      }
      if (depth >= MAX_AT_RULE_DEPTH) {
        warn(state.warnings, `@${name} nested deeper than ${MAX_AT_RULE_DEPTH}`);
        continue;
      }
      const condition = prelude.slice(name.length + 1).trim();
      if (!condition || !PRELUDE_CHARS.test(condition) || FORBIDDEN_TEXT.test(condition)) {
        warn(state.warnings, `@${name} condition "${condition}" is not allowed`);
        continue;
      }
      const inner = statements(block.body);
      if (!inner) {
        warn(state.warnings, `@${name} body does not parse`);
        continue;
      }
      const body = walk(inner, depth + 1, state, `${indent}  `);
      if (body.length) out.push(`${indent}@${name} ${condition} {\n${body.join('\n')}\n${indent}}`);
      continue;
    }

    if (block.body === null) {
      warn(state.warnings, `stray text "${block.prelude.slice(0, 40)}" outside a rule`);
      continue;
    }
    if (state.rules >= STYLE_CSS_MAX_RULES) {
      warn(state.warnings, `more than ${STYLE_CSS_MAX_RULES} rules; the rest were dropped`);
      break;
    }
    const sel = scopeSelector(block.prelude);
    if (!sel.ok) {
      warn(state.warnings, sel.reason);
      continue;
    }
    if (/[{}]/.test(block.body.replace(/\\[\s\S]|(["'])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, ''))) {
      warn(state.warnings, `nested rules inside "${sel.selector}" are not allowed`);
      continue;
    }
    const decls: string[] = [];
    for (const raw of declarations(block.body)) {
      if (decls.length >= STYLE_CSS_MAX_DECLARATIONS) {
        warn(state.warnings, `more than ${STYLE_CSS_MAX_DECLARATIONS} declarations in "${sel.selector}"; the rest were dropped`);
        break;
      }
      const d = checkDeclaration(raw);
      if (d.ok) decls.push(`${indent}  ${d.decl}`);
      else warn(state.warnings, d.reason);
    }
    if (!decls.length) continue;
    state.rules += 1;
    out.push(`${indent}${sel.selector} {\n${decls.join('\n')}\n${indent}}`);
  }
  return out;
}

/**
 * Sanitise a style's extra CSS. Pure, total, never throws. Over-size or
 * unparseable input drops the WHOLE field (one warning); otherwise each
 * refused at-rule, rule or declaration is dropped on its own with a warning.
 */
export function sanitizeStyleCss(css: unknown): SanitizedStyleCss {
  const warnings: StyleWarning[] = [];
  if (typeof css !== 'string' || !css.trim()) {
    if (css !== null && css !== undefined && typeof css !== 'string') warn(warnings, 'css must be a string; dropped');
    return { css: null, warnings };
  }
  if (new TextEncoder().encode(css).length > STYLE_MAX_CSS_BYTES) {
    warn(warnings, `css is larger than ${STYLE_MAX_CSS_BYTES} bytes; dropped whole`);
    return { css: null, warnings };
  }
  const text = stripComments(css);
  const blocks = text === null ? null : statements(text);
  if (!blocks) {
    warn(warnings, 'css does not parse (unbalanced brace, string or comment); dropped whole');
    return { css: null, warnings };
  }
  const out = walk(blocks, 0, { rules: 0, warnings }, '');
  return { css: out.length ? `${out.join('\n')}\n` : null, warnings };
}
