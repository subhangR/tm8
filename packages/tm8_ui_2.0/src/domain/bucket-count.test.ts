/**
 * A LIFECYCLE BUCKET MAY NOT BE LARGER THAN ITS UNIVERSE.
 *
 * Owner, 2026-08-31, reported on every entity kind, with a screenshot of a task
 * list header reading `To Do 898 · In Progress 0 · Done 0 · Cancelled 0` over a
 * space holding 466 tasks.
 *
 * THE COUNTS ARE CORRECT ON THE DEPLOYED BUILD TODAY — intercepting the four
 * category reads gives 204 · 142 · 113 · 7, summing to 466 exactly — so this
 * file does not pin a live repair. It pins the MECHANISM that can produce the
 * reported shape, which is still in the code and would still produce it:
 *
 *   `countLabel(shown, page)` answers with the server's total when there is one
 *   and with `shown` when there is not. `shown` is the length of the client's
 *   own row array for that filter — page reads PLUS whatever the event stream
 *   projected into that cache key. Nothing on that path is bounded by how many
 *   entities exist, so a tab whose total has not landed can render any number
 *   at all, while its neighbours, holding neither a total nor cached rows,
 *   render a confident `0`.
 *
 * Three zeros and one impossible number is exactly that shape.
 *
 * These cases are the assertion the coordinator asked for: in the model, not in
 * a comment. They are also the reason this lives in `domain/` rather than in
 * the panel — the rule is about what a count MEANS, and two surfaces must not
 * each carry their own copy of it.
 */
import { describe, expect, it } from 'vitest';
import { bucketCountLabel, countLabel } from './types';

const page = (over: { total?: number; hasMore?: boolean }) =>
  ({ hasMore: false, ...over }) as Parameters<typeof bucketCountLabel>[1];

describe('bucketCountLabel', () => {
  it('renders the server’s own total for the bucket', () => {
    expect(bucketCountLabel(50, page({ total: 204 }), 466)).toBe('204');
  });

  it('REFUSES a bucket larger than its universe — the 898-of-466 report', () => {
    /* The whole point. Not clamped to 466: a count clipped to fit is the
       rail's own forbidden move, because `898` shown as `466` still asserts
       that every task in the space is To Do — false, and unfalsifiable by
       looking at it. `null` says "not known", which is true. */
    expect(bucketCountLabel(898, undefined, 466)).toBeNull();
    expect(bucketCountLabel(467, page({ hasMore: true }), 466)).toBeNull();
  });

  it('checks the SERVER’s total too, not only the client’s length', () => {
    /* Two aggregates read at two moments can contradict each other, and when
       they do one is stale. Rendering either as fact picks a winner on no
       grounds. */
    expect(bucketCountLabel(0, page({ total: 900 }), 466)).toBeNull();
  });

  it('keeps the honest hedge when the total has not landed', () => {
    expect(bucketCountLabel(50, page({ hasMore: true }), 466)).toBe('50+');
    expect(bucketCountLabel(50, page({ hasMore: false }), 466)).toBe('50');
  });

  it('treats an ABSENT universe as unknown, never as unbounded', () => {
    /* A host that has not read the kind counts imposes no bound rather than a
       fabricated one — the same law the width solver follows for a row it
       cannot measure. The number is still hedged, it is simply not checked. */
    expect(bucketCountLabel(898, undefined, undefined)).toBe('898');
    expect(bucketCountLabel(898, page({ total: 898 }), undefined)).toBe('898');
  });

  it('lets a bucket equal its universe — every row in one band is legal', () => {
    /* A kind seeded `done` at birth has all of them in one bucket. The bound is
       `>`, not `>=`, and getting that wrong would blank a correct count on
       exactly the kinds the empty-default-tab audit was about. */
    expect(bucketCountLabel(466, page({ total: 466 }), 466)).toBe('466');
  });

  it('renders zero as a real answer', () => {
    /* `0` is an ANSWER and `null` is the absence of one; they must not look
       alike. The tab row deliberately shows a zero (the owner's design), so
       this distinction is load-bearing rather than cosmetic. */
    expect(bucketCountLabel(0, page({ total: 0 }), 466)).toBe('0');
  });

  it('agrees with countLabel wherever a bound cannot fire', () => {
    /* The new function must not quietly change any case the old one already
       answered — it only adds a refusal. Anything at or under the universe is
       byte-identical to what shipped. */
    for (const [shown, p] of [
      [0, page({ total: 0 })],
      [12, page({ total: 12 })],
      [12, page({ hasMore: true })],
      [12, undefined],
    ] as const) {
      expect(bucketCountLabel(shown, p, 466)).toBe(countLabel(shown, p));
    }
  });
});
