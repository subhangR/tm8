/**
 * Seed world — the prototype's golden narrative, extended.
 *
 * 1 space (maestro-core) · 3 channels · the T-100 milestone subtree
 * (T-101…T-108 incl. T-103a/b) · 4-doc tree · 2 humans (Subhang, Mira) ·
 * 3-agent org (Forge → Scout, Probe) · 2 PRs + a commit · spells/skills
 * equipped to Forge · points ledger · reactions · read-marks · notifications ·
 * task axes (type, milestone).
 *
 * Every core edge type is represented at least once: assigned_to, depends_on
 * (hard + soft), attached_to (incl. pinned shelf), tracks, pulled (with
 * pinnedVersion), working_on, completed_by, equips, relates_to, and one x:*
 * custom type. Reactions are likes/dislikes/stars edges internally.
 *
 * The seed drives the world's OWN commands wherever one exists, so history
 * (versions, counters, awards, notifications, activity) is real, not painted.
 * Seeding happens on a timeline ending "now": doc_spec sits at v4 with Forge's
 * pull pinned to v4 — the simulation's Mira-edit bumps it to v5 and the pin
 * goes stale everywhere at once.
 */
import type { Clock } from './internal';
import { MockWorld } from './world';

const MIN = 60_000;

export interface SeedIds {
  space: string;
  // actors
  subhang: string; mira: string;
  forge: string; scout: string; probe: string;
  // channels
  chGeneral: string; chBuild: string; chDesign: string;
  // docs
  docSpec: string; docEntityGraph: string; docUiContract: string; docRollout: string;
  // tasks
  t100: string; t101: string; t102: string; t103: string; t103a: string; t103b: string;
  t104: string; t105: string; t106: string; t107: string; t108: string;
  // tracking + kit + file
  pr241: string; pr248: string; commitA1: string;
  spellReviewer: string; skillGraphify: string; fileWireframes: string;
  // conversation anchors used by the simulation
  forgeProgressMessage: string;
  // saved views
  viewDependencies: string; viewDocsTree: string; viewForgeKit: string;
}

export interface SeededWorld { world: MockWorld; ids: SeedIds }

