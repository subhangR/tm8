import { describe, expect, it } from 'vitest';

import {
  CollabError,
  EntityKindDefSchema,
  InteractionProfilePinViewSchema,
  InteractionProfilePreviewSchema,
  InteractionProfileViewSchema,
  ProfileValidationViewSchema,
  SpaceProfileDefaultViewSchema,
  TeammateProfileDefaultViewSchema,
  type InteractionProfileDraft,
  type OperationName,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2EntityKindsProfileHandlers } from '../../src/facade/handlers/w2/entity-kinds-profiles.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  STATIC_CHAT_TEMPLATE_REGISTRY,
  recordInteractionProfilePin,
  resolveInteractionProfileForLaunch,
} from '../../src/profiles/w2-profile-resolver.js';
import { projectInteractionProfileForBrowser } from '../../src/profiles/browser-projection.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const MEMBER_ID = '00000000-0000-7000-8000-000000000002';
const TEAM_MEMBER_ID = '00000000-0000-7000-8000-000000000003';
const PROFILE_ID = '00000000-0000-7000-8000-000000000004';
const SESSION_ID = '00000000-0000-7000-8000-000000000005';
const KIND_ID = '00000000-0000-7000-8000-000000000006';
const CREATED_AT = '2026-07-26T00:00:00.000Z';

const DRAFT: InteractionProfileDraft = {
  name: 'Core collaboration',
  templateKey: 'tm8.chat.core',
  templateVersion: 1,
  promptPolicy: {
    kernelTemplate: 'tm8.core.v1',
    manifestMaxBytes: 4096,
    kernelMaxBytes: 6144,
    initialContextMaxBytes: 32768,
    rollingControlMaxBytes: 32768,
    allowedInjectionKinds: [],
    untrustedEncoding: 'escaped-xml',
  },
  toolDiscoveryPolicy: {
    rootHelpRef: 'tm8://help',
    preloadNouns: ['entities', 'messages'],
    semanticSearchEnabled: true,
    semanticMaxMatches: 5,
    nounShardMaxBytes: 8192,
    commandShardMaxBytes: 16384,
    entityContextDefaultBytes: 16384,
    providerToolRegistrationAllowlist: ['entities.get', 'messages.post'],
  },
  feedPolicy: { scope: 'session_chat_v1', pageSize: 50, bodyExcerptBytes: 1024 },
  providerCaptureMode: 'explicit-only',
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: true,
    allowedAttachmentKinds: ['file'],
    operationBindings: ['messages.post', 'messages.attachments.add'],
  },
};

const PROFILE = {
  profileId: PROFILE_ID,
  spaceId: SPACE_ID,
  status: 'draft' as const,
  currentDraftVersion: 1,
  validatedVersion: null,
  validatedHash: null,
  activeVersion: null,
  activeHash: null,
  generatedByTeamMemberId: TEAM_MEMBER_ID,
  retiredAt: null,
  version: 1,
  draft: DRAFT,
};

const KIND = {
  id: KIND_ID,
  kind: 'c:incident',
  origin: 'custom' as const,
  spaceId: SPACE_ID,
  icon: 'siren',
  fieldSchema: [{ name: 'severity', type: 'enum' as const, values: ['low', 'high'] }],
  capabilities: { canEdit: true },
  createdBy: MEMBER_ID,
  createdAt: CREATED_AT,
  // Phase 6: the four columns `entity_kinds` grew when kind absorbed the `type`
  // axis. All null here on purpose — `c:incident` is a BASE-LESS custom kind,
  // which is the shape that must keep working unchanged: it takes the
  // `custom_entities` door, renders by the client's own registry row, and
  // resolves its workflow the way every kind has since 152. A kind that
  // EXTENDS task is the new shape, and it is covered against a real database in
  // `test/db/kind-absorbs-the-type-axis.pg.test.ts` rather than against a
  // double, because what `base_kind` changes is which SQL door runs.
  baseKind: null,
  label: null,
  labelPlural: null,
  workflowId: null,
};

type QueryHandler = (sql: string, params: readonly unknown[]) => Promise<unknown[]>;
type RpcHandler = (fn: string, args: readonly unknown[]) => Promise<unknown>;

