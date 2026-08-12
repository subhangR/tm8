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
  UNTRUSTED_REASON,
  buildSpawnInput,
  canLaunch,
  defaultConfigFor,
  describeTeammateLoad,
  modelsFor,
  EDGES_NOT_HYDRATED_REASON,
  ADDITIONAL_PROJECTS_UNAVAILABLE_REASON,
  PROFILE_PINNED_CAPTION,
  describeProfile,
  profileRefusal,
  profileSelectable,
  resolveProfileChain,
} from './index';
import type { ListConfig } from './types';

const CORE_KINDS = CoreEntityKindSchema.options;

describe('totality over the frozen core-kind set (WLT §2.1)', () => {
  it('has a row for every member of CoreEntityKindSchema', () => {
    const rows = new Set(allKinds().map((r) => r.kind));
    for (const kind of CORE_KINDS) expect(rows.has(kind)).toBe(true);
  });

  it('measures 20 core kinds plus exactly one c:* fallback row', () => {
    // The count is measured from the contract, never asserted from a doc (D11).
    // 15 → 16 on 2026-07-31 when `voice_channel` joined CoreEntityKindSchema;
    // then `memory`, `worktree` and `artifact` landed the same day → 19;
    // then `loop` joined with migration 090 (Dreamer & Dispatcher P4) → 20.
    // The literal stays a LITERAL on purpose: writing `CoreEntityKindSchema
    // .options.length` here would make the assertion tautological and the row
    // below could silently drift from the contract again.
    expect(CORE_KINDS.length).toBe(20);
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

describe('loop management is registry-declared and fully wired', () => {
  it('selects staged create, typed edit, lifecycle controls, and the live Edit verb', () => {
    const loop = getKind('loop');
    expect(loop.list.quickCreate).toBe(true);
    expect(loop.createForm).toBe('scheduled-work');
    expect(loop.editFields?.map((field) => field.source ?? field.target)).toEqual([
      'title', 'schedule', 'teamMemberId', 'subjectId', 'prompt', 'config',
    ]);
    expect(loop.editFields?.find((field) => field.source === 'schedule')?.valueType).toBe('schedule');
    expect(loop.editFields?.find((field) => field.source === 'config')?.valueType).toBe('json-object');
    expect(loop.panel.primaries).toEqual(['edit']);
    // RUNS is the third block on purpose: a loop's firing history IS its
    // inbound `triggered_by` edges, so a panel without it hides the only
    // record of what the loop has done.
    expect(loop.panel.blocks?.map((block) => block.block)).toEqual([
      'loop-controls', 'fields', 'peer-rows',
    ]);
    expect(loop.panel.blocks?.find((block) => block.block === 'peer-rows')?.params).toMatchObject({
      edgeType: 'triggered_by',
      direction: 'incoming',
    });
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
    artifact: 'artifacts',
    // 2026-08-01 (user ruling): channel became a COLLECTION kind so it lists in
    // the Entity List Panel. The slug is PLURAL because `channel` is a WLT
    // §2.1 reserved word — see the registry row.
    channel: 'channels',
    message: null,
  };

  it('assigns the WLT slug to every core kind', () => {
    for (const [kind, slug] of Object.entries(EXPECTED_SLUGS)) {
      expect(getKind(kind).slug).toBe(slug);
    }
  });

  it('makes channel a listable collection that KEEPS its singular route', () => {
    // Both halves matter. The collection strategy is what puts Channels in the
    // list panel's kind switcher; the route builder is unchanged, because
    // where a single channel is addressed did not change when the collection
    // got a home. `channels` (plural) is the collection slug — the singular is
    // reserved, and the assertion below proves the two do not collide.
    const channel = getKind('channel');
    expect(channel.strategy).toBe('collection');
    expect(channel.slug).toBe('channels');
    expect(RESERVED_SLUGS).toContain('channel');
    expect(collectionKinds().map((r) => r.kind)).toContain('channel');
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
    // Sessions additionally bind their guide lines to live message provenance
    // — the wire between two rows sweeps when one messages the other.
    expect(getKind('work_session').list.tree).toEqual({
      by: 'hierarchy',
      guideLines: true,
      messagePulse: true,
    });
  });

  it('3. inline status / edit / complete → list.inlineEdit + list.rowActions (B1)', () => {
    const task = getKind('task').list;
    expect(task.inlineEdit).toEqual({ status: true, title: true });
    expect(task.rowActions).toContain('complete');
    // D44: Run rides the same rowActions carrier — no new field, no branching.
    expect(task.rowActions).toContain('run');

    const session = getKind('work_session').list;
    // A session's TITLE is editable and nothing else about it is: status is
    // the PTY's, and the node's patch door (085) accepts a title alone. So the
    // shape here is asymmetric with the task's on purpose — `status: true`
    // would mount a picker over a value no client may write.
    expect(session.inlineEdit).toEqual({ title: true });
    expect(session.rowActions).toEqual(['complete', 'terminate']);
  });

  it("keeps both session row verbs but only Terminate in the compact panel toolbar", () => {
    // USER RULING 2026-07-29: terminal panels use the Task panel's pressure
    // budget — one primary beside tabs and window controls. Complete remains
    // reachable on the session row; Terminate is the in-panel session verb.
    const session = getKind('work_session');
    expect(session.list.rowActions).toEqual(['complete', 'terminate']);
    expect(session.panel.primaries).toEqual(['terminate']);
  });

  /**
   * Was "Run / Coordinate primaries are TASK-KIND ONLY". That rule is retired:
   * any entity can be launched, because the server derives a task to anchor the
   * session on (migration 064) rather than requiring the subject to BE one.
   *
   * The old assertion read `list.primaryActions`, which is why it kept passing
   * after launch went generic — that field has NO consumer anywhere in `src/`
   * (EntityListPanel renders from `list.rowActions` at :1158 and :1348, and
   * nothing else reads it). It was guarding a surface that does not render.
   * These assert the arrays that actually draw a button.
   */
  it('4. launch is declared by `launchable`, and lands on the RENDERED arrays', () => {
    for (const row of allKinds()) {
      const expected = row.launchable === true;
      expect({ kind: row.kind, run: (row.list.rowActions ?? []).includes('run') })
        .toEqual({ kind: row.kind, run: expected });
      expect({ kind: row.kind, run: (row.panel.primaries ?? []).includes('run') })
        .toEqual({ kind: row.kind, run: expected });
    }
  });

  it('4b. every kind a person can ask an agent to work on is launchable', () => {
    const launchable = allKinds().filter((r) => r.launchable).map((r) => r.kind).sort();
    expect(launchable).toEqual([
      'artifact', 'doc', 'memory', 'project', 'pull_request', 'task', 'team_member', 'worktree',
    ]);
  });

  it('4c. task keeps Run FIRST and its own row ordering', () => {
    // applyLaunch is additive, not a rebuild: a row that already names `run`
    // keeps the order it authored.
    expect(getKind('task').list.rowActions).toEqual(['run', 'complete']);
  });

  /**
   * The toolbar admits Run and Edit, and STILL not Coordinate or Complete.
   *
   * The original pin read `['run']` and its point was scarcity — the compact
   * panel row has no space for a verb whose own surface already offers it, and
   * Coordinate and Complete are both that. `edit` is not: it is the ONLY door
   * to `editFields`, which §15.1 below pins to the verb in both directions, so
   * the task's due-date dialog is reachable from here or from nowhere. Keeping
   * the assertion exact (rather than `toContain`) is what stops the toolbar
   * silently re-growing the two verbs the original ruling turned away.
   */
  it('the task DETAIL toolbar keeps Run and Edit, and nothing else', () => {
    expect(getKind('task').panel.primaries).toEqual(['run', 'edit']);
  });

  it('5. sessions lifecycle → list.lifecycle, D20 partition RETIRED (D56)', () => {
    const tiers = getKind('work_session').list.lifecycle;
    expect(tiers?.map((t) => t.id)).toEqual(['open', 'done', 'archived']);
    // The contract now carries `sessionStatus`, so these are ordinary filters
    // the seam executes untranslated — no client-side partition anywhere.
    expect(tiers?.[0].filter.sessionStatus).toEqual(['spawning', 'running', 'idle']);
    expect(tiers?.[1].filter.sessionStatus).toEqual(['exited', 'failed']);
    for (const tier of tiers ?? []) expect(tier.filter).toBeTruthy();
  });

  it('D56 — no tier anywhere carries a client-side partition any more', () => {
    // The retirement is a DELETION, not a translation: if the field comes back
    // on any row, the workaround has been reintroduced beside the contract
    // member that replaced it, and the two would diverge silently.
    for (const row of allKinds()) {
      for (const tier of row.list.lifecycle ?? []) {
        expect(tier).not.toHaveProperty('statuses');
      }
    }
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
    // Only task (workStatus) and work_session (sessionStatus, D56) can express
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
    // Launch is the ONLY birth affordance: the inherited quickCreate:true
    // mounted a Create control that refuses (same defect class as the refused
    // Save control ruled on the rowActions note), so the row opts out.
    expect(getKind('work_session').list.quickCreate).toBe(false);
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
      'stateControl',
      /* Opened 2026-08-04 with the expanded-row controls. A state is written
         by a command verb, a value by a version-guarded content patch and an
         assignment by an edge — three different writes, so they are three
         fields rather than one overloaded `controls`. */
      'valueControls',
      'assignControl',
      /* Opened 2026-08-05 with A2: the board is declared per-kind as DATA —
         only the grouping axis, because vocabulary/order/tone stay owned by
         stateControl and statusPill (doc 06 §1.2). */
      'board',
    ];
    for (const row of allKinds()) {
      for (const key of Object.keys(row.list)) {
        expect(CLOSED).toContain(key as keyof ListConfig);
      }
    }
  });
});

describe('D44 — the launch flow is declared as DATA on the verb', () => {
  it('marks run / coordinate / launch-session as opening a config, not bare-spawning', () => {
    for (const ref of ['run', 'coordinate', 'launch-session'] as const) {
      expect(resolveAction(ref).flow).toBe('launch');
    }
  });

  it('leaves immediate verbs unmarked, so a flow cannot be assumed', () => {
    for (const ref of ['complete', 'pull', 'link', 'terminate'] as const) {
      expect(resolveAction(ref).flow).toBeUndefined();
    }
  });

  it('builds a contract-shaped SpawnInput — scratch is the ABSENCE of a project', () => {
    const config = defaultConfigFor({ id: 'tm-1', agentTool: 'claude-code', model: 'claude-opus-5' });
    // The teammate's RECORDED model wins over this UI's first option: opening
    // the config must not silently change what has been running.
    expect(config.model).toBe('claude-opus-5');
    const input = buildSpawnInput({
      clientMutationId: 'cmid-1',
      spaceId: 'space-1',
      config,
      taskIds: ['task-1'],
    });
    expect(input).toMatchObject({
      clientMutationId: 'cmid-1',
      spaceId: 'space-1',
      teamMemberId: 'tm-1',
      projectId: null,
      workdir: { mode: 'scratch' },
      model: 'claude-opus-5',
      agentTool: 'claude-code',
      taskIds: ['task-1'],
    });
    // Consent is only carried when actually given — absent and false are not
    // the same statement, and the contract types it as literal `true`.
    expect(input).not.toHaveProperty('confirmUntrusted');
    // Same law for each credential choice: auto is the ABSENCE of that
    // provider key, never a third literal.
    expect(input).not.toHaveProperty('credentialSources');
    expect(
      buildSpawnInput({
        clientMutationId: 'cmid-2',
        spaceId: 'space-1',
        config: { ...config, credentialSources: { anthropic: 'member', github: 'node' } },
      }),
    ).toMatchObject({ credentialSources: { anthropic: 'member', github: 'node' } });
    // Same rule for the spawn-time memory hand-off (D3a): no picks, no field.
    expect(input).not.toHaveProperty('memoryIds');
  });

  it('carries picked memoryIds and truncates at the CONTRACT ceiling, not a UI one', () => {
    /*
     * `memoryIds` is `z.array(SpawnUuidSchema).max(32)` (schemas.ts:1662). The
     * sheet's picker refuses the 33rd pick with a reason, but this builder is
     * also reachable from the quick config, so the ceiling is enforced where
     * the contract object is actually made. Truncating here is the honest
     * failure: a caller that ignored the cap loses the overflow rather than
     * losing the whole launch to a node-side refusal it cannot act on.
     */
    const config = defaultConfigFor({ id: 'tm-1', agentTool: 'claude-code', model: 'claude-opus-5' });
    const two = buildSpawnInput({
      clientMutationId: 'cmid-2',
      spaceId: 'space-1',
      config: { ...config, memoryIds: ['mem-a', 'mem-b'] },
    });
    expect(two.memoryIds).toEqual(['mem-a', 'mem-b']);

    const overflow = Array.from({ length: 40 }, (_, i) => `mem-${String(i)}`);
    const capped = buildSpawnInput({
      clientMutationId: 'cmid-3',
      spaceId: 'space-1',
      config: { ...config, memoryIds: overflow },
    });
    expect(capped.memoryIds).toHaveLength(32);
    expect(capped.memoryIds?.[31]).toBe('mem-31');

    // An empty array is still an ABSENT field, not an empty one on the wire.
    const none = buildSpawnInput({
      clientMutationId: 'cmid-4',
      spaceId: 'space-1',
      config: { ...config, memoryIds: [] },
    });
    expect(none).not.toHaveProperty('memoryIds');
  });

  it('refuses an untrusted project WITH the mechanism, until consent is explicit', () => {
    const projects = [
      { projectId: 'p-1', name: 'vendor-import', trusted: false, untrustedReason: UNTRUSTED_REASON },
    ];
    const base = defaultConfigFor({ id: 'tm-1', agentTool: 'claude-code', model: 'claude-sonnet-5' });
    const onUntrusted = { ...base, target: { kind: 'project' as const, projectId: 'p-1' } };
    const refusal = canLaunch(onUntrusted, { projects });
    expect(refusal).toEqual({ ok: false, reason: UNTRUSTED_REASON });
    // Explicit consent is what unlocks it — never a silent default.
    expect(canLaunch({ ...onUntrusted, confirmUntrusted: true }, { projects })).toEqual({ ok: true });
  });

  it('refuses on exhausted capacity and names the numbers', () => {
    const config = defaultConfigFor({ id: 'tm-1', agentTool: 'claude-code', model: 'claude-sonnet-5' });
    const verdict = canLaunch(config, { projects: [], capacity: { slotsFree: 0, slotsTotal: 4 } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('0 of 4');
  });

  it('never launches anonymously', () => {
    const config = { ...defaultConfigFor({ id: 'tm-1' }), teamMemberId: null };
    expect(canLaunch(config, { projects: [] }).ok).toBe(false);
  });

  it('refuses missing or incompatible persisted model/tool values instead of falling back', () => {
    expect(defaultConfigFor({ id: 'tm-1' })).toMatchObject({ agentToolId: null, model: null });
    expect(canLaunch(defaultConfigFor({ id: 'tm-1' }), { projects: [] })).toEqual(expect.objectContaining({
      ok: false,
      reason: expect.stringContaining('no persisted agent tool'),
    }));
    expect(canLaunch(defaultConfigFor({
      id: 'tm-1', agentTool: 'claude-code', model: 'gpt-5.6-sol',
    }), { projects: [] })).toEqual(expect.objectContaining({
      ok: false,
      reason: expect.stringContaining('not a truthful Claude Code launch option'),
    }));
  });

  it('D46 — a teammate load of NULL and a load of ZERO are different renderings', () => {
    // The property A1c's capacity chip depends on, and the one my own broken
    // createdBy gate would have violated: unknown is not zero. A consumer that
    // merged them would report every teammate free while the edges were still
    // loading, which is a false "go ahead" at the moment of launch.
    const unknown = describeTeammateLoad({ teamMemberId: 'tm-1', liveSessionCount: null });
    const measuredZero = describeTeammateLoad({ teamMemberId: 'tm-1', liveSessionCount: 0 });
    expect(unknown).not.toBe(measuredZero);
    expect(unknown).toBe(EDGES_NOT_HYDRATED_REASON);
    expect(measuredZero).toBe('no live sessions');
    // A caller-supplied reason wins, so a different hollow cause can say so.
    expect(
      describeTeammateLoad({ teamMemberId: 'tm-1', liveSessionCount: null, hollowReason: 'edges refused' }),
    ).toBe('edges refused');
  });

  it('D46 — counts read as the canvas draws them, singular and plural', () => {
    expect(describeTeammateLoad({ teamMemberId: 'tm-1', liveSessionCount: 1 })).toBe(
      '● 1 live session already',
    );
    expect(describeTeammateLoad({ teamMemberId: 'tm-1', liveSessionCount: 3 })).toBe(
      '● 3 live sessions already',
    );
  });

  it('D51.3 — only ACTIVE profiles are selectable; draft and retired refuse WITH reasons', () => {
    const opts = [
      { profileId: 'p-a', label: 'Reviewer', status: 'active' as const },
      { profileId: 'p-d', label: 'Draft one', status: 'draft' as const },
      { profileId: 'p-r', label: 'Old one', status: 'retired' as const },
    ];
    expect(opts.filter(profileSelectable).map((o) => o.profileId)).toEqual(['p-a']);
    // Visible and refused, never hidden — the same rows appear in the profiles
    // view, so hiding them here would make two surfaces disagree.
    expect(profileRefusal(opts[0])).toBeNull();
    expect(profileRefusal(opts[1])).toContain('not activated yet');
    expect(profileRefusal(opts[2])).toContain('already pinned it');
  });

  it('D51.3 — the resolution CHAIN is returned, not just its winner', () => {
    // An inherited default and a deliberate pick look identical once resolved.
    const chain = [
      { source: 'space-default' as const, profileId: 'p-space', label: 'Space default' },
      { source: 'teammate-default' as const, profileId: 'p-tm', label: "Scout's default" },
      { source: 'explicit' as const, profileId: null, label: '' },
    ];
    const out = resolveProfileChain(chain);
    expect(out.resolution).toEqual({ profileId: 'p-tm', label: "Scout's default", source: 'teammate-default' });
    expect(out.effectiveIndex).toBe(1);
    expect(out.chain).toHaveLength(3);

    // An explicit pick wins over both defaults.
    const explicit = resolveProfileChain([...chain.slice(0, 2), { source: 'explicit' as const, profileId: 'p-x', label: 'Picked' }]);
    expect(explicit.resolution.source).toBe('explicit');

    // Nothing anywhere is a real state, not an error.
    const none = resolveProfileChain([{ source: 'space-default' as const, profileId: null, label: '' }]);
    expect(none.effectiveIndex).toBe(-1);
    expect(none.resolution.source).toBe('none');
    expect(describeProfile(none.resolution)).toContain('no interaction profile');
  });

  it('D51.3 — the immutability caption exists to be shown BEFORE commit', () => {
    expect(PROFILE_PINNED_CAPTION).toContain('Pinned at launch');
    expect(PROFILE_PINNED_CAPTION).toContain('even if the profile is edited or retired later');
  });

  it('D51.4 — extra projects are ADDITIVE and never silently accepted', () => {
    // The launch root is genuinely performable; the extras are in_project edges
    // the stamped seam cannot write, so they are refused with the mechanism.
    const config = {
      ...defaultConfigFor({ id: 'tm-1', agentTool: 'claude-code', model: 'claude-sonnet-5' }),
      target: { kind: 'project' as const, projectId: 'p-root' },
      additionalProjectIds: ['p-two', 'p-three'],
    };
    const input = buildSpawnInput({ clientMutationId: 'c', spaceId: 's', config });
    // Only the ROOT reaches spawn — the contract's projectId is singular.
    expect(input.projectId).toBe('p-root');
    expect(input).not.toHaveProperty('additionalProjectIds');
    expect(ADDITIONAL_PROJECTS_UNAVAILABLE_REASON).toContain('in_project edges');
    // And the shape is additive: a config without extras is unchanged, so the
    // skeleton built against the doorbelled sha keeps working.
    const plain = defaultConfigFor({ id: 'tm-1' });
    expect(plain.additionalProjectIds).toBeUndefined();
  });

  it('offers no models for a tool it does not know, rather than guessing', () => {
    expect(modelsFor('some-future-tool')).toEqual([]);
    expect(modelsFor('claude-code').length).toBeGreaterThan(0);
  });

  it('offers the concrete launch model identifiers requested by the node', () => {
    expect(modelsFor('claude-code')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-opus-5', label: 'Claude Opus 5' }),
      expect.objectContaining({ id: 'claude-fable-5', label: 'Claude Fable 5' }),
      expect.objectContaining({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }),
    ]));
    expect(modelsFor('codex')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-5.6-sol', label: 'OpenAI GPT 5.6' }),
      expect.objectContaining({ id: 'gpt-5.6-terra', label: 'OpenAI GPT 5.6 Terra' }),
    ]));
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

  // Was: `needs(idleRow, 'live') === true`. That assertion only ever passed
  // in the abstract — `statusOf` could not return 'live' for an idle session,
  // so the pairing never occurred on real data. Once it could, this predicate
  // banded EVERY quiet session as NEEDS ATTENTION and flattened the session
  // tree, because the attention band does not nest. 'idle' is quiet, not
  // blocked, and nothing on the row separates the two.
  it('NEVER derives attention from liveness — idle is quiet, not blocked', () => {
    const needs = getKind('work_session').list.needsAttentionGroup!;
    const row = { id: 's1', kind: 'work_session' as const, activityAt: '', status: 'idle', blockedCount: 0 };
    // The pairing that used to fire. It must not, or the tree collapses again.
    expect(needs(row, 'live')).toBe(false);
    expect(needs(row, 'unknown')).toBe(false);
    expect(needs(row, 'stale')).toBe(false);
    expect(needs({ ...row, status: 'running' }, 'live')).toBe(false);
    // Attention is raised by an explicit server fact (`badges.attention`),
    // which the list panel ORs in at the call site — never by this predicate.
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
    project: 'governed',
    interaction_profile: 'restricted',
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

  it('ships Terminal and Chat on work_session only', () => {
    expect(getKind('work_session').panel.contentSurfaces).toEqual(['terminal', 'chat']);
    for (const row of allKinds()) {
      if (row.kind === 'work_session') continue;
      expect(row.panel.contentSurfaces).toBeUndefined();
    }
  });

  it("D2: chat surfaces end at the composer — composition:'chat' on channel and work_session only", () => {
    // The flag is what the panel's strip/footer exclusion reads; work_session
    // is already excluded via the terminal arm, so there it states the reason
    // structurally rather than changing behaviour.
    for (const row of allKinds()) {
      const expected = row.kind === 'channel' || row.kind === 'work_session' ? 'chat' : undefined;
      expect(row.panel.composition, String(row.kind)).toBe(expected);
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

  /**
   * THE ARTWORK GUARDS — the defect that produced them, stated so nobody
   * relaxes them later: thirteen of the twenty text glyphs (◻ ▣ ▦ ◈ ❖ ◇ ◉ ◍
   * ◆ ⬢ ✧ ✦ ⌬) were the same small lozenge at the size they ship at, so the
   * Connections tab showed a reader WHAT was linked without showing WHICH KIND
   * it was. Totality alone would not have caught that — every one of those
   * kinds HAD an icon. Uniqueness is the assertion that matters.
   */
  it('gives every kind DRAWN artwork, not just a character', () => {
    for (const row of allKinds()) {
      expect(row.iconArt.length, `${row.kind} has no artwork`).toBeGreaterThan(0);
      for (const d of row.iconArt) {
        // Path data, on the 16×16 grid every mark is authored to.
        expect(d, `${row.kind} draws something that is not a path`).toMatch(/^M[\s\d.-]/);
      }
    }
  });

  it('NO TWO KINDS SHARE A MARK — the whole point of the set', () => {
    const seen = new Map<string, string>();
    for (const row of allKinds()) {
      const signature = row.iconArt.join('|');
      const owner = seen.get(signature);
      expect(owner, `${row.kind} draws exactly what ${owner} draws`).toBeUndefined();
      seen.set(signature, row.kind);
    }
  });

  it('every mark stays inside the 16×16 grid it is drawn on', () => {
    // A path that overflows the viewBox is clipped, and a clipped icon is a
    // DIFFERENT icon — silently, and only at some sizes. Absolute coordinates
    // only: relative arc/curve segments are offsets and mean nothing here.
    for (const row of allKinds()) {
      for (const d of row.iconArt) {
        for (const n of d.match(/(?<![a-zA-Z\d.])-?\d+(\.\d+)?/g) ?? []) {
          const v = Math.abs(Number(n));
          expect(v, `${row.kind} draws at ${n}, outside 0–16`).toBeLessThanOrEqual(16);
        }
      }
    }
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

  it('FINDING #9 — an AVAILABLE action with no dispatcher fails LOUDLY, never inertly', () => {
    // Enabled-inert is the failure the user reported: click, nothing happens,
    // no signal to anyone. A missing dispatcher is a wiring defect that cannot
    // be fixed by the user, so it must not be absorbed. Disabled-with-reason
    // is the honest state; silence is not.
    expect(() =>
      resolveAction('run').run({
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
      }),
    ).toThrow(/no dispatcher is wired/);
  });

  it('stays silent for a DISABLED action even with no dispatcher', () => {
    // The refusal is the answer there — availability already told the truth,
    // so there is nothing inert about declining to act.
    expect(() => resolveAction('complete').run({ spaceId: 's', entityId: 'e1', capabilities: null })).not.toThrow();
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

/**
 * §15.1 — THE `edit` VERB AND ITS FIELDS ARE ONE DECLARATION.
 *
 * The dialog is generic: it draws whatever `editFields` names and nothing else.
 * That makes two half-declarations possible, and both are silent failures
 * rather than crashes, which is why they are asserted here rather than left to
 * a reviewer:
 *
 *   · `edit` in `primaries` with no `editFields` — a live button that opens a
 *     dialog with no inputs. `EditEntityDialog` renders null on an empty array,
 *     so the verb would simply do nothing when pressed. That is the
 *     enabled-and-inert shape R5 #9 names, and this is the only control that
 *     would ever see it.
 *   · `editFields` with no `edit` verb — fields declared and unreachable, so a
 *     kind's topic becomes uneditable again exactly as it was before this work,
 *     and every test of the dialog stays green while the app loses the feature.
 *
 * Driven off `allKinds()` so a kind added tomorrow is covered without anyone
 * remembering to add it here.
 */
describe('§15.1 — edit declares its fields, and fields declare their verb', () => {
  it('every kind offering `edit` declares the fields the dialog will draw', () => {
    const offenders = allKinds()
      .filter((k) => (k.panel.primaries ?? []).includes('edit'))
      .filter((k) => (k.editFields?.length ?? 0) === 0)
      .map((k) => k.kind);
    expect(offenders, `edit opens an empty dialog on: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every kind declaring fields offers the verb that reaches them', () => {
    const offenders = allKinds()
      .filter((k) => (k.editFields?.length ?? 0) > 0)
      .filter((k) => !(k.panel.primaries ?? []).includes('edit'))
      .map((k) => k.kind);
    expect(offenders, `fields are unreachable on: ${offenders.join(', ')}`).toEqual([]);
  });

  it('a content field names the member it patches; a title field does not need one', () => {
    // `PatchEntityInput` carries `title` at the top level and everything else
    // inside `content` — a content field with no `source` would serialize as
    // `content[''] = value` and be dropped by the server's kind dispatch.
    const offenders: string[] = [];
    for (const kind of allKinds()) {
      for (const field of kind.editFields ?? []) {
        if (field.target === 'content' && !field.source) offenders.push(`${kind.kind} → ${field.label}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * THE TASK'S DUE DATE — the write surface the field never had.
   *
   * `dueDate` was modelled end to end and fillable only from the CLI: the
   * column, the `PatchTaskInput` member, the `::date` sort (`BY_DUE`, offered
   * on this very row) and the read projection all existed with no control
   * behind them. The three things pinned here are the three that make it work
   * rather than merely appear:
   *
   *   · `valueType: 'date'` — a calendar day, matching a `date` column. A
   *     plain text field would let a locale string reach a column that refuses
   *     it, and a datetime control would invent precision the column cannot
   *     hold.
   *   · `readFrom: 'state'` — the server projects `due_date` onto
   *     `EntityState` and leaves it out of `contentOf`, so a field seeded from
   *     content opens BLANK on a task that has a due date. Since an empty date
   *     is an explicit `null`, that blank is a pending deletion: open the
   *     dialog, press Save, lose the date. This is the assertion that would
   *     have caught it.
   *   · NOT `required` — `tasks.due_date` is nullable, so "no due date" is a
   *     value the database holds rather than a hole in the record.
   */
  it('the task offers a Title and a due date read from state, written to content', () => {
    const fields = getKind('task').editFields ?? [];
    expect(fields.map((f) => f.label)).toEqual(['Title', 'Due date']);

    const dueDate = fields.find((f) => f.source === 'dueDate');
    expect(dueDate?.target).toBe('content');
    expect(dueDate?.readFrom).toBe('state');
    expect(dueDate?.valueType).toBe('date');
    expect(dueDate?.required ?? false).toBe(false);

    // The sort this row already offered now has something a human can fill.
    expect(getKind('task').list.sort.map((s) => s.key)).toContain('dueDate');
  });

  it('the channel offers exactly Name and an OPTIONAL Topic (user ruling 2026-08-07)', () => {
    const fields = getKind('channel').editFields ?? [];
    expect(fields.map((f) => [f.label, Boolean(f.required)])).toEqual([
      ['Name', true],
      // `channels.topic` is `not null default ''` — an omitted topic is a value
      // the database already stores, which is what makes optional honest here.
      ['Topic', false],
    ]);
    // The name IS `channels.name`, so it carries that column's grammar.
    expect(fields[0]?.grammar).toBe('slug');
  });
});
