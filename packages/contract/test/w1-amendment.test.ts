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

  it('reconciles the additive 129-row target (110 W1 + voice.token.create + 6 artifacts + execution.resume + spaces.counts + execution.journal + identity.profile.update + 4 auth + execution.launch + projects.directories.list + projects.contention + entities.commands.gate) without changing reserved honesty', () => {
    // 119 -> 120 (2026-08-01): `execution.journal` joined the catalog without
    // this pin moving — the tree carried a red literal until the next
    // amendment (identity.profile.update, also 2026-08-01) reconciled both.
    // 121 -> 125 (2026-08-02): auth.signup/login/logout (POST commands) +
    // auth.session.get (GET read) — Identity v2 Stage 1 local accounts.
    // 125 -> 126 (2026-08-02): execution.launch (GET read) — what a session was
    // TOLD at spawn: its manifest, its env var NAMES and its two prompts.
    // 126 -> 127 (2026-08-02): projects.directories.list (GET read) — the
    // root-confined node-local folder browser for Space project onboarding.
    // 127 -> 129 (2026-08-09): projects.contention + entities.commands.gate (Tier 4 git x graph).
    expect(OPERATIONS).toHaveLength(129);
    expect(V1_OPERATIONS).toHaveLength(127);
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
    }).toEqual({ GET: 48, POST: 55, PATCH: 10, DELETE: 8, PUT: 7, WS: 1 });
    expect({
      read: count('kind', 'read'),
      command: count('kind', 'command'),
      stream: count('kind', 'stream'),
    }).toEqual({ read: 51, command: 77, stream: 1 });
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