class FakeDb implements Db {
  readonly queryCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  constructor(
    private readonly onQuery: QueryHandler = async () => [],
    private readonly onRpc: RpcHandler = async () => ({}),
  ) {}

  private readonly querier: Querier = {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
      this.queryCalls.push({ sql, params });
      return (await this.onQuery(sql, params)) as R[];
    },
    rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
      this.rpcCalls.push({ fn, args });
      return (await this.onRpc(fn, args)) as T;
    },
  };

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier);
  }

  async query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.querier.query<R>(sql, params);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.querier.rpc<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner: async () => ({
      identityId: 'profile-owner',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  };
}

function context(opName: OperationName, body?: unknown): RequestContext {
  return {
    op: { name: opName, method: 'POST', path: '/test', kind: 'command', status: 'v1' },
    opName,
    params: {
      spaceId: SPACE_ID,
      profileId: PROFILE_ID,
      teamMemberId: TEAM_MEMBER_ID,
      kind: 'c:incident',
    },
    query: new URLSearchParams(),
    body,
    requestId: 'req-g12',
    identity: { kind: 'auto-owner', identityId: 'profile-owner' },
    headers: {},
    method: 'POST',
    path: '/test',
  } as RequestContext;
}

function registryFor(db: Db): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2EntityKindsProfileHandlers(registry, deps(db));
  return registry;
}

