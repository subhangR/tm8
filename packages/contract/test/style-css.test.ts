/**
 * The `css` sanitizer corpus (spec v8 §8.3, §14 "sanitiser corpus").
 *
 * The property under test is the one that matters for a security boundary:
 * whatever goes in, what comes out is ONLY re-emitted text that passed the
 * allow-lists, scoped under `.cv2-root`. Escapes are decoded before matching,
 * so an encoded `url(`, `@import` or brace is caught as what it decodes to.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_MAX_CSS_BYTES, decodeCssEscapes, sanitizeStyleCss } from '../src/index.js';

const run = (css: string) => sanitizeStyleCss(css);
const kept = (css: string) => run(css).css;

describe('decodeCssEscapes', () => {
  it('decodes hex escapes (with their optional trailing space) and char escapes', () => {
    expect(decodeCssEscapes('u\\72l(')).toBe('url(');
    expect(decodeCssEscapes('\\75 rl(')).toBe('url(');
    expect(decodeCssEscapes('\\40import')).toBe('@import');
    expect(decodeCssEscapes('a\\{b')).toBe('a{b');
    expect(decodeCssEscapes('\\0')).toBe('\uFFFD');
  });
});

describe('sanitizeStyleCss — kept, scoped and re-emitted', () => {
  it('prefixes every selector with .cv2-root and re-emits canonically', () => {
    expect(kept('.pn-chip,.pn-tag{color:red}')).toBe('.cv2-root .pn-chip, .cv2-root .pn-tag {\n  color: red;\n}\n');
  });

  it('leaves an already-scoped selector alone', () => {
    expect(kept('.cv2-root:hover .a { color: red }')).toBe('.cv2-root:hover .a {\n  color: red;\n}\n');
    expect(kept('.cv2-rootx { color: red }')).toBe('.cv2-root .cv2-rootx {\n  color: red;\n}\n');
  });

  it('keeps @media and @supports, scoped inside', () => {
    expect(kept('@media (max-width: 600px) { .a { color: red } }')).toBe(
      '@media (max-width: 600px) {\n  .cv2-root .a {\n    color: red;\n  }\n}\n',
    );
    expect(kept('@supports (color: oklch(0 0 0)) { .a { color: oklch(0.5 0.1 40) } }')).toContain(
      '.cv2-root .a {\n    color: oklch(0.5 0.1 40);',
    );
  });

  it('keeps allowed functions and !important', () => {
    expect(kept('.a { width: calc(100% - 2px); color: var(--pn-brand) !important }')).toBe(
      '.cv2-root .a {\n  width: calc(100% - 2px);\n  color: var(--pn-brand) !important;\n}\n',
    );
  });

  it('keeps empty content, a colour background and font smoothing', () => {
    expect(kept(".a::before { content: '' } .b { background: #fff; -webkit-font-smoothing: antialiased }")).toBe(
      ".cv2-root .a::before {\n  content: '';\n}\n.cv2-root .b {\n  background: #fff;\n  -webkit-font-smoothing: antialiased;\n}\n",
    );
  });

  it('ignores comments, including ones holding braces', () => {
    expect(kept('/* } { */ .a { color: red } /* x */')).toBe('.cv2-root .a {\n  color: red;\n}\n');
  });

  it('is idempotent on its own output', () => {
    const once = kept('@media print { .a { color: red } } .b { margin: 0 4px }')!;
    expect(kept(once)).toBe(once);
  });
});

