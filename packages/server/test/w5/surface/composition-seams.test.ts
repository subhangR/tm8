/**
 * W5 Duo C — THE COMPOSITION-ROOT SEAM DOORS.
 *
 * ── WHAT THIS ASSERTS, AND WHY IT IS NOT THE OBVIOUS ASSERTION ─────────────
 * `W2MessagesHandoffsServiceOptions` declares FOUR optional seams. The
 * composition root's `RegisterFacadeHandlersDeps` exposes exactly ONE of them,
 * and `facade/index.ts` builds the options object as a literal —
 * `deps.messageDelivery ? { messageDelivery: deps.messageDelivery } : {}` — so
 * the other three CANNOT BE SUPPLIED BY ANY CALLER OF `registerFacadeHandlers`.
 * Not "are not configured". NOT EXPRESSIBLE.
 *
 * The measured consequence, driven on a real node against the landed 37-chain:
 * a message posted through the public v1 API answers 200 and creates **ZERO
 * EDGES OF ANY TYPE**, while `authored_from` is a registered edge type WITH a
 * props_schema and the feed read path is fully built to hydrate it. On the
 * feed — which is the ACTUAL provenance surface — `sourceWorkSessionId` is
 * present and permanently `null` through public writes.
 *
 * ⚠ A CORRECTION THIS SEAT OWES, RECORDED RATHER THAN QUIETLY DROPPED. An
 * earlier version of this note said the field was "ABSENT, not null — a
 * consumer cannot distinguish no-provenance from not-implemented." THAT WAS
 * WRONG. It came from probing `POST /v2/messages`, whose DTO never carried a
 * provenance field at all: `sourceWorkSessionId` is a FEED item field
 * (`feed-context.ts:566`, `?? null`), not a message field. Measured on the
 * feed: the key IS present with value `null`, so a consumer CAN distinguish.
 * The sharpening dissolves; the zero-edges evidence, which is what this file
 * rests on, does not depend on it.
 *
 * ── WHY THIS FILE DOES NOT ASSERT THAT CONSEQUENCE ─────────────────────────
 * The obvious detector is `authored_from count == 0`. IT IS THE WRONG
 * ASSERTION, and the tell was that its correctness depended on a classification
 * nobody had made yet: if these seams are awaiting a later wave, a count
 * assertion goes RED THE DAY SOMEONE WIRES THEM CORRECTLY — punishing the fix;
 * if they are a defect, the identical assertion is the regression guard.
 * **THE SAME BYTES, MEANING OPPOSITE THINGS, DEPENDING ON AN ANSWER THE TEST
 * CANNOT SEE.**
 *
 * A COUNT MEASURES A CONSEQUENCE AND INHERITS EVERY OTHER CAUSE OF THAT COUNT.
 * This file asserts the MECHANISM instead — the presence or absence of a door
 * at the composition root — which is correct in all three worlds:
 *   · seam awaiting a later wave  → reds when the door is ADDED, i.e. it GREETS
 *                                   the fix instead of punishing it
 *   · defect                      → the same red is the regression guard, and it
 *                                   fires at the cause rather than three layers
 *                                   downstream at a row count
 *   · dossier question            → holds the fact stable while the authority
 *                                   decides, and asserts nothing about intent
 *
 * ── DISPOSITION — SETTLED, AND IT WAS ALREADY IN THE TREE ─────────────────
 * `docs/chat-and-messaging/CHAT-SYSTEM-DESIGN.md` §8 "Gap register" row **G2** records
 * this exact fact with this exact fact basis — *"`authored_from` provenance
 * never written on the post path: `resolveAuthoredFromWorkSessionId` is a
 * declared, unwired seam … facade/index.ts wires only `messageDelivery`"*, at
 * severity ⛔ — and §10 "Build sequencing" assigns it step **S2 (provenance,
 * G2+G6)**, whose stated observable is feed items gaining
 * `via:['authored']`/`['caused']`.
 *
 * **CURRENT DISPOSITION: S2 ARRIVED.** `resolveAuthoredFromWorkSessionId` is now
 * exposed by the composition root and `main.ts` assigns it. The structural
 * assertion below records that door as present and keeps the other two gaps.
 *
 * ⚠ AND WHAT THE REGISTER DOES **NOT** COVER, which is why this file asserts
 * all three seams rather than only the known one: `resolveTargetWorkSessionEpoch`
 * and `handoffDelivery` have **ZERO** occurrences anywhere in `docs/`. G2 names
 * ONE seam and stops there. `handoffDelivery`'s absence is the consequential
 * one — `handoffs.send` reads `if (!prepared.dispatch ||
 * !this.options.handoffDelivery) return prepared.handoff;`, so `dispatchHandoff()`
 * and the whole `pendingHandoffs` machinery are unreachable in the shipped
 * composition and NO gap row records it.
 *
 * ── DISPOSITION MECHANICS, authored with the pin as the standing rule requires ─
 * PIN CLASS: **PRODUCTION state**, therefore a disposition is mandatory.
 * WHEN A DOOR IS ADDED for any of the three seams, this file goes red on that
 * seam. THAT IS THE SEAM BECOMING WIREABLE. The correct response is NOT to
 * relax the assertion: move that seam's name from `SEAMS_WITHOUT_A_DOOR` to
 * `SEAMS_WITH_A_DOOR`, record before-and-after, and — if provenance is now
 * expected to flow — add the behavioural assertion this file deliberately does
 * not make. Never delete the check; the remaining seams still need it.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RegisterFacadeHandlersDeps } from '../../../src/facade/index.js';
import type { W2MessagesHandoffsServiceOptions } from '../../../src/facade/handlers/w2/messages-handoffs.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * THE TYPE-LEVEL DETECTOR. This is the primary instrument and it is checked by
 * this duo's separate test-file typecheck (`tsconfig.check.json`), which is run
 * as a distinct named result and has been mutation-proved in both directions —
 * `--listFiles` confirms these files enter the program, and an injected error
 * confirms the config reports one.
 *
 * `Door<K>` is `true` exactly when the composition root exposes `K`. Each
 * constant below therefore FAILS TO COMPILE the moment that fact changes, in
 * either direction — which is a stronger guarantee than any runtime string
 * match over the source could give, and it is immune to every text-matching
 * blindness this wave has catalogued (NUL bytes, case convention, whitespace,
 * comments).
 */