describe('W2.G12 registration and static-template boundary', () => {
  it('registers exactly the eleven frozen operations', () => {
    expect(registryFor(new FakeDb()).implemented()).toEqual([
      'entityKinds.create',
      'entityKinds.list',
      'entityKinds.update',
      'interactionProfiles.activate',
      'interactionProfiles.preview',
      'interactionProfiles.propose',
      'interactionProfiles.retire',
      'interactionProfiles.updateDraft',
      'interactionProfiles.validate',
      'spaces.interactionProfile.setDefault',
      'teamMembers.interactionProfile.setDefault',
    ]);
  });

  it('ships a closed, immutable, non-entity static template registry', () => {
    expect(STATIC_CHAT_TEMPLATE_REGISTRY).toEqual([expect.objectContaining({
      key: 'tm8.chat.core', version: 1, schemaVersion: 1,
    })]);
    expect(Object.isFrozen(STATIC_CHAT_TEMPLATE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(STATIC_CHAT_TEMPLATE_REGISTRY[0])).toBe(true);
    expect('id' in STATIC_CHAT_TEMPLATE_REGISTRY[0]!).toBe(false);
  });

  it('projects only safe browser policy from the immutable pin snapshot', () => {
    const projection = projectInteractionProfileForBrowser({
      pinRevision: 4,
      templateKey: 'tm8.chat.core',
      templateVersion: 1,
      snapshot: {
        browserProjection: {
          templateKey: 'tm8.chat.core',
          templateVersion: 1,
          feedPolicy: DRAFT.feedPolicy,
          composerPolicy: DRAFT.composerPolicy,
        },
        agentProjection: {
          promptPolicy: DRAFT.promptPolicy,
          toolDiscoveryPolicy: DRAFT.toolDiscoveryPolicy,
          providerSecret: 'must-not-leak',
        },
      },
    });

    expect(projection).toEqual({
      pinRevision: 4,
      templateKey: 'tm8.chat.core',
      templateVersion: 1,
      compatibility: 'supported',
      chatEnabled: true,
      initialContentSurface: 'chat',
      feedPolicy: DRAFT.feedPolicy,
      composerPolicy: DRAFT.composerPolicy,
    });
    expect(projection).not.toHaveProperty('agentProjection');
    expect(JSON.stringify(projection)).not.toContain('must-not-leak');
  });

  it('keeps an unknown pinned template visible through the safe core renderer', () => {
    expect(projectInteractionProfileForBrowser({
      pinRevision: 2,
      templateKey: 'removed.chat.template',
      templateVersion: 9,
      snapshot: {
        browserProjection: {
          templateKey: 'removed.chat.template',
          templateVersion: 9,
          feedPolicy: DRAFT.feedPolicy,
          composerPolicy: DRAFT.composerPolicy,
        },
      },
    })).toMatchObject({
      templateKey: 'removed.chat.template',
      templateVersion: 9,
      compatibility: 'unknown_template',
      chatEnabled: true,
      initialContentSurface: 'terminal',
    });
  });

  it('the shipped core browser policy discovers the canonical upload lifecycle', () => {
    const projection = projectInteractionProfileForBrowser({
      pinRevision: 1,
      templateKey: 'tm8.chat.core',
      templateVersion: 1,
      snapshot: {},
    });
    expect(projection.composerPolicy.operationBindings).toEqual(expect.arrayContaining([
      'messages.post',
      'files.uploadInit',
      'files.uploadComplete',
      'files.uploadAbort',
    ]));
    expect(STATIC_CHAT_TEMPLATE_REGISTRY[0]?.allowedOperationBindings).toEqual(expect.arrayContaining([
      'files.uploadInit',
      'files.uploadComplete',
      'files.uploadAbort',
    ]));
  });
});

describe('W2.G12 entity-kind/profile handlers', () => {
  it('lists core-visible and Space custom kind rows through RLS', async () => {
    const db = new FakeDb(async (sql, params) => {
      expect(sql).toContain('from public.entity_kinds');
      expect(params).toEqual([SPACE_ID]);
      return [{
        id: KIND_ID,
        kind: 'c:incident',
        origin: 'custom',
        space_id: SPACE_ID,
        icon: 'siren',
        field_schema: KIND.fieldSchema,
        capabilities: KIND.capabilities,
        created_by: MEMBER_ID,
        created_at: CREATED_AT,
      }];
    });
    const result = await registryFor(db).get('entityKinds.list')!(context('entityKinds.list'));
    expect((result as unknown[]).map((row) => EntityKindDefSchema.parse(row))).toEqual([KIND]);
  });

  it('uses the two custom-kind lifecycle RPCs and preserves strict DTOs', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      if (fn === 'w2_create_entity_kind') {
        // The three trailing nulls are phase 6's create-only arguments:
        // baseKind, label, labelPlural. `baseKind` is create-only because
        // re-basing a kind is a data migration wearing an update's clothes.
        expect(args).toEqual([SPACE_ID, 'c:incident', 'siren', KIND.fieldSchema,
          KIND.capabilities, null, 'cmid-kind-create', null, null, null]);
      } else {
        expect(fn).toBe('w2_update_entity_kind');
        expect(args).toEqual([SPACE_ID, 'c:incident', {
          icon: null,
          fieldSchema: [{ name: 'severity', type: 'enum', values: ['low', 'medium', 'high'] }],
          capabilities: { canEdit: false },
          allowTightening: false,
        }, null, 'cmid-kind-update']);
      }
      return KIND;
    });
    const registry = registryFor(db);
    const created = await registry.get('entityKinds.create')!(context('entityKinds.create', {
      clientMutationId: 'cmid-kind-create', kind: 'c:incident', icon: 'siren',
      fieldSchema: KIND.fieldSchema, capabilities: KIND.capabilities,
    }));
    const updated = await registry.get('entityKinds.update')!(context('entityKinds.update', {
      clientMutationId: 'cmid-kind-update', icon: null,
      fieldSchema: [{ name: 'severity', type: 'enum', values: ['low', 'medium', 'high'] }],
      capabilities: { canEdit: false }, allowTightening: false,
    }));
    expect(EntityKindDefSchema.parse(created)).toEqual(KIND);
    expect(EntityKindDefSchema.parse(updated)).toEqual(KIND);
  });

  it('routes propose, update, validate, activate and retire through their named RPCs', async () => {
    const validation = {
      profileId: PROFILE_ID,
      profileVersion: 2,
      status: 'valid' as const,
      validatedHash: 'sha256:validated',
      issues: [],
    };
    const db = new FakeDb(async () => [], async (fn) => fn === 'validate_interaction_profile'
      ? validation
      : PROFILE);
    const registry = registryFor(db);

    expect(InteractionProfileViewSchema.parse(await registry.get('interactionProfiles.propose')!(
      context('interactionProfiles.propose', { clientMutationId: 'cmid-propose', spaceId: SPACE_ID, draft: DRAFT }),
    ))).toEqual(PROFILE);
    expect(InteractionProfileViewSchema.parse(await registry.get('interactionProfiles.updateDraft')!(
      context('interactionProfiles.updateDraft', { clientMutationId: 'cmid-update', expectedVersion: 1, draft: DRAFT }),
    ))).toEqual(PROFILE);
    expect(ProfileValidationViewSchema.parse(await registry.get('interactionProfiles.validate')!(
      context('interactionProfiles.validate', { clientMutationId: 'cmid-validate', expectedVersion: 2 }),
    ))).toEqual(validation);
    expect(InteractionProfileViewSchema.parse(await registry.get('interactionProfiles.activate')!(
      context('interactionProfiles.activate', {
        clientMutationId: 'cmid-activate', validatedVersion: 2,
        validatedHash: 'sha256:validated', confirm: true,
      }),
    ))).toEqual(PROFILE);
    expect(InteractionProfileViewSchema.parse(await registry.get('interactionProfiles.retire')!(
      context('interactionProfiles.retire', { clientMutationId: 'cmid-retire', expectedVersion: 1, confirm: true }),
    ))).toEqual(PROFILE);
    expect(db.rpcCalls.map(({ fn }) => fn)).toEqual([
      'propose_interaction_profile',
      'update_interaction_profile_draft',
      'validate_interaction_profile',
      'activate_interaction_profile',
      'retire_interaction_profile',
    ]);
  });

  it('takes Teammate authorship from the authenticated bearer context, not the strict DTO', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('propose_interaction_profile');
      expect(args).toEqual([SPACE_ID, DRAFT, TEAM_MEMBER_ID, 'cmid-bearer-propose']);
      return PROFILE;
    });
    const ctx = context('interactionProfiles.propose', {
      clientMutationId: 'cmid-bearer-propose', spaceId: SPACE_ID, draft: DRAFT,
    });
    (ctx as { identity: RequestContext['identity'] }).identity = {
      kind: 'bearer', identityId: 'profile-owner', actorId: TEAM_MEMBER_ID,
    };
    const value = await registryFor(db).get('interactionProfiles.propose')!(ctx);
    expect(InteractionProfileViewSchema.parse(value)).toEqual(PROFILE);
  });

  it('previews a sanitized noninteractive projection without a mutation id', async () => {
    const preview = {
      profileId: PROFILE_ID,
      profileVersion: 1,
      name: DRAFT.name,
      templateKey: DRAFT.templateKey,
      templateVersion: DRAFT.templateVersion,
      feedPolicy: DRAFT.feedPolicy,
      composerPolicy: DRAFT.composerPolicy,
      validatedHash: null,
      generatedByTeamMemberId: TEAM_MEMBER_ID,
    };
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('preview_interaction_profile');
      expect(args).toEqual([PROFILE_ID, 1]);
      return preview;
    });
    const value = await registryFor(db).get('interactionProfiles.preview')!(
      context('interactionProfiles.preview', { profileVersion: 1 }),
    );
    expect(InteractionProfilePreviewSchema.parse(value)).toEqual(preview);
    expect(value).not.toHaveProperty('promptPolicy');
    expect(value).not.toHaveProperty('toolDiscoveryPolicy');
    expect(value).not.toHaveProperty('providerCaptureMode');
  });

  it('uses the guarded Teammate and Space default RPCs with frozen result names', async () => {
    const teammateResult = {
      teamMemberId: TEAM_MEMBER_ID,
      defaultInteractionProfileId: PROFILE_ID,
      version: 2,
    };
    const spaceResult = {
      spaceId: SPACE_ID,
      defaultInteractionProfileId: PROFILE_ID,
      settingsRevision: 2,
    };
    const db = new FakeDb(async () => [], async (fn) => fn === 'set_teammate_profile_default'
      ? teammateResult
      : spaceResult);
    const registry = registryFor(db);
    const teammate = await registry.get('teamMembers.interactionProfile.setDefault')!(context(
      'teamMembers.interactionProfile.setDefault',
      { clientMutationId: 'cmid-tm-default', expectedVersion: 1, profileId: PROFILE_ID },
    ));
    const space = await registry.get('spaces.interactionProfile.setDefault')!(context(
      'spaces.interactionProfile.setDefault',
      {
        clientMutationId: 'cmid-space-default', expectedSettingsRevision: 1,
        profileId: PROFILE_ID, confirmAgentGenerated: true,
      },
    ));
    expect(TeammateProfileDefaultViewSchema.parse(teammate)).toEqual(teammateResult);
    expect(SpaceProfileDefaultViewSchema.parse(space)).toEqual(spaceResult);
  });

  it('maps the frozen retirement-default reason to conflict without inventing an error', async () => {
    const db = new FakeDb(async () => [], async () => {
      throw new CollabError('invariant_violation', 'profile still has a default', {
        details: { sqlstate: '23514', detail: 'profile_referenced_default' },
      });
    });
    const handler = registryFor(db).get('interactionProfiles.retire')!;
    await expect(handler(context('interactionProfiles.retire', {
      clientMutationId: 'cmid-retire-blocked', expectedVersion: 3, confirm: true,
    }))).rejects.toMatchObject({
      code: 'conflict',
      details: { sqlstate: '23514', reason: 'profile_referenced_default' },
    });
  });
});

