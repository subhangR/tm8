import type { SafeParseReturnType, ZodErrorMap, ZodTypeAny, input, output } from 'zod';

/**
 * A zod `safeParse` that stops once a value has raised more than `budget` issues (independent review
 * addendum 2, C4).
 *
 * Why: zod before 4.6.6 (GHSA-mrhx-c7xc-m3w5, high) keeps one issue object for every failing element
 * of a collection, with no cap and no early stop. A `.max()` adds its own issue first and then still
 * checks every element. A union that fails also builds a ZodError, with a stack trace, for each of its
 * options. The vault runs zod 3.25.76 (bun.lock). Measured on 21 Nov 2026, within the 128 KiB body cap:
 * - one agent `vault.callApi` body for the Anthropic messages operation raised 173,378 issues, held the
 *   broker's event loop for 1.5 to 1.9 s and kept 153 MiB of issues;
 * - one `vault.imports.commit` body raised 131,064 issues in 0.3 to 0.6 s.
 * Upgrading zod is follow-up work across the monorepo. Until then the vault bounds every parse of
 * caller data itself.
 *
 * How: the parse gets a contextual error map that counts every issue zod raises. Once the count passes
 * `budget`, the map throws. zod 3's `safeParse` has no try/catch, so the throw ends the walk at once.
 * The count and the map belong to one call, so nothing is left behind.
 *
 * Two limits, each handled where a budget is chosen:
 * - The map also counts issues of union options that a later option makes moot. So a value that would
 *   pass is refused if its union trials exceed the budget. Each call site states why its budget is above
 *   every passing value's trials, and a test pins it.
 * - An issue built with an explicit message (`.refine(fn, 'text')`, `.regex(re, 'text')`) skips every
 *   error map, so it is not counted. In the bounded schemas, such checks sit on objects, or under a
 *   collection with a maximum length, so the schema itself bounds how many there can be.
 */
export type BoundedParseResult<S extends ZodTypeAny> =
  | SafeParseReturnType<input<S>, output<S>>
  | { success: false; overBudget: true };

const OVER_BUDGET = Symbol('vault: zod issue budget exceeded');

export function boundedSafeParse<S extends ZodTypeAny>(schema: S, value: unknown, budget: number): BoundedParseResult<S> {
  if (!Number.isInteger(budget) || budget < 0) throw new TypeError('vault: invalid zod issue budget');
  let raised = 0;
  const errorMap: ZodErrorMap = (_issue, context) => {
    raised += 1;
    if (raised > budget) throw OVER_BUDGET;
    return { message: context.defaultError };
  };
  try {
    return schema.safeParse(value, { errorMap });
  } catch (error) {
    if (error === OVER_BUDGET) return { success: false, overBudget: true };
    throw error;
  }
}
