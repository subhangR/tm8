/**
 * CSS SPECIFICITY, AS ARITHMETIC — the thing a jsdom suite cannot check.
 *
 * jsdom applies no cascade. So every component test in this repo renders a
 * correctly-placed element and a wrongly-placed one identically, and a visual
 * ruling can ship as a no-op with a fully green suite. That is not
 * hypothetical: it happened twice in one day on two different surfaces.
 *
 * THE FAILURE SHAPE, because it will recur. A surface renders through
 * `kit/Markdown`, which always emits `md-root`, inside the app shell, which is
 * always `.cv2-root`. `kit/markdown.css` styles `.cv2-root .md-root` at (0,2,0)
 * with a serif family at document size. A bubble class alone is (0,1,0) and
 * loses, so the surface renders in the document serif — Chat Home shipped that
 * way. The fix is to qualify the base rule to `.cv2-root .md-root.<bubble>`,
 * which is (0,3,0) — and THAT is where the second bug comes from, because the
 * sidedness rule that has to override it (`.<turn>[data-self] .<bubble>`) is
 * ALSO (0,3,0). Equal specificity means source order decides, the base rule is
 * usually declared later, and the turn silently never moves.
 *
 * So the invariant worth asserting is not "this rule exists" but "this rule
 * WINS", and it must win by specificity rather than by position — a rule that
 * wins on order is one line-move away from losing.
 *
 * Deliberately not a general CSS parser. It reads the selector shapes this
 * repo's stylesheets actually use — classes, attribute selectors, descendant
 * combinators — and anything else should be treated as out of scope rather
 * than silently scored zero.
 */

/** `(ids, classes, elements)` — CSS specificity, most significant first. */
export type Specificity = readonly [number, number, number];

export function specificity(selector: string): Specificity {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/\[[^\]]+\]/g) ?? []).length;
  const elements = (selector.match(/(^|[\s>+~])[a-z]+[\s.[:]/g) ?? []).length;
  return [ids, classes, elements];
}

/** Collapses a specificity to a single comparable number. */
export function specificityRank(s: Specificity): number {
  return s[0] * 10_000 + s[1] * 100 + s[2];
}

export interface CssRule {
  selector: string;
  declarations: string;
}

/** Every top-level rule in a stylesheet, comments stripped. At-rule blocks are
 *  skipped rather than half-read — see the module note on scope. */
export function rules(css: string): CssRule[] {
  const out: CssRule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (selector.length === 0 || selector.startsWith('@')) continue;
    out.push({ selector, declarations: match[2] ?? '' });
  }
  return out;
}

/** Every selector that mentions `className`. */
export function selectorsTargeting(css: string, className: string): string[] {
  return rules(css)
    .map((rule) => rule.selector)
    .filter((selector) => selector.includes(className));
}

export interface WeakOverride {
  selector: string;
  specificity: Specificity;
}

/**
 * THE ASSERTION THAT MATTERS. Given the base rule for a bubble/body class,
 * returns every OTHER rule on that class which does not strictly outrank it —
 * i.e. every rule whose effect depends on source order.
 *
 * A tie is reported even when the stylesheet happens to render correctly
 * today, because "correct" then means "nobody has moved a rule yet".
 *
 * Usage:
 *   expect(weakOverridesOf(css, '.cv2-root .md-root.tch-user-body',
 *                          'tch-user-body')).toEqual([]);
 */
export function weakOverridesOf(css: string, baseSelector: string, className: string): WeakOverride[] {
  const base = specificityRank(specificity(baseSelector));
  return selectorsTargeting(css, className)
    .filter((selector) => selector !== baseSelector)
    .map((selector) => ({ selector, specificity: specificity(selector) }))
    .filter((entry) => specificityRank(entry.specificity) <= base);
}
