/**
 * The pure-model tests. Each one is aimed at a failure this surface could
 * actually ship, not at the happy path.
 *
 * The four that matter most:
 *  1. AN UNREAD FACT IS NEVER A ZERO AND NEVER A VERDICT. `projectRowOf`
 *     without facts must produce `known:false` for trust and usage — the
 *     defect it prevents is a root painted `trusted` that nobody verified,
 *     and an Unlink button beside "0 live sessions" that nobody counted.
 *  2. THE UNLINK REFUSAL IS RANKED, and unverified usage outranks the verb's
 *     own deferral. The two send the user to different remedies.
 *  3. THE REFUSAL COPY IS READ FROM `domain/actions.ts`, not copied. A copy
 *     would still say "isn’t wired yet" on the day it is.
 *  4. VALIDATION ANSWERS FROM THE REAL REGISTRY. A kind named `settings` or
 *     `tasks` must be refused by the same table that owns the routes.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { resolveAction } from '../domain/actions';
import {
  emptyKindDraft,
  fieldTreatment,
  frozenNote,
  moveField,
  profileGroups,
  profileRowOf,
  projectRowOf,
  rankDefaults,
  slugifyKindName,
  draftKindId,
  draftRouteSlug,
  draftToCreateInput,
  unlinkRefusal,
  untrustRefusal,
  unknown,
  validateKindDraft,
  type DraftField,
  type KindDraft,
} from './governance-model';
import { GOVERNANCE_GAPS, GOVERNANCE_REASONS } from './reasons';

// A summary is 20 members wide and only `state` and `title` matter here; the
// cast is local to the test and never leaves it.
const summary = (over: Partial<EntitySummary> & Pick<EntitySummary, 'id' | 'title'>): EntitySummary =>
  ({ state: {}, ...over }) as EntitySummary;

describe('project rows — the unread fact', () => {
  it('renders trust and usage UNKNOWN when nothing supplies them', () => {
    const row = projectRowOf(summary({ id: 'p1', title: 'tm8-ui', state: { projectId: 'proj-1' } as never }));
    expect(row.trust.known).toBe(false);
    expect(row.usage.known).toBe(false);
    expect(row.workingDir.known).toBe(false);
    // The projectId IS read — structural narrowing, not a kind literal.
    expect(row.projectId).toBe('proj-1');
  });

  it('never invents a projectId for a summary whose state has none', () => {
    expect(projectRowOf(summary({ id: 'p2', title: 'x' })).projectId).toBeNull();
  });

  it('renders a supplied trust level, both ways', () => {
    const trusted = projectRowOf(summary({ id: 'p', title: 't' }), { trust: 'trusted' });
    const untrusted = projectRowOf(summary({ id: 'p', title: 't' }), { trust: 'untrusted' });
    expect(trusted.trust).toEqual({ known: true, value: 'trusted' });
    expect(untrusted.trust).toEqual({ known: true, value: 'untrusted' });
  });

  it('keeps a MEASURED zero distinct from an unread count', () => {
    const measured = projectRowOf(summary({ id: 'p', title: 't' }), { usage: { recorded: 0, live: 0 } });
    expect(measured.usage).toEqual({ known: true, value: { recorded: 0, live: 0 } });
  });
});

describe('the unlink refusal is RANKED', () => {
  it('refuses on UNVERIFIED usage before it reaches the verb’s own reason', () => {
    const row = projectRowOf(summary({ id: 'p', title: 't' }));
    const reason = unlinkRefusal(row);
    expect(reason).toEqual(GOVERNANCE_REASONS.usageUnknown);
    // The failure this pins: falling through to the deferral would imply the
    // world is fine and only the build is missing. We do not know that.
    expect(reason.cause).not.toContain('isn’t wired');
  });

  it('names the NUMBER of live sessions when there are any', () => {
    const row = projectRowOf(summary({ id: 'p', title: 't' }), { usage: { recorded: 14, live: 2 } });
    expect(unlinkRefusal(row).cause).toBe('Unlink blocked: 2 live sessions still use this root');
    const one = projectRowOf(summary({ id: 'p', title: 't' }), { usage: { recorded: 3, live: 1 } });
    expect(unlinkRefusal(one).cause).toBe('Unlink blocked: 1 live session still use this root');
  });

  it('falls through to the ACTION REGISTRY’s own copy when nothing blocks', () => {
    const row = projectRowOf(summary({ id: 'p', title: 't' }), { usage: { recorded: 0, live: 0 } });
    const availability = resolveAction('unlink').availability({ spaceId: 'probe' });
    expect(availability.kind).toBe('disabled');
    const registryText = availability.kind === 'disabled' ? availability.reason : '';
    const rendered = unlinkRefusal(row);
    // Read from the registry, not restated: the rendered text must be a
    // decomposition of the registry's own sentence.
    expect(registryText).toContain(rendered.cause);
  });
});

describe('untrust reads its copy from the action registry', () => {
  it('carries the registry sentence, so it changes when the verb lands', () => {
    const availability = resolveAction('untrust').availability({ spaceId: 'probe' });
    const registryText = availability.kind === 'disabled' ? availability.reason : '';
    expect(registryText).toContain(untrustRefusal().cause);
  });
});

describe('the frozen note', () => {
  it('is null for an unfrozen project (a row saying “not frozen” is noise)', () => {
    expect(frozenNote({ linkFrozen: false, frozenBySpaces: [] })).toBeNull();
  });

  it('states the freeze even when the holding spaces are unknown', () => {
    const note = frozenNote({ linkFrozen: true, frozenBySpaces: [] });
    expect(note?.spaces).toEqual([]);
    expect(note?.text).toContain('not readable');
  });

  it('names the holding spaces when they are supplied (the oracle’s actionable form)', () => {
    const note = frozenNote({ linkFrozen: true, frozenBySpaces: ['atelier', 'playground'] });
    expect(note?.spaces).toEqual(['atelier', 'playground']);
    expect(note?.text).toContain('unlink one to unfreeze');
  });
});

describe('profile rows and groups', () => {
  const profile = (id: string, status: string, over: Record<string, unknown> = {}) =>
    summary({
      id,
      title: id,
      state: { status, currentDraftVersion: 1, activeVersion: null, ...over } as never,
    });

  it('reads lifecycle and version from contract state', () => {
    const row = profileRowOf(profile('forge-default', 'active', { activeVersion: 3 }));
    expect(row.status).toBe('active');
    expect(row.version).toBe(3);
  });

  it('falls back to the draft version when nothing is active', () => {
    expect(profileRowOf(profile('terse-worker', 'draft')).version).toBe(1);
  });

  it('never claims “not a default” when no default read exists', () => {
    expect(profileRowOf(profile('p', 'active')).defaultFor.known).toBe(false);
    expect(profileRowOf(profile('p', 'active'), []).defaultFor).toEqual({ known: true, value: [] });
  });

  it('leaves run counts hollow — a 0 here would be a count nobody took', () => {
    expect(profileRowOf(profile('p', 'active')).runs).toEqual(unknown(GOVERNANCE_REASONS.profileRunCount));
  });

  it('renders every lifecycle group, including the empty ones, with MEASURED counts', () => {
    const rows = [profileRowOf(profile('a', 'active')), profileRowOf(profile('b', 'active'))];
    const groups = profileGroups(rows);
    // The ORACLE's list order (L406/L415/L419), which is NOT the rail order —
    // the list leads with what is in force. This assertion is the control on
    // the drift a first implementation actually shipped.
    expect(groups.map((g) => g.id)).toEqual(['active', 'draft', 'retired']);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 0, 0]);
  });
});

describe('default resolution (D53 at this surface)', () => {
  it('lets the teammate default outrank the space default, keeping the loser VISIBLE', () => {
    const scopes = [
      { scope: 'space' as const, label: 'space · atelier' },
      { scope: 'teammate' as const, label: 'scout’s default' },
    ];
    const { winner, outranked } = rankDefaults(scopes);
    expect(winner?.scope).toBe('teammate');
    expect(outranked).toHaveLength(1);
    expect(outranked[0]?.scope).toBe('space');
  });

  it('makes the space default the winner when it is alone', () => {
    const { winner, outranked } = rankDefaults([{ scope: 'space', label: 'space · atelier' }]);
    expect(winner?.scope).toBe('space');
    expect(outranked).toEqual([]);
  });
});

describe('custom-kind drafting', () => {
  const draft = (over: Partial<KindDraft> = {}): KindDraft => ({
    ...emptyKindDraft(),
    name: 'incident',
    plural: 'Incidents',
    glyph: '◮',
    ...over,
  });
  const field = (over: Partial<DraftField> = {}): DraftField => ({
    id: 'f1',
    name: 'severity',
    type: 'text',
    required: false,
    values: [],
    ...over,
  });

  it('slugifies to the route vocabulary', () => {
    expect(slugifyKindName('Release Checklist')).toBe('release-checklist');
    expect(slugifyKindName('  ')).toBe('');
    expect(draftKindId(draft({ name: 'Release Checklist' }))).toBe('c:release-checklist');
    expect(draftRouteSlug(draft({ name: 'Release Checklist' }))).toBe('c-release-checklist');
  });

  it('accepts a complete draft', () => {
    expect(validateKindDraft(draft())).toEqual([]);
  });

  it('refuses a RESERVED route word, answering from the real registry', () => {
    const issues = validateKindDraft(draft({ name: 'settings' }));
    expect(issues.some((i) => i.at === 'name' && i.message.includes('reserved'))).toBe(true);
  });

  it('refuses a name that collides with a built-in kind’s route', () => {
    const issues = validateKindDraft(draft({ name: 'tasks' }));
    expect(issues.some((i) => i.at === 'name')).toBe(true);
  });

  it('refuses a kind this space already defines', () => {
    const existing = [{ kind: 'c:incident' } as never];
    const issues = validateKindDraft(draft(), existing);
    expect(issues.some((i) => i.message.includes('already defines'))).toBe(true);
  });

  it('refuses a field that shadows the universal spine', () => {
    const issues = validateKindDraft(draft({ fields: [field({ name: 'status' })] }));
    expect(issues.some((i) => i.message.includes('built-in'))).toBe(true);
  });

  it('refuses two fields with the same name, case-insensitively', () => {
    const issues = validateKindDraft(
      draft({ fields: [field({ id: 'a', name: 'sev' }), field({ id: 'b', name: 'SEV' })] }),
    );
    expect(issues.some((i) => i.at === 'field:b')).toBe(true);
  });

  it('refuses an enum with no values', () => {
    const issues = validateKindDraft(draft({ fields: [field({ type: 'enum', values: [] })] }));
    expect(issues.some((i) => i.message.includes('at least one value'))).toBe(true);
  });

  it('composes the payload only when the draft validates', () => {
    expect(draftToCreateInput(draft(), 'cmid')).toMatchObject({ kind: 'c:incident', icon: '◮' });
    expect(draftToCreateInput(draft({ name: 'settings' }), 'cmid')).toBeNull();
    expect(draftToCreateInput(draft({ glyph: '' }), 'cmid')).toBeNull();
  });

  it('renders each contract field type through one of the three treatments', () => {
    expect(fieldTreatment('enum')).toBe('word-chip');
    expect(fieldTreatment('bool')).toBe('word-chip');
    expect(fieldTreatment('date')).toBe('mono');
    expect(fieldTreatment('text')).toBe('value');
    expect(fieldTreatment('number')).toBe('value');
  });

  it('moves a field and clamps at both ends', () => {
    const fields = [field({ id: 'a' }), field({ id: 'b' }), field({ id: 'c' })];
    expect(moveField(fields, 2, 0).map((f) => f.id)).toEqual(['c', 'a', 'b']);
    expect(moveField(fields, 0, -1).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(moveField(fields, 2, 99).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(moveField(fields, 9, 0).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the gap register', () => {
  it('gives every gap a stated mechanism, not just a refusal', () => {
    expect(GOVERNANCE_GAPS.length).toBeGreaterThan(10);
    for (const gap of GOVERNANCE_GAPS) {
      expect(gap.need.length, `${gap.id} must state the need`).toBeGreaterThan(5);
      expect(gap.seamToday.length, `${gap.id} must state what exists TODAY`).toBeGreaterThan(10);
    }
  });

  it('routes the two verb-level gaps to the ACTION REGISTRY rather than local copy', () => {
    const viaRegistry = GOVERNANCE_GAPS.filter((g) => g.reason.startsWith('actions.'));
    expect(viaRegistry.map((g) => g.reason).sort()).toEqual(['actions.unlink', 'actions.untrust']);
  });

  it('every locally-authored reason names a MECHANISM in its remedy', () => {
    for (const [id, reason] of Object.entries(GOVERNANCE_REASONS)) {
      expect(reason.cause.length, `${id} cause`).toBeGreaterThan(10);
      expect(reason.remedy?.length ?? 0, `${id} must name the mechanism`).toBeGreaterThan(20);
    }
  });
});