export function createSeededWorld(baseClock?: Clock): SeededWorld {
  let override: number | null = null;
  const clock: Clock = () => override ?? (baseClock ? baseClock() : Date.now());
  const world = new MockWorld(clock);

  // Seed on a timeline that ends "now": start 7 days ago, advance per step.
  let t = clock() - 7 * 24 * 60 * MIN;
  const step = (minutes: number): void => { t += minutes * MIN; override = t; };
  step(0);

  // --- space + axes ----------------------------------------------------------
  const space = 'spc_maestro_core';
  world.spaces.set(space, {
    id: space, name: 'maestro-core', description: 'Core build space for Maestro Collab V2',
    githubRepo: 'subhang/agent-maestro', createdAt: t,
    invites: [{ id: 'inv_0001', code: 'CORE-JOIN', maxUses: 10, uses: 2, expiresAt: null, revoked: false }],
  });
  world.createTaskAxis(space, { name: 'type', axisValues: ['default', 'code', 'design', 'review', 'test'], kind: 'default', position: 0 });
  world.createTaskAxis(space, { name: 'milestone', axisValues: ['v2-alpha', 'v2-beta', 'ga'], kind: 'manual', position: 1 });

  // --- humans ----------------------------------------------------------------
  const subhang = world.createEntityRec({
    id: 'ent_mem_subhang', spaceId: space, createdById: 'ent_mem_subhang',
    data: { kind: 'member', member: { userId: 'uid_subhang', displayName: 'Subhang', role: 'owner', avatar: null, joinedAt: t } },
  }).id;
  world.viewerId = subhang;
  step(5);
  const mira = world.createEntityRec({
    id: 'ent_mem_mira', spaceId: space, createdById: subhang,
    data: { kind: 'member', member: { userId: 'uid_mira', displayName: 'Mira', role: 'member', avatar: null, joinedAt: t } },
  }).id;

  // --- agent org (Forge → Scout, Probe: homogeneous team_member tree) --------
  step(10);
  const forge = world.createEntityRec({
    id: 'ent_tm_forge', spaceId: space, createdById: subhang,
    data: { kind: 'team_member', teamMember: {
      ownerMemberId: subhang, name: 'Forge', role: 'Lead implementer',
      identity: 'You are Forge, lead implementation agent for the V2 build.',
      memories: ['Prefers scoped tsc over full builds'], model: 'claude-fable-5',
      agentTool: 'claude', mode: 'coordinated-worker', avatar: '🔥',
      capabilities: { canSpawnSessions: true }, commandPermissions: { git: false },
    } },
  }).id;
  step(1);
  const scout = world.createEntityRec({
    id: 'ent_tm_scout', spaceId: space, parentId: forge, createdById: subhang,
    data: { kind: 'team_member', teamMember: {
      ownerMemberId: subhang, name: 'Scout', role: 'Docs & research',
      identity: 'You are Scout, the reader-of-everything.', memories: [],
      model: 'claude-opus-5', agentTool: 'claude', mode: 'worker', avatar: '🧭',
      capabilities: {}, commandPermissions: {},
    } },
  }).id;
  step(1);
  const probe = world.createEntityRec({
    id: 'ent_tm_probe', spaceId: space, parentId: forge, createdById: subhang,
    data: { kind: 'team_member', teamMember: {
      ownerMemberId: subhang, name: 'Probe', role: 'Test harness',
      identity: 'You are Probe, the verifier.', memories: [],
      model: 'claude-opus-5', agentTool: 'claude', mode: 'worker', avatar: '🛰️',
      capabilities: {}, commandPermissions: {},
    } },
  }).id;

  // --- channels ---------------------------------------------------------------
  step(10);
  const chGeneral = world.createEntityRec({
    id: 'ent_ch_general', spaceId: space, createdById: subhang, position: 0,
    data: { kind: 'channel', channel: { name: 'general', topic: 'Space-wide chatter' } },
  }).id;
  const chBuild = world.createEntityRec({
    id: 'ent_ch_build', spaceId: space, createdById: subhang, position: 1,
    data: { kind: 'channel', channel: { name: 'v2-build', topic: 'Collab V2 build room — specs, tasks, agents at work' } },
  }).id;
  const chDesign = world.createEntityRec({
    id: 'ent_ch_design', spaceId: space, createdById: mira, position: 2,
    data: { kind: 'channel', channel: { name: 'design', topic: 'Paper & ink' } },
  }).id;

  // --- doc tree (spec at the root; 3 chapters) --------------------------------
  step(30);
  const docSpec = world.createEntity({
    spaceId: space, kind: 'doc', title: 'Collab V2 Spec', actorId: mira,
    content: { body: '# Collab V2 Spec\n\nThe entity graph is the product: a small set of first-class kinds sharing hierarchy, edges, discussion, and reactions.\n\nSee the chapter docs for the entity graph, the UI contract, and rollout notes.', format: 'markdown' },
  }).entity!.id;
  step(3);
  const docEntityGraph = world.createEntity({
    spaceId: space, kind: 'doc', title: 'Entity Graph', parentId: docSpec, actorId: mira,
    content: { body: '## Entity Graph\n\nEnvelope + detail tables; edges typed core + x:* free-form; hierarchy is homogeneous and lives on the envelope.', format: 'markdown' },
  }).entity!.id;
  step(3);
  const docUiContract = world.createEntity({
    spaceId: space, kind: 'doc', title: 'UI Contract', parentId: docSpec, actorId: mira,
    content: { body: '## UI Contract\n\nEntitySummary for Z1/Z2, EntityDetail for Z3/Z4. Components never see anything rawer.', format: 'markdown' },
  }).entity!.id;
  step(3);
  const docRollout = world.createEntity({
    spaceId: space, kind: 'doc', title: 'Rollout Notes', parentId: docSpec, actorId: subhang,
    content: { body: '## Rollout\n\nMock-first UI, backend swaps in behind the facade.', format: 'markdown' },
  }).entity!.id;

  // Bump doc_spec to v4 (three content edits) — the simulation later takes it
  // to v5, which is what turns Forge's pinned pull stale.
  step(60);
  world.patchEntity(docSpec, { expectedVersion: 1, actorId: mira, content: { body: '# Collab V2 Spec (v2)\n\nAdded the four universal capabilities: hierarchy, edges, discussion, reactions & points.' } });
  step(240);
  world.patchEntity(docSpec, { expectedVersion: 2, actorId: mira, content: { body: '# Collab V2 Spec (v3)\n\nDependency semantics: hard deps block; resolution is kind-aware; unblock ripples notify dependents.' } });
  step(240);
  world.patchEntity(docSpec, { expectedVersion: 3, actorId: subhang, content: { body: '# Collab V2 Spec (v4)\n\nPull = projection with a pinned version. Staleness is contentStale (version) + discussionMoved (activity), two separate signals.' } });

  // --- the T-100 milestone subtree ---------------------------------------------
  step(120);
  const mkTask = (opts: {
    title: string; description: string; parent?: string; position: number;
    type: string; priority?: 'low'|'medium'|'high'|'urgent';
    criteria?: Array<{ text: string; done?: boolean }>; points?: number | null;
    actor?: string; due?: string | null;
  }): string => {
    const res = world.createTask({
      spaceId: space, title: opts.title, description: opts.description,
      parentId: opts.parent ?? null, position: opts.position,
      axes: { type: opts.type, milestone: 'v2-alpha' },
      priority: opts.priority ?? 'medium',
      acceptanceCriteria: opts.criteria ?? [],
      pointsEstimate: opts.points ?? null,
      dueDate: opts.due ?? null,
      actorId: opts.actor ?? subhang,
    });
    return res.entity!.id;
  };

  const t100 = mkTask({
    title: 'T-100 · Collab V2 milestone', position: 0, type: 'default', priority: 'urgent',
    description: 'Ship the Collab V2 modular workspace: entity contract, subsystems, screens, live layer.',
    criteria: [{ text: 'All child tasks done' }],
  });
  step(2);
  const t101 = mkTask({
    title: 'T-101 · Schema foundation', parent: t100, position: 0, type: 'code', priority: 'high',
    description: 'Entities envelope, edges, counters, ledger, RLS scaffolding.',
    criteria: [{ text: 'Envelope + detail tables', done: true }, { text: 'Edge registry trigger', done: true }],
  });
  step(2);
  const t102 = mkTask({
    title: 'T-102 · RLS policies', parent: t100, position: 1, type: 'code',
    description: 'Row-level security for all space-scoped tables; agent attribution rule.',
    criteria: [{ text: 'is_space_member helper' }, { text: 'Policy tests green' }],
  });
  step(2);
  const t103 = mkTask({
    title: 'T-103 · Facade routes', parent: t100, position: 2, type: 'code',
    description: 'The /v2 route matrix: reads + commands behind one façade.',
  });
  step(1);
  const t103a = mkTask({
    title: 'T-103a · Read routes', parent: t103, position: 0, type: 'code',
    description: 'Spaces, navigation, entity detail, collections, graph, messages.',
  });
  step(1);
  const t103b = mkTask({
    title: 'T-103b · Command routes', parent: t103, position: 1, type: 'code',
    description: 'Tasks, entities, edges, placements, messages, points, completion.',
  });
  step(2);
  const t104 = mkTask({
    title: 'T-104 · Entity panel UI', parent: t100, position: 3, type: 'design', priority: 'high',
    description: 'Z3 panel: header, action bar, Content/Discussion/Connections/Activity tabs, footer.',
    criteria: [
      { text: 'Uniform anatomy across kinds', done: true },
      { text: 'Connections rail grouped by type', done: true },
      { text: 'Panel stack integration' },
    ],
    points: 20,
  });
  step(2);
  const t105 = mkTask({
    title: 'T-105 · Graph canvas', parent: t100, position: 4, type: 'design',
    description: 'xyflow canvas: typed edges, containment clusters, dependency mode.',
  });
  step(2);
  const t106 = mkTask({
    title: 'T-106 · Docs reader', parent: t100, position: 5, type: 'design',
    description: 'Z4 doc reader: serif body, chapter tree, margin threads.',
    criteria: [{ text: 'Reader typography', done: true }, { text: 'Margin threads anchored', done: true }],
    actor: subhang,
  });
  step(2);
  const t107 = mkTask({
    title: 'T-107 · Leaderboard', parent: t100, position: 6, type: 'review',
    description: 'Ledger sums, award feed, tasteful celebration moment.',
  });
  step(2);
  const t108 = mkTask({
    title: 'T-108 · Onboarding tour', parent: t100, position: 7, type: 'test', priority: 'low',
    description: 'Newcomer orientation: Home explains itself, graph focus walk.',
  });

  // --- tracking entities + kit + file ------------------------------------------
  step(30);
  const pr241 = world.createEntity({
    spaceId: space, kind: 'pull_request', title: 'feat(collab): schema foundation', actorId: forge,
    content: { repo: 'subhang/agent-maestro', number: 241, state: 'merged', url: 'https://github.com/subhang/agent-maestro/pull/241', headSha: 'a1b2c3d' },
  }).entity!.id;
  step(2);
  const commitA1 = world.createEntity({
    spaceId: space, kind: 'commit', title: 'schema: envelope + edges + counters', actorId: forge,
    content: { repo: 'subhang/agent-maestro', sha: 'a1b2c3d4e5f6', message: 'schema: envelope + edges + counters\n\nEntities registry, typed edge table, counter triggers.', author: 'Forge' },
  }).entity!.id;
  step(5);
  const pr248 = world.createEntity({
    spaceId: space, kind: 'pull_request', title: 'feat(ui): entity panel', actorId: forge,
    content: { repo: 'subhang/agent-maestro', number: 248, state: 'open', url: 'https://github.com/subhang/agent-maestro/pull/248', headSha: 'f7e8d9c' },
  }).entity!.id;
  step(5);
  const spellReviewer = world.createEntity({
    spaceId: space, kind: 'spell', title: 'Review ritual', actorId: subhang,
    content: { description: 'Adversarial self-review before requesting human eyes.' },
  }).entity!.id;
  const skillGraphify = world.createEntity({
    spaceId: space, kind: 'skill', title: 'graphify', actorId: subhang,
    content: { description: 'Knowledge-graph the codebase before editing.', content: '# graphify\nRun graphify query first.' },
  }).entity!.id;
  const fileWireframes = world.createEntity({
    spaceId: space, kind: 'file', title: 'panel-wireframes.png', actorId: mira,
    content: { mimeType: 'image/png', sizeBytes: 482113 },
  }).entity!.id;

  // --- edges: the full taxonomy --------------------------------------------------
  step(10);
  // assigned_to
  world.createEdge({ srcId: t104, dstId: forge, type: 'assigned_to', actorId: subhang });
  world.createEdge({ srcId: t102, dstId: mira, type: 'assigned_to', actorId: subhang });
  world.createEdge({ srcId: t106, dstId: scout, type: 'assigned_to', actorId: subhang });
  world.createEdge({ srcId: t103, dstId: subhang, type: 'assigned_to', actorId: subhang });
  world.createEdge({ srcId: t105, dstId: probe, type: 'assigned_to', actorId: subhang });
  // depends_on — hard (T-105 blocked on T-104; T-106's dep already resolved) + soft
  world.createEdge({ srcId: t105, dstId: t104, type: 'depends_on', props: { hard: true, note: 'canvas nodes are Z2 cards' }, actorId: subhang });
  world.createEdge({ srcId: t106, dstId: t101, type: 'depends_on', props: { hard: true }, actorId: subhang });
  world.createEdge({ srcId: t107, dstId: t106, type: 'depends_on', props: { hard: false, note: 'nice ordering, not blocking' }, actorId: subhang });
  // tracks
  world.createEdge({ srcId: t101, dstId: pr241, type: 'tracks', actorId: forge });
  world.createEdge({ srcId: t101, dstId: commitA1, type: 'tracks', actorId: forge });
  world.createEdge({ srcId: t104, dstId: pr248, type: 'tracks', actorId: forge });
  // attached_to (channel hub tabs + shelf pins + task attachments)
  world.createEdge({ srcId: docSpec, dstId: chBuild, type: 'attached_to', props: { pinned: true }, actorId: mira });
  world.createEdge({ srcId: t100, dstId: chBuild, type: 'attached_to', props: { pinned: true }, actorId: subhang });
  world.createEdge({ srcId: t104, dstId: chBuild, type: 'attached_to', actorId: subhang });
  world.createEdge({ srcId: forge, dstId: chBuild, type: 'attached_to', actorId: subhang });
  world.createEdge({ srcId: pr248, dstId: chBuild, type: 'attached_to', actorId: forge });
  world.createEdge({ srcId: docUiContract, dstId: t104, type: 'attached_to', actorId: mira });
  world.createEdge({ srcId: fileWireframes, dstId: t104, type: 'attached_to', actorId: mira });
  // equips
  world.createEdge({ srcId: forge, dstId: spellReviewer, type: 'equips', actorId: subhang });
  world.createEdge({ srcId: forge, dstId: skillGraphify, type: 'equips', actorId: subhang });
  world.createEdge({ srcId: t104, dstId: spellReviewer, type: 'equips', actorId: subhang });
  // relates_to + one x:* custom type
  world.createEdge({ srcId: t108, dstId: docRollout, type: 'relates_to', props: { note: 'tour script lives here' }, actorId: subhang });
  world.createEdge({ srcId: t108, dstId: docSpec, type: 'x:inspired_by', actorId: mira });

  // --- pulls (with pinned versions), work, completion ----------------------------
  step(20);
  // T-101 ships: seed its pool, complete it (completed_by + award + ledger).
  world.grantPoints(t101, { amount: 15, reason: 'seed', actorId: subhang });
  world.completeTask(t101, { expectedVersion: 1, completerIds: [forge], actorId: subhang });

  step(30);
  // Forge pulls its task and the spec doc (doc pinned at v4 — sim makes it stale).
  world.pullEntity(t104, { localId: 'local_t104', pinnedVersion: 1, actorId: forge });
  world.pullEntity(docSpec, { localId: 'local_doc_spec', pinnedVersion: 4, actorId: forge });
  // "pulled" generalizes: Subhang installed the graphify skill locally.
  world.pullEntity(skillGraphify, { localId: 'local_skill_graphify', pinnedVersion: 1, actorId: subhang });
  step(5);
  world.setWork(t104, { status: 'working', note: 'building the panel anatomy', actorId: forge });
  step(15);
  world.setWork(t106, { status: 'in_review', actorId: scout });

  // --- points + reactions ----------------------------------------------------------
  step(10);
  world.grantPoints(t104, { amount: 20, reason: 'grant', actorId: subhang }); // the bounty
  world.grantPoints(docSpec, { amount: 5, reason: 'grant', actorId: subhang });
  world.grantPoints(mira, { amount: 8, reason: 'grant', actorId: subhang });
  world.setReaction(docSpec, { reaction: 'star', enabled: true, actorId: subhang });
  world.setReaction(t104, { reaction: 'like', enabled: true, actorId: mira });
  world.setReaction(spellReviewer, { reaction: 'star', enabled: true, actorId: mira });
  world.setReaction(pr241, { reaction: 'like', enabled: true, actorId: subhang });

  // --- conversation ------------------------------------------------------------------
  step(10);
  world.postMessage({ anchorId: chGeneral, body: 'Welcome to maestro-core — V2 build starts this week.', actorId: subhang });
  world.postMessage({ anchorId: chGeneral, body: 'Paper & ink theme locked for the workspace. No neon.', actorId: mira });

  step(20);
  world.postMessage({ anchorId: chBuild, body: 'Kicking off the V2 build room. Spec is pinned on the shelf.', actorId: mira });
  world.postMessage({
    anchorId: chBuild,
    body: `Milestone board is live — track it here {{embed:${t100}}}`,
    actorId: subhang,
  });
  step(5);
  const forgeProgress = world.postMessage({
    anchorId: t104,
    body: 'Panel scaffolding in place: header, action bar, and the four tabs render for every kind.',
    actorId: forge,
  }).entity!.id;
  step(4);
  const correction = world.postMessage({
    anchorId: t104, parentMessageId: forgeProgress,
    body: 'Looks right — but keep the tab order identical for every kind, no per-kind reordering.',
    mentions: [{ entityId: forge, kind: 'team_member', display: 'Forge' }],
    actorId: subhang,
  }).entity!.id;
  step(2);
  world.postMessage({
    anchorId: t104, parentMessageId: correction,
    body: 'Ack — tab order stays universal. Adjusting now.',
    actorId: forge,
  });
  step(6);
  world.postMessage({
    anchorId: chBuild,
    body: `Progress from the panel task — wireframes attached {{embed:${t104}}}`,
    mentions: [{ entityId: mira, kind: 'member', display: 'Mira' }],
    attachments: [{ fileEntityId: fileWireframes, name: 'panel-wireframes.png', mime: 'image/png' }],
    actorId: forge,
  });
  step(3);
  world.postMessage({ anchorId: docSpec, body: 'Margin note: the two-signal staleness model (version vs activity) is the key insight — keep it front and center.', actorId: mira });
  world.postMessage({ anchorId: subhang, body: 'Welcome wall post — great kickoff!', actorId: mira });

  // --- read marks (viewer has 2 unread in #v2-build, 1 margin note unread) -------------
  world.markRead(chGeneral, { actorId: subhang });
  // Mark #v2-build as read as of before the last two messages there:
  world.readMarks.set(`${subhang}|${chBuild}`, t - 10 * MIN);
  world.markRead(chBuild, { actorId: mira });

  // --- saved views (the three seeded subgraphs of the Graph screen) --------------------
  step(2);
  const viewDependencies = world.createSavedView(space, {
    name: 'V2 milestone · dependencies',
    shareMode: 'space',
    query: { spaceId: space, kinds: ['task'], subtreeOf: t100, layout: 'graph', groupBy: undefined, sort: 'position' },
    graphLayout: {
      [t101]: { x: 0, y: 120 }, [t104]: { x: 260, y: 40 }, [t105]: { x: 520, y: 40 },
      [t106]: { x: 260, y: 200 }, [t107]: { x: 520, y: 200 },
    },
    actorId: subhang,
  }).id;
  const viewDocsTree = world.createSavedView(space, {
    name: 'Spec docs · tree',
    shareMode: 'space',
    query: { spaceId: space, kinds: ['doc'], subtreeOf: docSpec, layout: 'tree', sort: 'position' },
    actorId: mira,
  }).id;
  const viewForgeKit = world.createSavedView(space, {
    name: 'Forge · kit',
    shareMode: 'space',
    query: { spaceId: space, layout: 'graph', kinds: ['team_member', 'spell', 'skill', 'task'] },
    actorId: subhang,
  }).id;

  // --- ambient presence -----------------------------------------------------------------
  world.setPresence(chBuild, [mira, forge], []);

  // Seed complete: return to live time and clear both event backlogs so
  // subscribers start from a quiet world.
  override = null;
  world.drainEvents();
  world.drainPresenceEvents();

  return {
    world,
    ids: {
      space,
      subhang, mira, forge, scout, probe,
      chGeneral, chBuild, chDesign,
      docSpec, docEntityGraph, docUiContract, docRollout,
      t100, t101, t102, t103, t103a, t103b, t104, t105, t106, t107, t108,
      pr241, pr248, commitA1,
      spellReviewer, skillGraphify, fileWireframes,
      forgeProgressMessage: forgeProgress,
      viewDependencies, viewDocsTree, viewForgeKit,
    },
  };
}