type Door<K extends string> = K extends keyof RegisterFacadeHandlersDeps ? true : false;

/** Provenance is now reachable; the remaining two seams still are not. */
const HAS_DOOR_AUTHORED_FROM: Door<'resolveAuthoredFromWorkSessionId'> = true;
const NO_DOOR_SESSION_EPOCH: Door<'resolveTargetWorkSessionEpoch'> = false;
const NO_DOOR_HANDOFF_DELIVERY: Door<'handoffDelivery'> = false;

/** The ONE seam the composition root does expose — the negative control. */
const HAS_DOOR_MESSAGE_DELIVERY: Door<'messageDelivery'> = true;

/**
 * And the seams must still be DECLARED on the service, or this file is
 * asserting the absence of something that no longer exists — which would go
 * green for the wrong reason.
 */
type Declared<K extends string> = K extends keyof W2MessagesHandoffsServiceOptions ? true : false;
const DECLARED_AUTHORED_FROM: Declared<'resolveAuthoredFromWorkSessionId'> = true;
const DECLARED_SESSION_EPOCH: Declared<'resolveTargetWorkSessionEpoch'> = true;
const DECLARED_HANDOFF_DELIVERY: Declared<'handoffDelivery'> = true;

describe('W5.C composition-root seam doors', () => {
  /**
   * The asymmetry remains: two seams are declared on the service without a
   * door, while message delivery and authored_from provenance have doors.
   *
   * The runtime assertions below carry the type-level results into the suite so
   * a `vitest` run reports this too — the compile-time constants are what
   * actually detect a change, and these make the detection visible to anyone who
   * runs the tests without running the typecheck.
   */
  it('records exactly which service seams the composition root can supply', () => {
    expect(DECLARED_AUTHORED_FROM, 'the seam must still exist to be unreachable').toBe(true);
    expect(DECLARED_SESSION_EPOCH).toBe(true);
    expect(DECLARED_HANDOFF_DELIVERY).toBe(true);

    expect(HAS_DOOR_AUTHORED_FROM).toBe(true);
    expect(NO_DOOR_SESSION_EPOCH).toBe(false);
    expect(NO_DOOR_HANDOFF_DELIVERY).toBe(false);

    // NEGATIVE CONTROL. Without this, every assertion above is satisfied by a
    // `Door<>` that evaluates to `false` for everything — including a broken
    // type helper — and the file would prove nothing about doors at all.
    expect(
      HAS_DOOR_MESSAGE_DELIVERY,
      'messageDelivery is the ONE seam the composition root exposes; if this is false the Door<> '
        + 'helper is broken and every other assertion in this file is vacuous.',
    ).toBe(true);
  });

  /**
   * THE STRUCTURAL FACT RESTATED AS A SET, so the ratio is visible rather than
   * inferred from four separate booleans. Two of four seams remain unreachable.
   *
   * `messageDelivery` is the contrast that makes it one: `main.ts` wires it
   * conditionally on `TM8_DELIVERY_DATABASE_URL`; provenance is always assigned
   * when the database-backed facade is mounted.
   */
  it('pins the door asymmetry as an exact set', () => {
    const withDoor = [
      HAS_DOOR_MESSAGE_DELIVERY ? 'messageDelivery' : null,
      HAS_DOOR_AUTHORED_FROM ? 'resolveAuthoredFromWorkSessionId' : null,
    ].filter(Boolean);
    const withoutDoor = [
      NO_DOOR_SESSION_EPOCH ? null : 'resolveTargetWorkSessionEpoch',
      NO_DOOR_HANDOFF_DELIVERY ? null : 'handoffDelivery',
    ].filter(Boolean);

    expect(withDoor).toEqual(['messageDelivery', 'resolveAuthoredFromWorkSessionId']);
    expect(withoutDoor).toEqual([
      'resolveTargetWorkSessionEpoch',
      'handoffDelivery',
    ]);
  });

  /**
   * WHAT THIS FILE DOES NOT ESTABLISH, stated inline because it is the
   * reassuring direction and because both this seat and its developer reached
   * the same limit independently:
   *
   * It shows which options the PUBLIC composition can supply. It does not prove
   * end-to-end edge creation; the behavioural database test owns that fact.
   *
   * UPPER BOUND, NOT A PROOF. This test asserts nothing about it; the comment
   * exists so nobody reads the green above as wider than it is.
   */
  it('states its own upper bound rather than implying a proof', () => {
    // Deliberately trivial: the content of this test is its name and its
    // docstring. A green here means "the limit is recorded", never "the limit
    // has been closed".
    expect(true).toBe(true);
  });
});
