/**
 * Registry exhaustiveness + the WLT §3 behavior↔field matrix (LLD §15.1).
 *
 * These are the tests that keep L2 true: a per-kind behavior with no registry
 * field is a SPEC DEFECT, and the matrix below is where that defect surfaces.
 */
import { describe, expect, it } from 'vitest';
import { CoreEntityKindSchema } from '@tm8/contract';
import {
  ALL_MODES,
  CUSTOM_KIND_FALLBACK,
  RESERVED_SLUGS,
  allActions,
  allKinds,
  collectionKinds,
  customKindSlug,
  deferredActions,
  getKind,
  kindBySlug,
  kindOfSlug,
  resolveAction,
  slugOfKind,
} from './index';
import type { ListConfig } from './types';

const CORE_KINDS = CoreEntityKindSchema.options;

describe('totality over the frozen core-kind set (WLT §2.1)', () => {
  it('has a row for every member of CoreEntityKindSchema', () => {
    const rows = new Set(allKinds().map((r) => r.kind));
    for (const kind of CORE_KINDS) expect(rows.has(kind)).toBe(true);
  });

  it('measures 15 core kinds plus exactly one c:* fallback row', () => {
    // The count is measured from the contract, never asserted from a doc (D11).
    expect(CORE_KINDS.length).toBe(15);
    expect(allKinds()).toHaveLength(CORE_KINDS.length + 1);
    expect(allKinds().filter((r) => r.kind === CUSTOM_KIND_FALLBACK)).toHaveLength(1);
  });

  it('never throws on a lookup miss — every custom kind lands on c:* for free', () => {
    const row = getKind('c:incident');
    expect(row.kind).toBe(CUSTOM_KIND_FALLBACK);
    expect(row.panel.archetype).toBe('generic');
    expect(getKind('utterly-unknown').kind).toBe(CUSTOM_KIND_FALLBACK);
  });

  it('maps c:{name} → c-{name} and back', () => {
    expect(customKindSlug('c:incident')).toBe('c-incident');
    expect(slugOfKind('c:incident')).toBe('c-incident');
    expect(kindOfSlug('c-incident')).toBe('c:incident');
  });
});

