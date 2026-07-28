import { decodeCursor, encodeCursor } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

/**
 * W5 DUO B — THE ENABLING CONDITION FOR B1, PINNED SO IT SURVIVES THE FIX.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE DB WITNESS.
 * `inbox-teammate-cursor.pg.test.ts` is RED today and will go GREEN when the
 * missing `cursor_created_at` is added to the RPC branch's SELECT. At that
 * moment the suite loses its ability to demonstrate that it would have caught
 * the defect at all — a green detector and a broken detector are
 * indistinguishable from their output. This file keeps the RED HALF alive
 * permanently, because its known-bad input is SYNTHETIC and therefore cannot be
 * repaired by a change to production source.
 *
 * WHAT IT IS NOT. It does NOT restate the handler's logic — a restatement can
 * drift from the original while continuing to pass (§23.13). It exercises the
 * REAL codec from `@tm8/contract` and pins the one contract-level property that
 * made B1 possible and silent-at-the-mint:
 *
 *   a keyset slot holding `undefined` is not rejected, is not preserved, and is
 *   not distinguishable downstream from a slot the producer deliberately set to
 *   `null`.
 *
 * That property is what let `page()` (`inbox-read-marks.ts:418-420`) mint a
 * structurally valid cursor from a row that never carried a timestamp.
 *
 * WHAT THESE CHECKS CAN BE SATISFIED BY: the behaviour of `encodeCursor` /
 * `decodeCursor` alone. They make NO claim about any handler, and they will
 * keep passing after B1 is fixed — which is the point. Evidence that the
 * defect's enabling condition is still present in the codec is NOT evidence
 * that any call site is currently broken.
 */

const ID = '11111111-2222-3333-4444-555555555555';
const HEALTHY = '2026-07-25T14:59:01.891820Z';

describe('W5 Duo B — keyset slots and the absent-value hazard', () => {
  // -------------------------------------------------------------------------
  // RED HALF — the known-bad shape. Synthetic, so it stays reproducible.
  // -------------------------------------------------------------------------

  it('KNOWN-BAD: an undefined slot survives encoding as an indistinguishable null', () => {
    // Exactly the shape page() produces when a row source omits the column:
    // `last.cursor_created_at` is undefined and is spread into the keyset.
    const minted = encodeCursor(['fp-abc', undefined as unknown as string, ID]);
    const decoded = decodeCursor(minted);

    expect(decoded.k).toHaveLength(3);
    expect(decoded.k[1]).toBeNull();

    // AND THE HALF THAT MAKES IT UNDETECTABLE AT THE MINT: an absent value and a
    // deliberate null are byte-identical on the wire, so no consumer downstream
    // can tell a producer that forgot the column from one that meant null.
    const deliberate = encodeCursor(['fp-abc', null, ID]);
    expect(minted).toBe(deliberate);
  });

  it('KNOWN-BAD: the null slot is what the inbox decoder turns into NaN', () => {
    // The coercion at inbox-read-marks.ts:171-173, cited so a reader can check
    // it rather than trust this line: String(k[1] ?? '') then Date.parse(...).
    const decoded = decodeCursor(encodeCursor(['fp-abc', undefined as unknown as string, ID]));
    const coerced = String(decoded.k[1] ?? '');

    expect(coerced).toBe('');
    expect(Number.isNaN(Date.parse(coerced))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GREEN HALF — a healthy MICROS value. Without this the checks above would
  // be satisfied by a codec that mangled every value, not just absent ones.
  // -------------------------------------------------------------------------

  it('KNOWN-GOOD: a microsecond-exact MICROS string round-trips byte-for-byte', () => {
    const decoded = decodeCursor(encodeCursor(['fp-abc', HEALTHY, ID]));

    expect(decoded.k[1]).toBe(HEALTHY);
    expect(Number.isNaN(Date.parse(String(decoded.k[1])))).toBe(false);
  });

  it('KNOWN-GOOD: the codec preserves all six fractional digits, including trailing zeros', () => {
    // The digit that a JS Date round-trip destroys, and the trailing zero that a
    // `::text` rendering drops. Asserted on the CODEC only — fidelity at a real
    // call site is asserted against the database, never against a string.
    for (const value of [
      '2026-07-25T14:59:01.891820Z',
      '2026-07-25T14:59:01.000001Z',
      '2026-07-25T14:59:01.100000Z',
    ]) {
      expect(decodeCursor(encodeCursor(['fp', value, ID])).k[1]).toBe(value);
      expect(new Date(value).toISOString()).not.toBe(value); // iso() would lose it
    }
  });
});