// A rejection captured with its contract type, so the assertions below are
// type-checked rather than reaching through `unknown`.
async function rejection(run: unknown): Promise<CollabError> {
  try {
    await run;
  } catch (thrown) {
    return thrown as CollabError;
  }
  throw new Error('expected the command to be refused');
}

// The dossier's ErrorDetails is `{ reason: string; ... }`. The frozen profile
// RPCs (027) and the frozen human-principal helper (015) raise their reasons as
// bare PostgreSQL DETAIL strings, which db/errors.ts can only surface as
// `details.detail`. Lifting them onto `details.reason` is the seam's job, and
// the frozen projects group already does exactly this.
describe('W2.G12 frozen reasons reach the contract details.reason', () => {
  function throwing(code: string, sqlstate: string, detail: string) {
    return new FakeDb(async () => [], async () => {
      throw new CollabError(code as 'invariant_violation', 'database refused the command', {
        details: { sqlstate, detail },
      });
    });
  }

  const CASES = [
    ['interactionProfiles.propose', 'invalid_input', '22023', 'profile_capture_mode_reserved',
      'invalid_input', { clientMutationId: 'c', spaceId: SPACE_ID, draft: DRAFT }],
    ['interactionProfiles.updateDraft', 'invariant_violation', '23514', 'profile_retired',
      'invariant_violation', { clientMutationId: 'c', expectedVersion: 1, draft: DRAFT }],
    ['interactionProfiles.validate', 'invariant_violation', '23514', 'profile_retired',
      'invariant_violation', { clientMutationId: 'c', expectedVersion: 1 }],
    ['interactionProfiles.activate', 'forbidden', '42501', 'profile_principal_required',
      'forbidden', {
        clientMutationId: 'c', validatedVersion: 1, validatedHash: 'sha256:x', confirm: true,
      }],
    ['interactionProfiles.activate', 'invariant_violation', '23514', 'profile_not_validated',
      'invariant_violation', {
        clientMutationId: 'c', validatedVersion: 1, validatedHash: 'sha256:x', confirm: true,
      }],
    ['interactionProfiles.retire', 'invariant_violation', '23514', 'profile_referenced_default',
      'conflict', { clientMutationId: 'c', expectedVersion: 1, confirm: true }],
    ['teamMembers.interactionProfile.setDefault', 'forbidden', '42501',
      'profile_principal_required', 'forbidden',
      { clientMutationId: 'c', expectedVersion: 1, profileId: PROFILE_ID }],
    ['spaces.interactionProfile.setDefault', 'forbidden', '42501', 'profile_principal_required',
      'forbidden', { clientMutationId: 'c', expectedSettingsRevision: 1, profileId: PROFILE_ID }],
  ] as const;

  it.each(CASES)('%s surfaces %s as details.reason %s', async (
    opName, rawCode, sqlstate, reason, expectedCode, body,
  ) => {
    const handler = registryFor(throwing(rawCode, sqlstate, reason)).get(opName)!;
    const error = await rejection(handler(context(opName, body)));
    expect(error.code).toBe(expectedCode);
    expect(error.details).toEqual({ sqlstate, reason });
    expect(error.details).not.toHaveProperty('detail');
  });

  // Dossier §8.2, set_space_profile_default: "A mismatch returns `conflict`
  // with `details.currentRevision` and writes nothing." SQLSTATE 40001 maps to
  // the entity taxonomy's `version_conflict`, so A20 must move it across.
  it('returns conflict, not version_conflict, for an A20 settings-revision mismatch', async () => {
    const db = new FakeDb(async () => [], async () => {
      throw new CollabError('version_conflict', 'Space settings revision conflict', {
        details: { sqlstate: '40001', currentRevision: 7 },
      });
    });
    const handler = registryFor(db).get('spaces.interactionProfile.setDefault')!;
    const error = await rejection(handler(context('spaces.interactionProfile.setDefault', {
      clientMutationId: 'cmid-stale', expectedSettingsRevision: 1, profileId: PROFILE_ID,
    })));
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({ sqlstate: '40001', currentRevision: 7 });
  });

  // A19 is not covered by that dossier sentence; its optimistic version check
  // stays in the entity version taxonomy and must not be swept along.
  it('leaves the A19 Teammate version conflict in the entity version taxonomy', async () => {
    const db = new FakeDb(async () => [], async () => {
      throw new CollabError('version_conflict', 'entity version conflict', {
        details: { sqlstate: '40001', currentVersion: 4 },
      });
    });
    const handler = registryFor(db).get('teamMembers.interactionProfile.setDefault')!;
    const error = await rejection(handler(context('teamMembers.interactionProfile.setDefault', {
      clientMutationId: 'cmid-stale-tm', expectedVersion: 1, profileId: PROFILE_ID,
    })));
    expect(error.code).toBe('version_conflict');
    expect(error.details).toEqual({ sqlstate: '40001', currentVersion: 4 });
  });

  it('leaves a detail that is not a frozen G12 reason exactly as the database sent it', async () => {
    const handler = registryFor(
      throwing('invariant_violation', '23505', 'entity_kinds_core_unique_idx'),
    ).get('interactionProfiles.retire')!;
    const error = await rejection(handler(context('interactionProfiles.retire', {
      clientMutationId: 'c', expectedVersion: 1, confirm: true,
    })));
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ sqlstate: '23505', detail: 'entity_kinds_core_unique_idx' });
  });
});

