import { describe, expect, it } from 'vitest';
import { bridgeDeploys, bridgeInfra } from '../fixtures/entities';
import { consequencesOf } from './consequences';
import { fixtureBridgeViewOf } from './fixture';
import { draftOf, draftProblem, patchOf } from './routing-draft';
import { pendingReason } from './reasons';

const infra = fixtureBridgeViewOf(bridgeInfra)!;
const deploys = fixtureBridgeViewOf(bridgeDeploys)!;

describe('the Routing draft', () => {
  it('sends nothing when nothing changed', () => {
    expect(patchOf(infra, draftOf(infra))).toBeNull();
  });

  it('sends exactly the changed fields, clearing with null', () => {
    const d = draftOf(infra);
    d.policy.outbound = 'all';
    d.style = '   ';
    d.quiet.on = false;
    d.workerWake = 'thread';
    expect(patchOf(infra, d)).toEqual({
      policy: { outbound: 'all', style: null }, quietHours: null, workerWake: 'thread',
    });
  });

  it('Undo is the same function run back', () => {
    const d = draftOf(infra);
    d.retention = { forever: false, days: 30 };
    const after = { ...infra, retentionDays: 30 };
    expect(patchOf(infra, d)).toEqual({ retentionDays: 30 });
    expect(patchOf(after, draftOf(infra))).toEqual({ retentionDays: null });
  });

  it('refuses what the server would refuse', () => {
    const d = draftOf(infra);
    d.quiet = { on: true, start: '09:00', end: '09:00' };
    expect(draftProblem(d)).toContain('different times');
    expect(draftProblem({ ...draftOf(infra), retention: { forever: false, days: 0 } })).toContain('1 to 3650');
  });
});

describe('consequences (v2 §1.5)', () => {
  it('confirms widening changes, in numbers', () => {
    const lines = consequencesOf(infra, { policy: { whoMayTrigger: 'anyone', trigger: 'every', outbound: 'all', direction: 'out' }, workerWake: 'all' });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('9 people in Infra, 6 of them not linked');
  });

  it('applies narrowing changes without a confirm', () => {
    expect(consequencesOf(deploys, { policy: { outbound: 'replies', trigger: 'mention' } })).toEqual([]);
    expect(consequencesOf({ ...infra, retentionDays: 30 }, { retentionDays: 90 })).toEqual([]);
    expect(consequencesOf({ ...infra, retentionDays: 30 }, { retentionDays: null })).toEqual([]);
  });
});

describe('disabled controls always say why (D48)', () => {
  it('names the op while unserved, and still gives a reason once served but unwired', () => {
    expect(pendingReason({ serves: () => false }, 'bridges.test', 'Send test')).toContain('does not serve yet');
    expect(pendingReason({ serves: () => true }, 'bridges.test', 'Send test')).toContain('not wired on this screen yet');
  });
});
