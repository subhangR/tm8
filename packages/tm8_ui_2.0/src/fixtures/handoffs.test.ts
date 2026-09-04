import { describe, expect, it } from 'vitest';
import { HandoffViewSchema, type HandoffView } from '@tm8/contract';
import * as handoffModule from './handoffs';
import {
  fixtureHandoffs,
  fixtureHandoffsBySession,
  handoffSourceMissing,
  sessionLive,
  sessionStale,
} from './index';

/**
 * The handoff matrix is a LEGAL claim, not a convenience sample: the session
 * panel's two-facet rendering (LLD L7) can only be proven not to collapse if
 * the dataset carries every pair the contract permits. These tests pin the
 * matrix so a future edit that drops a pair fails here rather than silently
 * removing the case that would have caught a one-badge regression.
 */

const DELIVERY: HandoffView['deliveryStatus'][] = ['prepared', 'dispatching', 'delivered', 'refused', 'unknown'];
const RECORD: HandoffView['recordStatus'][] = ['pending', 'recorded', 'failed', 'withdrawn'];

/** The schema's own rule: in-flight deliveries cannot carry a terminal record verdict. */
const isLegalPair = (d: HandoffView['deliveryStatus'], r: HandoffView['recordStatus']): boolean =>
  ['delivered', 'refused', 'unknown'].includes(d) || r === 'pending';

describe('handoff fixtures', () => {
  it('every row validates against the contract zod schema', () => {
    for (const h of fixtureHandoffs) {
      const res = HandoffViewSchema.safeParse(h);
      expect(res.success, `${h.handoffId}: ${res.success ? '' : JSON.stringify(res.error.issues[0])}`).toBe(true);
    }
  });

  it('covers the COMPLETE legal deliveryStatus × recordStatus matrix (14 pairs)', () => {
    const present = new Set(fixtureHandoffs.map((h) => `${h.deliveryStatus}×${h.recordStatus}`));
    const expected: string[] = [];
    for (const d of DELIVERY) {
      for (const r of RECORD) if (isLegalPair(d, r)) expected.push(`${d}×${r}`);
    }
    expect(expected).toHaveLength(14);
    for (const pair of expected) expect(present.has(pair), `missing legal facet pair ${pair}`).toBe(true);
  });

  it('carries no ILLEGAL pair (the schema forbids in-flight + terminal record)', () => {
    for (const h of fixtureHandoffs) {
      expect(
        isLegalPair(h.deliveryStatus, h.recordStatus),
        `${h.handoffId} is an illegal pair ${h.deliveryStatus}×${h.recordStatus}`,
      ).toBe(true);
    }
  });

  it('carries `unknown` delivery against EVERY record status — the facet that must never read as success', () => {
    const unknowns = fixtureHandoffs.filter((h) => h.deliveryStatus === 'unknown');
    expect(new Set(unknowns.map((h) => h.recordStatus))).toEqual(new Set(RECORD));
  });

  it('withdrawn rows carry withdrawnAt AND withdrawnBy; non-withdrawn carry neither', () => {
    for (const h of fixtureHandoffs) {
      const withdrawn = h.recordStatus === 'withdrawn';
      expect(h.withdrawnAt !== null, h.handoffId).toBe(withdrawn);
      expect(h.withdrawnBy !== null, h.handoffId).toBe(withdrawn);
    }
  });

  it('carries the sourceMissing row — snapshot survives, the entity does not', () => {
    expect(handoffSourceMissing.sourceMissing).toBe(true);
    expect(handoffSourceMissing.sourceSnapshot.title.length).toBeGreaterThan(0);
    expect(fixtureHandoffs.filter((h) => h.sourceMissing)).toHaveLength(1);
  });

  it('carries a truncated envelope naming what was omitted', () => {
    const truncated = fixtureHandoffs.filter((h) => h.sourceSnapshot.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const h of truncated) expect(h.sourceSnapshot.omittedFields.length).toBeGreaterThan(0);
  });

  it('groups by target session and covers both a live and a stale session', () => {
    expect(fixtureHandoffsBySession[sessionLive.id]?.length).toBeGreaterThan(0);
    expect(fixtureHandoffsBySession[sessionStale.id]?.length).toBeGreaterThan(0);
    const grouped = Object.values(fixtureHandoffsBySession).flat();
    expect(grouped).toHaveLength(fixtureHandoffs.length);
  });

  it('this dataset authors NO deferral copy — the action registry owns it', () => {
    // Guards the FIX, not just today's state: these were two authored
    // sentences duplicating REASONS.handoffSendDeferred /
    // REASONS.handoffWithdrawDeferred, and re-adding either must fail here.
    //
    // Asserted over the MODULE NAMESPACE, not over the exported array — my
    // first attempt read Object.keys() of `fixtureHandoffs`, which yields
    // array INDICES and could never have detected a re-added export. It would
    // have passed forever while asserting nothing, which is the weak-assertion
    // class this suite exists to avoid.
    const exported = Object.keys(handoffModule);
    expect(exported).not.toContain('handoffSendUnavailableReason');
    expect(exported).not.toContain('handoffWithdrawUnavailableReason');
    // Positive control: the namespace read works and IS seeing real exports.
    expect(exported).toContain('fixtureHandoffs');
  });
});