describe('slugs, reserved words and route strategies (WLT §2.1 verbatim)', () => {
  const EXPECTED_SLUGS: Record<string, string | null> = {
    task: 'tasks',
    work_session: 'sessions',
    doc: 'docs',
    team_member: 'teammates',
    pull_request: 'pulls',
    member: 'members',
    spell: 'spells',
    skill: 'skills',
    collection: 'collections',
    file: 'files',
    commit: 'commits',
    project: 'projects',
    interaction_profile: 'interaction-profiles',
    channel: null,
    message: null,
  };

  it('assigns the WLT slug to every core kind', () => {
    for (const [kind, slug] of Object.entries(EXPECTED_SLUGS)) {
      expect(getKind(kind).slug).toBe(slug);
    }
  });

  it('makes channel special (with a route builder) and message anchored', () => {
    const channel = getKind('channel');
    expect(channel.strategy).toBe('special');
    expect(channel.routeBuilder?.('space-1', 'chan-1')).toBe('#/s/space-1/channel/chan-1');

    const message = getKind('message');
    expect(message.strategy).toBe('anchored');
    expect(message.slug).toBeNull();
    // No k/ view exists for messages, so they are never in the kind selector.
    expect(collectionKinds().map((r) => r.kind)).not.toContain('message');
  });

  it('never uses a reserved word as a slug', () => {
    for (const row of allKinds()) {
      if (row.slug) expect(RESERVED_SLUGS).not.toContain(row.slug);
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = allKinds().map((r) => r.slug).filter((s): s is string => s !== null);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('resolves every slug back to its row', () => {
    for (const row of allKinds()) {
      if (row.slug) expect(kindBySlug(row.slug)?.kind).toBe(row.kind);
    }
    expect(kindBySlug('not-a-slug')).toBeNull();
  });
});

describe('collection modes (D13)', () => {
  it('never HIDES graph — R7 needs it visible-and-disabled in the switcher', () => {
    // Hidden-by-config and disabled-with-reason are different states; conflating
    // them would silently delete an R7 affordance.
    for (const row of allKinds()) expect(row.hiddenModes).not.toContain('graph');
  });

  it('never hides a kind default mode, and every mode named is a real mode', () => {
    for (const row of allKinds()) {
      expect(ALL_MODES).toContain(row.defaultMode);
      expect(row.hiddenModes).not.toContain(row.defaultMode);
      for (const mode of row.hiddenModes) expect(ALL_MODES).toContain(mode);
    }
  });
});

describe('the WLT §3 survival list ↔ ListConfig field matrix (LLD §15.1)', () => {
  // Every surviving behavior names the FIELD that carries it. A behavior with
  // no field is a spec defect, not an inline special case.
  it('1. task current/completed sections → list.sections', () => {
    const sections = getKind('task').list.sections;
    expect(sections?.map((s) => s.id)).toEqual(['current', 'completed']);
    expect(sections?.[1].collapsedByDefault).toBe(true);
    // Contract-shaped: the seam can execute these without translation.
    expect(sections?.[0].filter.workStatus).toContain('working');
    expect(sections?.[1].filter.workStatus).toContain('done');
  });

  it('2. hierarchy expansion → list.tree', () => {
    expect(getKind('task').list.tree).toEqual({ by: 'hierarchy', guideLines: true });
    expect(getKind('work_session').list.tree).toEqual({ by: 'hierarchy', guideLines: true });
  });

  it('3. inline status / edit / complete → list.inlineEdit + list.rowActions (B1)', () => {
    const task = getKind('task').list;
    expect(task.inlineEdit).toEqual({ status: true, title: true });
    expect(task.rowActions).toContain('complete');

    const session = getKind('work_session').list;
    expect(session.inlineEdit?.title).toBe(true);
    expect(session.rowActions).toEqual(['complete', 'terminate']);
  });

  it('4. Run / Coordinate primaries are TASK-KIND ONLY', () => {
    expect(getKind('task').list.primaryActions).toEqual(['run', 'coordinate']);
    for (const row of allKinds()) {
      if (row.kind === 'task') continue;
      expect(row.list.primaryActions ?? []).not.toContain('run');
    }
  });

  it('5. sessions lifecycle → list.lifecycle, D20 partition surviving underneath', () => {
    const tiers = getKind('work_session').list.lifecycle;
    expect(tiers?.map((t) => t.id)).toEqual(['open', 'done', 'archived']);
    // The contract cannot express WorkSessionStatus in CollectionQuery.filters,
    // so the partition rides alongside a contract-shaped filter (D20).
    expect(tiers?.[0].statuses).toEqual(['spawning', 'running', 'idle']);
    expect(tiers?.[1].statuses).toEqual(['exited', 'failed']);
    for (const tier of tiers ?? []) expect(tier.filter).toBeTruthy();
  });

  it('D41 — every COLLECTION kind carries all three tiers, in order', () => {
    // Universal by ruling. A kind that forgot them would silently lose its
    // tabs, so the test asserts presence rather than trusting each row.
    for (const row of collectionKinds()) {
      expect(row.list.lifecycle?.map((t) => t.id)).toEqual(['open', 'done', 'archived']);
    }
    expect(getKind(CUSTOM_KIND_FALLBACK).list.lifecycle?.map((t) => t.id)).toEqual([
      'open',
      'done',
      'archived',
    ]);
  });

  it('D41 — archived is a REAL query for every kind, never an invention', () => {
    // `deleted: 'only'` is a genuine CollectionQuery member, which is why the
    // archive tier is honest universally where `done` is not.
    for (const row of allKinds()) {
      const archived = row.list.lifecycle?.find((t) => t.id === 'archived');
      expect(archived?.filter).toEqual({ deleted: 'only' });
      expect(archived?.unsupported).toBeUndefined();
    }
  });

  it('D41 — a tier the contract cannot express is UNSUPPORTED with a reason, never faked', () => {
    // Only task (workStatus) and work_session (D20 partition) can express
    // completion. Everything else says so out loud rather than inventing one.
    const canExpressDone = ['task', 'work_session'];
    for (const row of allKinds()) {
      const done = row.list.lifecycle?.find((t) => t.id === 'done');
      if (canExpressDone.includes(row.kind)) {
        expect(done?.unsupported).toBeUndefined();
      } else {
        expect(done?.unsupported).toBeTruthy();
        // The tab still exists — honest-empty, never hidden (L6).
        expect(done?.label).toBe('Done');
      }
    }
  });

  it('D41 — carries NO count field: counts come from each tier query total', () => {
    // One source, three surfaces (tab label, footer line, selector total). A
    // count field would be a second source that could disagree with the query.
    for (const row of allKinds()) {
      for (const tier of row.list.lifecycle ?? []) {
        expect(tier).not.toHaveProperty('count');
        expect(tier).not.toHaveProperty('total');
      }
    }
  });

  it('6. live count → list.liveCount', () => {
    const liveCount = getKind('work_session').list.liveCount;
    expect(liveCount?.label(3)).toBe('● 3 live');
  });

  it('7. quick launch → list.quickLaunch', () => {
    expect(getKind('work_session').list.quickLaunch).toBe('launch-session');
  });

  it('8. per-kind filters → list.filters (and a sort with exactly one default)', () => {
    for (const row of allKinds()) {
      expect(row.list.filters.length).toBeGreaterThan(0);
      expect(row.list.sort.filter((s) => s.default)).toHaveLength(1);
    }
  });

  it('uses only the CLOSED §2.2 field vocabulary', () => {
    const CLOSED: readonly (keyof ListConfig)[] = [
      'sections',
      'lifecycle',
      'tree',
      'tile',
      'liveCount',
      'quickCreate',
      'quickLaunch',
      'primaryActions',
      'filters',
      'sort',
      'needsAttentionGroup',
      'liveTreatment',
      'inlineEdit',
      'rowActions',
    ];
    for (const row of allKinds()) {
      for (const key of Object.keys(row.list)) {
        expect(CLOSED).toContain(key as keyof ListConfig);
      }
    }
  });
});

describe('liveness presentation is presentation only (R-UI-5, D6)', () => {
  const treat = getKind('work_session').list.liveTreatment!;

  it('marks and attaches only on the live verdict', () => {
    expect(treat('live')).toMatchObject({ dot: 'solid', attachable: true });
    for (const verdict of ['stale', 'not-running', 'unknown'] as const) {
      expect(treat(verdict).dot).toBeNull();
      expect(treat(verdict).attachable).toBe(false);
    }
  });

  it('offers a streaming word ONLY where the verdict permits streaming', () => {
    // The two-source law made structural: activity can REFINE a live verdict
    // and can never promote a non-live one, because a non-live verdict carries
    // no streaming word for the render path to reach for.
    expect(treat('live')).toMatchObject({ label: 'running', streamingLabel: 'streaming' });
    for (const verdict of ['stale', 'not-running', 'unknown'] as const) {
      expect(treat(verdict).streamingLabel).toBeUndefined();
    }
  });

  it('keeps every compact word inside the panel-floor budget', () => {
    // A1c's finding: `.lp__word` is nowrap mono 9.5px in a flex:none slot, and
    // the TITLE is the only flex:1 min-width:0 element in the row — so an
    // over-long status word does not wrap, it eats the title until the row
    // shows a state with no entity attached. That inverts the floor law.
    //
    // 12 chars is a PROXY for a width budget, not a measurement: jsdom has no
    // layout engine, so the real check is the D10 real-browser pixel pass and
    // that pass supersedes this number. What this guard buys is that a future
    // 31-character label fails HERE, loudly, instead of at the gate.
    const COMPACT_BUDGET = 12;
    for (const verdict of ['live', 'stale', 'not-running', 'unknown'] as const) {
      const t = treat(verdict);
      const compact = t.shortLabel ?? t.label;
      expect(compact.length).toBeLessThanOrEqual(COMPACT_BUDGET);
      // The streaming word renders in the SAME slot, so it is budgeted too.
      if (t.streamingLabel) expect(t.streamingLabel.length).toBeLessThanOrEqual(COMPACT_BUDGET);
    }
  });

  it('never abbreviates a verdict into a STATUS value', () => {
    // `exited` is a WorkSessionStatus; `not-running` is a liveness verdict.
    // A session can be not-running without having exited. Abbreviating one
    // into the other is the same two-source conflation D22 removed.
    expect(treat('not-running').shortLabel).toBeUndefined();
    expect(treat('not-running').label, "LLD §3.1 words this verdict verbatim — if this fails, amend the SPEC first (and ledger it), then the registry. Do not 'fix' the test.").toBe('not running');
    for (const verdict of ['live', 'stale', 'not-running', 'unknown'] as const) {
      const compact = treat(verdict).shortLabel ?? treat(verdict).label;
      expect(['exited', 'failed', 'spawning', 'idle']).not.toContain(compact);
    }
  });

  it('keeps the compact form honest — it never claims life the verdict withholds', () => {
    // The whole point of D27: shortening must not turn "unverified" into a
    // claim. The compact word for a non-attachable verdict may never be a
    // bare life-claim.
    for (const verdict of ['stale', 'not-running', 'unknown'] as const) {
      const t = treat(verdict);
      const compact = t.shortLabel ?? t.label;
      expect(compact).not.toBe('running');
      expect(compact).not.toBe('live');
      expect(compact).not.toBe('streaming');
      // The long sentence is never lost — it stays reachable for title/detail.
      expect(t.label.length).toBeGreaterThanOrEqual(compact.length);
    }
    expect(treat('unknown').shortLabel).toBe('unverified');
    expect(treat('stale').shortLabel).toBe('stale');
  });

  it('never renders unknown or stale as live, and always carries a WORD', () => {
    expect(treat('unknown').label, "LLD §3.1 words this verdict verbatim — if this fails, amend the SPEC first (and ledger it), then the registry. Do not 'fix' the test.").toBe('running per record · unverified');
    expect(treat('stale').label, "LLD §3.1 words this verdict verbatim — if this fails, amend the SPEC first (and ledger it), then the registry. Do not 'fix' the test.").toBe('stale — node restarted');
    for (const verdict of ['live', 'stale', 'not-running', 'unknown'] as const) {
      expect(treat(verdict).label.length).toBeGreaterThan(0);
    }
    for (const verdict of ['stale', 'not-running', 'unknown'] as const) {
      expect(treat(verdict).reason).toBeTruthy();
    }
  });

  it('binds the pulse declaratively — never as a function of EntitySummary (F1)', () => {
    expect(getKind('work_session').list.tile.pulse).toEqual({
      signal: 'terminal-activity',
      gate: 'live',
    });
  });

  it('takes the NEEDS-YOU verdict as a parameter and never derives it', () => {
    const needs = getKind('work_session').list.needsAttentionGroup!;
    const row = { id: 's1', kind: 'work_session' as const, activityAt: '', status: 'idle', blockedCount: 0 };
    expect(needs(row, 'live')).toBe(true);
    // A record that merely CLAIMS to be idle, with no live verdict, never fires.
    expect(needs(row, 'unknown')).toBe(false);
    expect(needs(row, 'stale')).toBe(false);
    expect(needs({ ...row, status: 'running' }, 'live')).toBe(false);
  });
});

describe('panel archetypes are total over the kind set (LLD §2.3)', () => {
  const EXPECTED: Record<string, string> = {
    task: 'subtree',
    doc: 'reader',
    channel: 'hub',
    member: 'profile',
    team_member: 'profile',
    work_session: 'terminal',
    message: 'generic',
    file: 'generic',
    spell: 'generic',
    skill: 'generic',
    pull_request: 'generic',
    commit: 'generic',
    collection: 'generic',
    project: 'generic',
    interaction_profile: 'generic',
  };

  it('assigns the canvas-named archetype to every kind', () => {
    for (const [kind, archetype] of Object.entries(EXPECTED)) {
      expect(getKind(kind).panel.archetype).toBe(archetype);
    }
    expect(getKind(CUSTOM_KIND_FALLBACK).panel.archetype).toBe('generic');
  });

  it('gives every generic-archetype kind at least one content block (§2.4)', () => {
    for (const row of allKinds()) {
      if (row.panel.archetype !== 'generic') continue;
      expect(row.panel.blocks?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('ships contentSurfaces on work_session only, and Phase 1 is terminal-only (D12)', () => {
    expect(getKind('work_session').panel.contentSurfaces).toEqual(['terminal']);
    for (const row of allKinds()) {
      if (row.kind === 'work_session') continue;
      expect(row.panel.contentSurfaces).toBeUndefined();
    }
  });

  it('gives restricted kinds honest capability wording (L6)', () => {
    for (const kind of ['project', 'interaction_profile']) {
      const reasons = getKind(kind).panel.capabilityReasons;
      expect(reasons?.canEdit).toBeTruthy();
      expect(reasons?.canDelete).toBeTruthy();
    }
  });
});

describe('Z1 / Z2 specs', () => {
  it('gives every kind an icon (the collapsed 48px menu rail needs one)', () => {
    for (const row of allKinds()) expect(row.icon.length).toBeGreaterThan(0);
  });

  it('summarises with 2–4 card fields', () => {
    for (const row of allKinds()) {
      expect(row.card.fields.length).toBeGreaterThanOrEqual(2);
      expect(row.card.fields.length).toBeLessThanOrEqual(4);
    }
  });

  it('gives every tinted chip a tone map', () => {
    for (const row of allKinds()) {
      if (row.chip.tintBy === 'none') continue;
      expect(Object.keys(row.chip.tones ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe('the ActionRef registry (§2.5)', () => {
  it('resolves every registered ref to a labeled, iconed definition', () => {
    for (const action of allActions()) {
      expect(resolveAction(action.id)).toBe(action);
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.icon.length).toBeGreaterThan(0);
    }
  });

  it('resolves every ref named by a registry row', () => {
    for (const row of allKinds()) {
      const refs = [
        ...(row.list.primaryActions ?? []),
        ...(row.list.rowActions ?? []),
        ...(row.panel.primaries ?? []),
        ...(row.list.quickLaunch ? [row.list.quickLaunch] : []),
        ...(row.palette?.primaryAction ? [row.palette.primaryAction] : []),
      ];
      for (const ref of refs) expect(resolveAction(ref)).toBeTruthy();
    }
  });

  it('gives every R7 deferred member a disabled-with-reason home (§4.2 table)', () => {
    const ids = deferredActions().map((a) => a.id);
    for (const ref of [
      'graph-view',
      'undo',
      'version-history',
      'leaderboard',
      'awards',
      'saved-views',
      'search-results',
      'activity-screen',
      'add-server',
      'share-into-session',
      'withdraw-handoff',
    ] as const) {
      expect(ids).toContain(ref);
      const verdict = resolveAction(ref).availability({ spaceId: 's' });
      expect(verdict.kind).toBe('disabled');
      if (verdict.kind === 'disabled') expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it('disables on server capability truth, with the honest reason (L6)', () => {
    const caps = {
      canEdit: false,
      canDelete: false,
      canAddChild: false,
      canLink: false,
      canPull: false,
      canReact: false,
      canGrantPoints: false,
      canComplete: false,
    };
    const verdict = resolveAction('complete').availability({
      spaceId: 's',
      entityId: 'e1',
      capabilities: caps,
    });
    expect(verdict).toEqual({ kind: 'disabled', reason: expect.any(String) });
    expect(
      resolveAction('complete').availability({
        spaceId: 's',
        entityId: 'e1',
        capabilities: { ...caps, canComplete: true },
      }),
    ).toEqual({ kind: 'available' });
  });

  it('lets a cached facade refusal outrank a permissive capability flag', () => {
    const verdict = resolveAction('complete').availability({
      spaceId: 's',
      entityId: 'e1',
      capabilities: {
        canEdit: true,
        canDelete: true,
        canAddChild: true,
        canLink: true,
        canPull: true,
        canReact: true,
        canGrantPoints: true,
        canComplete: true,
      },
      opUnavailable: { 'tasks.complete': 'This node has not built task completion yet.' },
    });
    expect(verdict).toEqual({
      kind: 'disabled',
      reason: 'This node has not built task completion yet.',
    });
  });

  it('refuses session verbs on any verdict but live, and says which', () => {
    const base = { spaceId: 's', entityId: 'sess-1' } as const;
    expect(resolveAction('terminate').availability({ ...base, liveness: 'live' })).toEqual({
      kind: 'available',
    });
    for (const verdict of ['stale', 'not-running', 'unknown'] as const) {
      const result = resolveAction('terminate').availability({ ...base, liveness: verdict });
      expect(result.kind).toBe('disabled');
    }
    // No verdict at all is NOT permission — unknown is never treated as live.
    expect(resolveAction('terminate').availability(base).kind).toBe('disabled');
  });

  it('never runs a disabled action', async () => {
    const calls: unknown[] = [];
    await resolveAction('complete').run({
      spaceId: 's',
      entityId: 'e1',
      capabilities: null,
      dispatch: async (intent) => {
        calls.push(intent);
      },
    });
    expect(calls).toEqual([]);
  });

  it('dispatches an available action through the injected executor', async () => {
    const calls: unknown[] = [];
    await resolveAction('terminate').run({
      spaceId: 's',
      entityId: 'sess-1',
      liveness: 'live',
      dispatch: async (intent) => {
        calls.push(intent);
      },
    });
    expect(calls).toEqual([{ action: 'terminate', entityId: 'sess-1' }]);
  });
});
