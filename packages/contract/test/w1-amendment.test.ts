/**
 * W1.A acceptance tests for the Vega-adopted W0 amendment dossier.
 *
 * These assertions intentionally pin the exact additive catalog delta rather
 * than merely checking the final count: an accidental companion-only row must
 * fail the same proof as a missing adopted row.
 */
import { describe, expect, it } from 'vitest';
import {
  CoreEntityKindSchema,
  ExecutionSpawnInputSchema,
  OPERATIONS,
  PostMessageInputSchema,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
} from '../src/index.js';

const ADDITIVE_OPERATIONS = [
  { name: 'spaces.menu.get', method: 'GET', path: '/v2/spaces/:spaceId/menu', kind: 'read', status: 'v1' },
  { name: 'spaces.menu.update', method: 'PUT', path: '/v2/spaces/:spaceId/menu', kind: 'command', status: 'v1' },
  { name: 'spaces.defaultChannel.set', method: 'PUT', path: '/v2/spaces/:spaceId/default-channel', kind: 'command', status: 'v1' },
  { name: 'projects.associations.correct', method: 'POST', path: '/v2/entities/:artifactId/commands/correct-project-association', kind: 'command', status: 'v1' },
  { name: 'handoffs.send', method: 'POST', path: '/v2/work-sessions/:workSessionId/handoffs', kind: 'command', status: 'v1' },
  { name: 'handoffs.list', method: 'GET', path: '/v2/work-sessions/:workSessionId/handoffs', kind: 'read', status: 'v1' },
  { name: 'handoffs.withdraw', method: 'POST', path: '/v2/handoffs/:handoffId/withdraw', kind: 'command', status: 'v1' },
  { name: 'messages.attachments.add', method: 'POST', path: '/v2/messages/:messageId/attachments', kind: 'command', status: 'v1' },
  { name: 'messages.attachments.remove', method: 'DELETE', path: '/v2/messages/:messageId/attachments', kind: 'command', status: 'v1' },
  { name: 'messages.delivery.get', method: 'GET', path: '/v2/messages/:messageId/delivery', kind: 'read', status: 'v1' },
  { name: 'entities.feed', method: 'GET', path: '/v2/entities/:id/feed', kind: 'read', status: 'v1' },
  { name: 'entities.context', method: 'GET', path: '/v2/entities/:id/context', kind: 'read', status: 'v1' },
  { name: 'interactionProfiles.propose', method: 'POST', path: '/v2/spaces/:spaceId/interaction-profiles', kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.updateDraft', method: 'PATCH', path: '/v2/interaction-profiles/:profileId/draft', kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.validate', method: 'POST', path: '/v2/interaction-profiles/:profileId/validate', kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.preview', method: 'POST', path: '/v2/interaction-profiles/:profileId/preview', kind: 'read', status: 'v1' },
  { name: 'interactionProfiles.activate', method: 'POST', path: '/v2/interaction-profiles/:profileId/activate', kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.retire', method: 'POST', path: '/v2/interaction-profiles/:profileId/retire', kind: 'command', status: 'v1' },
  { name: 'teamMembers.interactionProfile.setDefault', method: 'PUT', path: '/v2/team-members/:teamMemberId/interaction-profile-default', kind: 'command', status: 'v1' },
  { name: 'spaces.interactionProfile.setDefault', method: 'PUT', path: '/v2/spaces/:spaceId/interaction-profile-default', kind: 'command', status: 'v1' },
  // A21 (D2/C-1): point-in-time PTY liveness for one space's work_sessions.
  { name: 'execution.liveness', method: 'GET', path: '/v2/spaces/:spaceId/execution/liveness', kind: 'read', status: 'v1' },
] as const;

describe('W1 adopted catalog target', () => {
  it('adds exactly A01-A21 in dossier order with exact bindings and kinds', () => {
    // The A01-A21 dossier block is no longer the literal tail (the artifacts
    // amendment appends six rows after it); locate the block by its first row.
    const start = OPERATIONS.findIndex((op) => op.name === ADDITIVE_OPERATIONS[0].name);
    expect(OPERATIONS.slice(start, start + ADDITIVE_OPERATIONS.length)).toEqual(ADDITIVE_OPERATIONS);
  });

  it('reconciles the additive 156-row target without changing reserved honesty', () => {
    // 119 -> 120 (2026-08-01): `execution.journal` joined the catalog without
    // this pin moving — the tree carried a red literal until the next
    // amendment (identity.profile.update, also 2026-08-01) reconciled both.
    // 121 -> 125 (2026-08-02): auth.signup/login/logout (POST commands) +
    // auth.session.get (GET read) — Identity v2 Stage 1 local accounts.
    // 125 -> 126 (2026-08-02): execution.launch (GET read) — what a session was
    // TOLD at spawn: its manifest, its env var NAMES and its two prompts.
    // 126 -> 127 (2026-08-02): projects.directories.list (GET read) — the
    // root-confined node-local folder browser for Space project onboarding.
    // 127 -> 128 (2026-08-07): execution.transcript (GET read) — what a session
    // SAID, read back out of the agent's own native transcript file.
    // 128 -> 129 (2026-08-09): projects.branches.list (GET read) — branch
    // topology for a project working directory, argv-only git, no writes.
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate (Tier 4 git x graph).
    // 131 -> 135: credentials.status (GET/read), delete (DELETE/command),
    // and two login-session POST commands. All four are v1 and human-only.
    // 135 -> 137: projects.files.list/attach.
    // 137 -> 138 (2026-08-09, merge): execution.dispatch (POST command) — the
    // dispatcher's one new catalog row, joining from feat/dispatcher-loops.
    // 142 -> 144 (2026-08-12): collections.addItem (POST command) +
    // collections.removeItem (DELETE command) — membership sugar over the
    // `contains` edge; the collection family's first write verbs.
    // 144 -> 150 (2026-08-12, Git UI landing): execution.gitStatus + gitDiff
    // (GET reads) and gitCheckpoint/gitRollback/gitCommit/gitMerge (POST
    // commands) — the session git rail behind the facade. MEASURED per PIN
    // RULE v3, never carried.
    // 150 -> 152 (2026-08-12, Git UI landing): projects.file.history + projects.file.blame (GET reads) — FileInspector's two survey reads.
    // 152 -> 155 (2026-08-12, Git UI landing): execution.gitCherryPick/gitBranch/gitStash (POST commands) — Tier 2 completion on the session rail.
    // 155 -> 156 (2026-08-13, merge): execution.terminal.start joins from main (#161).
    // 157 -> 158 (2026-08-13, forge write): tracking.pr.merge — the one
    // guarded write door to the forge.
    // 158 -> 159 (2026-08-13, merge union): chat.threads.start — MEASURED on
    // the merged tree; both sides moved this pin independently.
    // 159 -> 163: (unledgered upstream bumps — measured 163 on origin/main
    // 9b938647; the literal had moved without its notes).
    // 163 -> 166 (2026-08-16, W4/132): spaces.taskWorkflows.list (GET read) +
    // .upsert (POST command) + .delete (DELETE command) — per-type status
    // vocabularies. MEASURED per PIN RULE v3, never carried.
    // 166 -> 169 (141): auth.password.change + auth.invite.signup +
    // auth.claim.reissue — the account-lifecycle ops. MEASURED.
    // 169 -> 172 (148, phase 2): spaces.workflows.list (GET read) + .upsert
    // (POST command) + .delete (DELETE command) — the real workflow tables.
    // MEASURED per PIN RULE v3, never carried.
    // 172 -> 197 (2026-09-03, TM8-CONTAINERS-DESIGN §4.1): the 25 `containers.*`
    // rows, all v1, so 170 -> 195. MEASURED on this tree per PIN RULE v3,
    // never carried: `OPERATIONS.length` = 197, `V1_OPERATIONS.length` = 195.
    // The Design's PROSE says 27 rows and is wrong; §4.1's list is 25 and the
    // coordinator ruled on it.
    // 197 -> 198 (187, terminal sharing): execution.sessions.share, v1, so
    // 195 -> 196 too. MEASURED on this tree per PIN RULE v3, never carried.
    // 197 -> 198 (2026-09-19, Changes surface phase 1): execution.gitStage,
    // the index verb (stage|unstage) the review screen commits through. v1,
    // so 195 -> 196. MEASURED on this tree per PIN RULE v3, never carried.
    // 198 -> 199 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
    // branch's execution.gitStage BOTH land, so this moves twice. Git merged
    // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
    // 199 -> 203 (2026-09-23, filesystem skills INTEGRATED WITH main): skills.scan,
    // skills.list, skills.show and skills.preview, all v1, so 197 -> 201. The
    // stack pinned against its own older base and never saw main's 199.
    // MEASURED on the merged tree from this assertion's own failing run.
    // 203 -> 208 (2026-09-23): skills.roots/create/edit/equip/unequip (F4, #648), all v1. MEASURED on the merged tree.
    // 208 -> 209 (2026-09-23, Jev lane F): launch.suggest, a v1 POST command. MEASURED from this assertion's own failing run.
    expect(OPERATIONS).toHaveLength(268); /* +7 spaceLinks.* (W6, 250/251). MEASURED. */ /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +6 credentials.space.{setVisibility,spaceDefaultConsent,claim,myDefault.set,myDefault.clear,usage} (W10b). MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b). MEASURED. */ /* +2 forms.responses.redeliver, forms.pendingForSessions (Forms W3), on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 credentials.space.* and node.credentials.* (SC-3). MEASURED. // +3 credentials.serviceKeys.* (Jev lane K). MEASURED. /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */
    expect(V1_OPERATIONS).toHaveLength(266); /* +7 spaceLinks.* (W6, 250/251). MEASURED. */ /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +6 credentials.space.* (W10b), all v1. MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b). MEASURED. */ /* +2 forms.responses.redeliver, forms.pendingForSessions (Forms W3), on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 (SC-3). MEASURED. // +3 credentials.serviceKeys.* (Jev lane K). MEASURED. // // launch.suggest is v1: 206 -> 207. MEASURED. /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */
    expect(RESERVED_OPERATIONS.map((operation) => operation.name)).toEqual([
      'search.query',
      'bridge.fetchBlob',
    ]);

    const count = (field: 'method' | 'kind', value: string) =>
      OPERATIONS.filter((operation) => operation[field] === value).length;

    expect({
      GET: count('method', 'GET'),
      POST: count('method', 'POST'),
      PATCH: count('method', 'PATCH'),
      DELETE: count('method', 'DELETE'),
      PUT: count('method', 'PUT'),
      WS: count('method', 'WS'),
    // MEASURED on the #204+#209 union: auth.claim.status (GET read) and
    // auth.claim (POST command) join auth.invite.resolve (POST-with-kind-read,
    // so an invite code never reaches a URL) and spaces.members.updateRole
    // (PATCH). GET 58->59, POST 73->75, PATCH 10->11.
    // W4/132 (2026-08-16): GET 59->60 (taskWorkflows.list), POST 75->76
    // (.upsert), DELETE 10->11 (.delete). MEASURED from the failing run.
    // 141: POST 76->79 — auth.password.change + auth.invite.signup +
    // auth.claim.reissue, all POST commands. MEASURED.
    // 148: GET 60->61 (workflows.list), POST 79->80 (.upsert), DELETE 11->12
    // (.delete). MEASURED from the failing run.
    // Containers (§4.1): GET 61->65 (files.get, logs, proxy, providers.list),
    // POST 80->98 (18 command rows), PATCH 11->12 (update), PUT 7->8
    // (files.put), WS 1->2 (containers.stream). MEASURED on this tree.
    //
    // WS IS 2 AND MOUNTS ARE STILL 1. `containers.stream` re-declares
    // `events.subscribe`'s `WS /v2/ws` so the family's socket is discoverable
    // under its own name; it carries `aliasOf` and is excluded from
    // MOUNTED_OPERATIONS, so nothing mounts a second socket. Counting rows and
    // counting mounts are different questions and this pin asks the first.
    // 187: POST 98->99 — execution.sessions.share, a POST command on the
    // entity-command shape. Nothing else moves. MEASURED from the failing run.
    // 2026-09-19 (Changes surface phase 1): POST 98->99 — execution.gitStage,
    // a command row on the session's git path. MEASURED on this tree.
    // POST 99 -> 100 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): both new rows are POST commands. MEASURED on the merged tree from this assertion's own failing run.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): GET 65->68 (skills.list,
    // skills.show, skills.preview), POST 100->101 (skills.scan). MEASURED on the merged tree.
    // 2026-09-23 F4: GET 68->69 (roots), POST 101->104 (create/equip/unequip), PATCH 12->13 (edit). MEASURED.
    // 2026-09-23 Jev lane F: POST 104->105 (launch.suggest). MEASURED.
    // W10b: GET +1, POST +2, DELETE +1, PUT +2 (the six credentials.space.* rows). MEASURED from this assertion's failing run.
    }).toEqual({ GET: 87, /* +7 spaceLinks.* (W6, 250/251): GET +1, POST +5, PATCH +1. MEASURED. */ /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: GET +2 (spaces.projects.list, gate.folders.list), POST +2 creates (projects.link stays, decision 29). MEASURED. */ /* +1/+1 auth.sessions.list/revoke (W4). MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +1 spaces.chatDefaults.get. MEASURED. */ /* +1 launch.defaults (I9b). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* GET +1 pendingForSessions, POST +1 responses.redeliver (Forms W3). MEASURED. */ POST: 127 /* +3 G6 leave/remove/disable. MEASURED. */, PATCH: 17, DELETE: 18, PUT: 17 /* +1 spaces.chatDefaults.set. MEASURED. */, WS: 2 }); /* +1 PUT entities.header.set, +1 DELETE entities.header.clear (headers I4). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // SC-3. MEASURED. /* -1 containers.attention (Attention v2 S7a). MEASURED. */
    expect({
      read: count('kind', 'read'),
      command: count('kind', 'command'),
      stream: count('kind', 'stream'),
    // W4/132: read +1, command +2. MEASURED.
    // 141: command 101->104 (three new commands). MEASURED.
    // 148: read 64->65, command 104->106. MEASURED.
    // Containers: read 65->69, command 106->126, stream 1->2. MEASURED.
    // 187: command 126->127. MEASURED.
    // Changes surface phase 1: command 126->127 (execution.gitStage). MEASURED.
    // command 127 -> 128 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main):
    // execution.sessions.share and execution.gitStage are both kind: command.
    // MEASURED from this assertion's own failing run (Received: command 128).
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): read 69->72, command 128->129.
    // MEASURED on the merged tree.
    // 2026-09-23 F4: read 72->73, command 129->133. MEASURED.
    // 2026-09-23 Jev lane F: command 133->134 (launch.suggest). MEASURED.
    // W10b: read +1 (usage), command +5 (the other credentials.space.* rows). MEASURED from this assertion's failing run.
    }).toEqual({ read: 91, /* +7 spaceLinks.* (W6, 250/251): read +1, command +6. MEASURED. */ /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: read +2, command +2 (projects.link stays, decision 29). MEASURED. */ /* +1/+1 auth.sessions.list/revoke (W4). MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +1 spaces.chatDefaults.get, command +1 spaces.chatDefaults.set. MEASURED. */ /* +1 launch.defaults (I9b). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* read +1, command +1 (Forms W3). MEASURED. */ command: 175 /* +3 G6. MEASURED. */, stream: 2 }); /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // SC-3. MEASURED. /* -1 containers.attention (Attention v2 S7a). MEASURED. */
  });
});