describe('sanitizeStyleCss — refused', () => {
  it.each([
    ['plain url()', '.a { background: url(https://x/y.png) }'],
    ['url() spelt with a hex escape', '.a { background-color: u\\72l(x) }'],
    ['url() spelt with a spaced hex escape', '.a { background-color: \\75 rl(x) }'],
    ['image-set()', '.a { background-color: image-set("a.png" 1x) }'],
    ['attr()', '.a { color: attr(data-x) }'],
    ['expression()', '.a { width: expression(alert(1)) }'],
    ['javascript:', '.a { color: javascript:alert(1) }'],
    ['a function outside the allow-list', '.a { color: light-dark(red, blue) }'],
    ['var() of a non-token', '.a { color: var(--evil) }'],
    ['position', '.a { position: fixed }'],
    ['z-index', '.a { z-index: 9999 }'],
    ['transform', '.a { transform: translateX(10px) }'],
    ['display', '.a { display: none }'],
    ['pointer-events', '.a { pointer-events: none }'],
    ['filter', '.a { filter: blur(4px) }'],
    ['cursor', '.a { cursor: pointer }'],
    ['other -webkit-*', '.a { -webkit-text-fill-color: red }'],
    ['custom properties (they belong in vars)', '.a { --pn-paper: red }'],
    ['content with text', ".a::after { content: 'Verified' }"],
    ['a background image via keywords', '.a { background: red no-repeat }'],
    ['quotes outside fonts and content', '.a { color: "red" }'],
  ])('drops %s', (_, css) => {
    const r = run(css);
    expect(r.css).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.every((w) => w.code === 'css-dropped' && w.key === 'css')).toBe(true);
  });

  it.each([
    ['body', 'body { color: red }'],
    ['html', 'html .a { color: red }'],
    [':root', ':root { color: red }'],
    ['dialog', '.a dialog { color: red }'],
    ['[data-shell]', "[data-shell='mobile'] .a { color: red }"],
    ['.auth-*', '.auth-card { color: red }'],
    ['.account-menu', '.account-menu .row { color: red }'],
    ['a sibling of the app root', '.cv2-root ~ div { color: red }'],
    ['an escaped brace in a selector', '.a\\7b { color: red }'],
    ['too many compounds', '.a .b .c .d .e .f .g .h .i { color: red }'],
  ])('drops a selector reaching %s', (_, css) => {
    expect(kept(css)).toBeNull();
  });

  it.each([
    ['@import', '@import url(x.css);'],
    ['@import spelt with an escape', '@\\69mport "x.css";'],
    ['@font-face', '@font-face { font-family: x; src: url(x) }'],
    ['@keyframes', '@keyframes k { from { color: red } }'],
    ['@namespace', '@namespace svg url(x);'],
  ])('drops the at-rule %s', (_, css) => {
    expect(kept(css)).toBeNull();
  });

  it('drops a rule with nested rules inside it', () => {
    expect(kept('.a { .b { color: red } }')).toBeNull();
  });

  it('drops the whole field when it does not parse', () => {
    for (const css of ['.a { color: red', '.a { color: red } }', '.a { font-family: "x }', '/* never closed']) {
      const r = run(css);
      expect(r.css).toBeNull();
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('drops the whole field over 16 KiB', () => {
    const r = run(`.a { color: red }${' '.repeat(STYLE_MAX_CSS_BYTES)}`);
    expect(r.css).toBeNull();
    expect(r.warnings[0]!.message).toContain('larger than');
  });

  it('never lets markup through', () => {
    const r = run('.a { color: red } </style><script>alert(1)</script>');
    expect(r.css).toBe('.cv2-root .a {\n  color: red;\n}\n');
    expect(r.css).not.toContain('<');
  });

  it('keeps the good declarations of a rule and drops the bad ones', () => {
    const r = run('.a { color: red; position: absolute; padding: 4px }');
    expect(r.css).toBe('.cv2-root .a {\n  color: red;\n  padding: 4px;\n}\n');
    expect(r.warnings).toHaveLength(1);
  });

  it('caps rules at 200 and declarations at 20', () => {
    const rules = Array.from({ length: 201 }, (_, i) => `.r${i} { color: red }`).join('\n');
    const r1 = run(rules);
    expect(r1.css!.match(/\{/g)).toHaveLength(200);
    expect(r1.warnings).toHaveLength(1);
    const decls = Array.from({ length: 21 }, (_, i) => `margin-top: ${i}px`).join('; ');
    const r2 = run(`.a { ${decls} }`);
    expect(r2.css!.match(/margin-top/g)).toHaveLength(20);
  });

  it('treats empty, null and non-string input as absent', () => {
    expect(run('')).toEqual({ css: null, warnings: [] });
    expect(sanitizeStyleCss(null)).toEqual({ css: null, warnings: [] });
    expect(sanitizeStyleCss(42).css).toBeNull();
  });
});