describe('W2.G12 immutable launch pin seams', () => {
  it('resolves the database-serialized source order and refuses registry drift', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('internal.w2_resolve_interaction_profile_for_launch');
      expect(args).toEqual([SPACE_ID, TEAM_MEMBER_ID, PROFILE_ID]);
      return {
        profileId: PROFILE_ID,
        profileVersion: 2,
        templateKey: 'tm8.chat.core',
        templateVersion: 1,
        resolvedHash: 'sha256:pin',
        source: 'spawn_override',
        snapshot: { draft: DRAFT, projectorVersion: 1 },
      };
    });
    const result = await resolveInteractionProfileForLaunch(db, { identityId: 'profile-owner' }, {
      spaceId: SPACE_ID,
      teamMemberId: TEAM_MEMBER_ID,
      interactionProfileId: PROFILE_ID,
    });
    expect(result.source).toBe('spawn_override');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('records the immutable pin and recorder-owned selected_profile provenance', async () => {
    const pin = {
      workSessionId: SESSION_ID,
      pinRevision: 2,
      profileId: PROFILE_ID,
      profileVersion: 2,
      templateKey: 'tm8.chat.core',
      templateVersion: 1,
      resolvedHash: 'sha256:pin',
      source: 'teammate_default' as const,
      createdAt: CREATED_AT,
    };
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('internal.w2_record_interaction_profile_pin');
      expect(args).toEqual([
        SESSION_ID, PROFILE_ID, 2, 'teammate_default', 'sha256:pin',
      ]);
      return pin;
    });
    const value = await recordInteractionProfilePin(db, { identityId: 'profile-owner' }, {
      workSessionId: SESSION_ID,
      profileId: PROFILE_ID,
      profileVersion: 2,
      source: 'teammate_default',
      resolvedHash: 'sha256:pin',
    });
    expect(InteractionProfilePinViewSchema.parse(value)).toEqual(pin);
  });
});