describe('Session-resume amendment (2026-07-31) — one row inside the execution family', () => {
  it('adds exactly execution.resume, bound to the entity-command shape, beside its family', () => {
    const attach = OPERATIONS.findIndex((op) => op.name === 'execution.streams.attach');
    expect(OPERATIONS[attach + 1]).toEqual({
      name: 'execution.resume', method: 'POST', path: '/v2/entities/:id/commands/resume',
      kind: 'command', status: 'v1',
    });
  });
});

describe('Voice channels amendment (2026-07-31 plan) — additive, does not touch the W1 tail', () => {
  it('adds exactly voice.token.create ahead of the frozen A01-A21 tail', () => {
    const firstAdditive = OPERATIONS.findIndex((op) => op.name === ADDITIVE_OPERATIONS[0].name);
    expect(OPERATIONS[firstAdditive - 1]).toEqual({
      name: 'voice.token.create', method: 'POST', path: '/v2/entities/:id/commands/voice-token',
      kind: 'command', status: 'v1',
    });
  });
});

describe('Artifacts amendment (TM8-ARTIFACTS-DESIGN §8.1) — six contiguous rows', () => {
  it('appends exactly the six artifact operations after the A01-A21 tail', () => {
    // No longer the literal tail (identity.profile.update appends after it);
    // locate the block by its first row, the same way the A01-A21 pin does.
    const start = OPERATIONS.findIndex((op) => op.name === 'artifacts.create');
    expect(OPERATIONS.slice(start, start + 6)).toEqual([
      { name: 'artifacts.create', method: 'POST', path: '/v2/artifacts', kind: 'command', status: 'v1' },
      { name: 'artifacts.publish', method: 'POST', path: '/v2/artifacts/:artifactId/revisions', kind: 'command', status: 'v1' },
      { name: 'artifacts.revisions.list', method: 'GET', path: '/v2/artifacts/:artifactId/revisions', kind: 'read', status: 'v1' },
      { name: 'artifacts.preview.start', method: 'POST', path: '/v2/artifacts/:artifactId/preview-sessions', kind: 'command', status: 'v1' },
      { name: 'artifacts.export', method: 'GET', path: '/v2/artifacts/:artifactId/revisions/:revisionNumber/export', kind: 'read', status: 'v1' },
      { name: 'artifacts.restore', method: 'POST', path: '/v2/artifacts/:artifactId/commands/restore-revision', kind: 'command', status: 'v1' },
    ]);
  });
});

