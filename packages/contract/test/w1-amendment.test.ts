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
    expect(OPERATIONS.slice(-ADDITIVE_OPERATIONS.length)).toEqual(ADDITIVE_OPERATIONS);
  });

  it('reconciles the exact 102-row target without changing reserved honesty', () => {
    expect(OPERATIONS).toHaveLength(102);
    expect(V1_OPERATIONS).toHaveLength(100);
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
    }).toEqual({ GET: 37, POST: 41, PATCH: 9, DELETE: 7, PUT: 7, WS: 1 });
    expect({
      read: count('kind', 'read'),
      command: count('kind', 'command'),
      stream: count('kind', 'stream'),
    }).toEqual({ read: 40, command: 61, stream: 1 });
  });
});

describe('W1 frozen-row schema amendments', () => {
  it('adds only project and interaction_profile to the core-kind registry', () => {
    expect(CoreEntityKindSchema.options).toEqual([
      'channel', 'task', 'message', 'member', 'team_member',
      'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
      'work_session', 'collection', 'project', 'interaction_profile',
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

  it('accepts the scratch/profile spawn delta and rejects drift', () => {
    const input = {
      clientMutationId: 'mutation-spawn-1',
      spaceId: 'space-1',
      teamMemberId: 'teammate-1',
      workdir: { mode: 'scratch' },
      confirmUntrusted: true,
      interactionProfileId: 'profile-1',
    };
    expect(ExecutionSpawnInputSchema.safeParse(input).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...input, permissionMode: 'bypass' }).success).toBe(false);
  });
});
