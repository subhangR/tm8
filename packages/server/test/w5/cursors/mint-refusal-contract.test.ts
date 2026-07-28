import { decodeCursor, encodeCursor } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

/**
 * W5 DUO B — THE MINT-SIDE REFUSAL CONTRACT, PINNED SYNTHETICALLY.
 *
 * ⚠ WHAT THIS FILE IS AND IS NOT. IT DOES NOT TEST PRODUCTION CODE, AND ITS
 * GREEN IS NOT EVIDENCE ABOUT ANY CALL SITE. It exists because the behavioural
 * witness is IMPOSSIBLE:
 *
 *   `services/w2/messages-handoffs.ts:562`  value comes from the SELECT at :547
 *   `services/w2/feed-context.ts:1187`      value comes from a Map populated at
 *                                           :1008 by the same query that yields
 *                                           the ids it is keyed by
 *
 * Both always supply a value today, so NEITHER truthiness guard can fire without
 * editing production source — which a tester does not do. Rather than ship a
 * green that only proves "unreachable today", this file pins the PROPERTY OF THE
 * TWO GUARD SHAPES, against synthetic inputs. Synthetic known-bad cannot be
 * repaired by a source change, so the red half survives any fix — the pattern
 * that preserved B1's red after its fix greened it (`keyset-absent-slot.test.ts`).
 *
 * THE TWO SHAPES, cited so a reader checks the original rather than this copy:
 *   REFUSING   `handlers/collections.ts:192-203` `sortKeyOf` — TWO conditions:
 *              (1) absent/null      -> throws `sort key missing`
 *              (2) present but not exact text -> throws
 *                  "a Date here would truncate the cursor"
 *   TRUTHINESS `messages-handoffs.ts:562`  `hasMore && last?.cursor_created_at && last.id ? … : null`
 *              `feed-context.ts:1187`      `last && lastCursor ? … : null`
 *
 * The reference shapes below are MODELS of those expressions, not the
 * expressions. A model can drift from its original; that is why every assertion
 * carries the file:line it models, and why this file makes no claim about
 * current call-site behaviour.
 */

/** Models the TRUTHINESS shape at messages-handoffs.ts:562 and feed-context.ts:1187. */
function truthinessMint(value: unknown, id: string): string | null {
  return value && id ? encodeCursor(['fp', value as string, id]) : null;
}

/** Models the REFUSING shape at collections.ts:192-203, BOTH conditions. */
function refusingMint(value: unknown, id: string): string {
  if (value === null || value === undefined) throw new Error('cursor key missing');
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('cursor key is not exact text — a Date here would truncate the cursor');
  }
  return encodeCursor(['fp', value, id]);
}

const ID = '11111111-2222-3333-4444-555555555555';
/** A stored instant with microseconds, as `MICROS` renders it. */
const EXACT = '2026-07-25T14:59:01.891823Z';

describe('W5 Duo B — mint-side refusal contract', () => {
  // -------------------------------------------------------------------------
  // CONDITION 1 — absent/null. The silent short walk.
  // -------------------------------------------------------------------------

  it('KNOWN-BAD: the truthiness shape reports EXHAUSTED when the value is missing', () => {
    // `nextCursor: null` is contractually "exhausted" — `contract/src/cursor.ts:7`
    // states `nextCursor: null` ⇔ exhausted. So emitting null while more rows
    // exist tells the client to STOP. No error, no loop: the rows never arrive.
    for (const missing of [undefined, null, '']) {
      expect(truthinessMint(missing, ID)).toBeNull();
    }
  });

  it('KNOWN-GOOD: the refusing shape throws on the same three inputs', () => {
    for (const missing of [undefined, null]) {
      expect(() => refusingMint(missing, ID)).toThrow(/missing/);
    }
    // NOTE THE ASYMMETRY, AND IT IS DELIBERATE: `''` is a STRING, so condition 1
    // does not catch it and condition 2 accepts it as "exact text". The refusing
    // shape mints an empty cursor value here rather than refusing.
    // RECORDED AS A LIMIT OF SPELLING A ITSELF, not as a defect of this test —
    // a converted site inherits this gap, and a reader should know that the
    // promotion target is not perfect.
    expect(() => refusingMint('', ID)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // CONDITION 2 — present but not exact text. THE ONE A NAIVE UNIFICATION DROPS.
  // -------------------------------------------------------------------------

  it('⚠ KNOWN-BAD: the truthiness shape ADMITS a Date and silently truncates it', () => {
    // MEASURED, not reasoned: `Boolean(new Date())` is TRUE, so a truthiness
    // guard does not merely fail to catch condition 2 — IT IS A VECTOR FOR IT.
    const stored = new Date(EXACT);
    expect(Boolean(stored)).toBe(true);

    const minted = truthinessMint(stored, ID);
    expect(minted).not.toBeNull();

    // `encodeCursor` never sees a Date: `JSON.stringify` calls `Date.prototype
    // .toJSON` first, which emits MILLISECONDS. The microseconds are gone before
    // the codec is reached, so nothing downstream can detect the loss.
    const carried = String(decodeCursor(minted!).k[1]);
    expect(carried).toBe('2026-07-25T14:59:01.891Z');
    expect(carried).not.toBe(EXACT);
    expect(EXACT).toMatch(/\.891823Z$/);
    expect(carried).toMatch(/\.891Z$/);
  });

  it('KNOWN-GOOD: the refusing shape rejects the Date by condition 2', () => {
    expect(() => refusingMint(new Date(EXACT), ID)).toThrow(/would truncate the cursor/);
  });

  it('⚠ a guard built only on Date.parse would NOT reject the Date — condition 2 is not free', () => {
    // The two decode-side refusals a conversion would most likely be copied from
    // (`inbox-read-marks.ts` and `identity-spaces.ts`) are `Date.parse`-based.
    // A Date stringifies to a perfectly parseable ISO string, so a `Date.parse`
    // guard passes it. COPYING THOSE REPRODUCES CONDITION 1 ONLY.
    const asString = String(new Date(EXACT));
    expect(Number.isNaN(Date.parse(asString))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GREEN ON KNOWN-GOOD — without this, a shape that refused everything would
  // satisfy every assertion above.
  // -------------------------------------------------------------------------

  it('KNOWN-GOOD: both shapes accept a microsecond-exact string and preserve it', () => {
    for (const minted of [truthinessMint(EXACT, ID), refusingMint(EXACT, ID)]) {
      expect(minted).not.toBeNull();
      expect(String(decodeCursor(minted!).k[1])).toBe(EXACT);
    }
    // And a numeric keyset value, which condition 2 must not reject.
    expect(String(decodeCursor(refusingMint(42, ID)).k[1])).toBe('42');
  });
});