describe('W1 frozen-row schema amendments', () => {
  it('adds project, interaction_profile, and (voice plan) voice_channel to the core-kind registry', () => {
    expect(CoreEntityKindSchema.options).toEqual([
      'channel', 'task', 'message', 'member', 'team_member',
      'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
      'work_session', 'collection', 'project', 'interaction_profile',
      'voice_channel', 'memory', 'worktree', 'artifact',
      // 2026-08-09: `loop` — the scheduled-work kind (dreamer-dispatcher §4.4).
      'loop',
      // 2026-08-16: `graph` — the blueprint/diagram kind (Craft P1, R1-R3).
      'graph',
      // 2026-09-03: `chat` — a conversation with a teammate, as an entity
      // (migration 176). Excluded from `CreatableEntityKind`: `chat.start` is
      // its only door, the way `execution.spawn` is `work_session`'s.
      'chat',
      // 2026-09-03: `container` — the machine kind (177, CONTAINERS §3.1).
      'container',
      // 2026-09-17: `drawing` — an Excalidraw canvas as an entity (194).
      // Creatable through the ordinary envelope, unlike `chat`/`container`:
      // nothing runtime stands behind a drawing, only its detail row.
      'drawing',
      // 2026-09-24: `form` — a question set with revisioned responses (209).
      // Not creatable through entities.create: `forms.create` is its door.
      'form',
      // 2026-09-26: `credential` — a space credential's card (W10a). Not
      // creatable: only the credential writers make one, and SQL refuses any
      // other insert. Its secret, hint and login never reach the entity.
      'credential',
      // 2026-09-26: `space_link` + `server` — space links (250, W6). Neither is
      // creatable through entities.create: `spaceLinks.add` is the link's door;
      // `server` has none in W6.
      'space_link',
      'server',
    ]);
    expect(CoreEntityKindSchema.safeParse('ui_template').success).toBe(false);
  });

  it('accepts canonical message batches and normalizes deprecated anchorId', () => {
    const canonical = {
      clientMutationId: 'mutation-message-1',
      anchorIds: ['entity-1', 'entity-2'],
      body: 'hello',
      mentionIds: ['member-1'],
      attachmentIds: ['file-1'],
    };
    expect(PostMessageInputSchema.parse(canonical)).toEqual(canonical);
    expect(PostMessageInputSchema.parse({
      clientMutationId: 'mutation-message-2',
      anchorId: 'entity-1',
      body: 'legacy',
    })).toEqual({
      clientMutationId: 'mutation-message-2',
      anchorIds: ['entity-1'],
      body: 'legacy',
    });
    expect(PostMessageInputSchema.safeParse({ ...canonical, surprise: true }).success).toBe(false);
  });

  it('accepts a server-routed session reply and refuses caller-supplied reply routing', () => {
    expect(PostMessageInputSchema.parse({
      clientMutationId: 'mutation-reply-1',
      replyToMessageId: 'message-context-1',
      body: 'reply through the recorded origin',
    })).toEqual({
      clientMutationId: 'mutation-reply-1',
      replyToMessageId: 'message-context-1',
      anchorIds: [],
      body: 'reply through the recorded origin',
    });
    expect(PostMessageInputSchema.safeParse({
      clientMutationId: 'mutation-reply-2',
      replyToMessageId: 'message-context-1',
      anchorIds: ['caller-guessed-anchor'],
      body: 'ambiguous',
    }).success).toBe(false);
  });

  it('requires a declared conversation origin to belong to the message batch', () => {
    expect(PostMessageInputSchema.safeParse({
      clientMutationId: 'mutation-message-origin-1',
      anchorIds: ['channel-1', 'session-1'],
      conversationAnchorId: 'channel-1',
      body: 'tagged',
    }).success).toBe(true);
    expect(PostMessageInputSchema.safeParse({
      clientMutationId: 'mutation-message-origin-2',
      anchorIds: ['channel-1', 'session-1'],
      conversationAnchorId: 'somewhere-else',
      body: 'tagged',
    }).success).toBe(false);
  });

  it('accepts the scratch/profile spawn delta and rejects drift', () => {
    const input = {
      clientMutationId: 'mutation-spawn-1',
      spaceId: '11111111-1111-4111-8111-111111111111',
      teamMemberId: '22222222-2222-4222-8222-222222222222',
      workdir: { mode: 'scratch' },
      confirmUntrusted: true,
      interactionProfileId: '33333333-3333-4333-8333-333333333333',
    };
    expect(ExecutionSpawnInputSchema.safeParse(input).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...input, permissionMode: 'bypass' }).success).toBe(false);
  });
});
