import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
} from '@tm8/contract';
import {
  ADDITIVE_OPERATION_NAMES,
  FROZEN_SCHEMA_OPERATION_NAMES,
  buildW1ConformanceManifest,
  exactOperationHelp,
  generatedManifestPath,
  renderW1ConformanceManifest,
} from '../../src/foundations/generator.js';
import {
  CORE_KIND_DISPOSITIONS,
  CUSTOM_KIND_DISPOSITION,
  UI_TEMPLATE_SENTINEL,
  assertKindDispositionTotality,
} from '../../src/foundations/kind-dispositions.js';
import {
  ADDITIVE_SCHEMA_DISPOSITIONS,
  FROZEN_SCHEMA_DISPOSITIONS,
  resolveSchema,
  type SchemaRef,
} from '../../src/foundations/schema-dispositions.js';
import {
  readHandlerSourceInventory,
  readInputSchemaSourceInventory,
} from '../../src/foundations/source-inventory.js';
import { readHistoricalW1RegistrySnapshot } from '../../src/foundations/w1-registry-snapshot.js';

describe('W1.C generated catalog and reachability foundations', () => {
  it('derives exact current catalog, router, status, method, and kind accounting', async () => {
    const manifest = await buildW1ConformanceManifest();

    // A21 (execution.liveness, GET read) is the +1 on each affected axis.
    // +4 more from the `credentials.*` family (Tier B, sub-doc 11 §D): one
    // GET/read, one DELETE/command and two POST/command. Every figure below was
    // READ OUT OF THE REGENERATED MANIFEST, not computed as previous-plus-four.
    expect(manifest.catalog).toEqual({
      // 131 -> 135: credentials.* (1 GET/read, 3 commands).
      // 137 -> 138 (2026-08-09): `projects.files.read`, one GET read.
      total: 144,
      v1: 142,
      reserved: 2,
      http: 143,
      ws: 1,
      registerableV1Http: 141,
      methods: { GET: 56, POST: 61, PATCH: 10, DELETE: 9, PUT: 7, WS: 1 },
      kinds: { read: 59, command: 84, stream: 1 },
      uniqueNames: 144,
      uniqueBindings: 144,
    });
    expect(manifest.catalog.total).toBe(OPERATIONS.length);
    expect(manifest.catalog.v1).toBe(V1_OPERATIONS.length);
    expect(manifest.reservedOperations).toEqual(RESERVED_OPERATIONS.map(({ name }) => name));
    expect(manifest.additiveOperations.map(({ name }) => name)).toEqual(ADDITIVE_OPERATION_NAMES);

    expect(manifest.routes.http).toHaveLength(143);
    expect(manifest.routes.ws).toEqual([{
      operation: 'events.subscribe',
      method: 'WS',
      path: '/v2/ws',
      status: 'skeleton',
      durabilityClaim: false,
    }]);
    expect(manifest.routes.http.every((route) => route.source === 'server-router')).toBe(true);
  });

  it('keeps implementation accounting honest at 28 handlers and 36 actual input bindings', async () => {
    const manifest = await buildW1ConformanceManifest();

    // The 28/23/4/1 boundary is the FROZEN W1 snapshot and does not move with
    // A21; `semanticStatus` measures W1-era implementation, so every additive
    // op (A21's live handler included) stays 'unimplemented' HERE — the
    // current mounted boundary is W2.C01's inventory below.
    expect(manifest.serverRegistries.handlers).toMatchObject({
      total: 28,
      facade: 23,
      execution: 4,
      events: 1,
    });
    expect(manifest.serverRegistries.inputSchemas.bound).toHaveLength(36);
    expect(manifest.serverRegistries.inputSchemas.unboundCommands).toHaveLength(13);
    // 141 current registerable v1 HTTP ops minus the 28 W1-implemented.
    expect(manifest.serverRegistries.unimplementedV1Http).toBe(113);
    expect(manifest.additiveOperations.every(({ semanticStatus }) => semanticStatus === 'unimplemented')).toBe(true);
  });

  it('reproduces the frozen W1 registry boundary from an immutable checked-in snapshot', async () => {
    const snapshot = readHistoricalW1RegistrySnapshot();
    const manifest = await buildW1ConformanceManifest();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.handlers.operations)).toBe(true);
    expect(Object.isFrozen(snapshot.inputSchemas.bound[0])).toBe(true);
    expect(snapshot.handlers).toMatchObject({
      total: 28,
      facade: 23,
      execution: 4,
      events: 1,
    });
    expect(snapshot.inputSchemas.bound).toHaveLength(36);
    expect(snapshot.inputSchemas.unboundCommands).toHaveLength(13);
    expect(manifest.serverRegistries).toEqual({
      ...snapshot,
      // 128 current registerable v1 HTTP ops minus the 28 in the
      // frozen snapshot. The snapshot itself never rotates, so the four new
      // `credentials.*` operations raise this even though they ARE implemented
      // — this axis measures distance from the FROZEN W1 boundary, not from
      // what is mounted today. Read out of the failure, which said 100.
      unimplementedV1Http: 113,
    });
  });

  it('represents A16 as POST plus path, with read only in the kind field', async () => {
    const manifest = await buildW1ConformanceManifest();
    const preview = manifest.additiveOperations.find(({ name }) => name === 'interactionProfiles.preview');

    expect(preview).toMatchObject({
      method: 'POST',
      path: '/v2/interaction-profiles/:profileId/preview',
      kind: 'read',
    });
    expect(preview?.path).not.toContain(' read');
  });

  it('provides strict request/result schema reachability for A01-A20 and every frozen amendment', () => {
    expect(Object.keys(ADDITIVE_SCHEMA_DISPOSITIONS)).toEqual(ADDITIVE_OPERATION_NAMES);
    expect(Object.keys(FROZEN_SCHEMA_DISPOSITIONS)).toEqual(FROZEN_SCHEMA_OPERATION_NAMES);

    for (const disposition of [
      ...Object.values(ADDITIVE_SCHEMA_DISPOSITIONS),
      ...Object.values(FROZEN_SCHEMA_DISPOSITIONS),
    ]) {
      if (disposition.requestSchema !== null) {
        expect(resolveSchema(disposition.requestSchema)).toBeDefined();
      }
      expect(resolveSchema(disposition.resultSchema)).toBeDefined();
    }
  });

  it('keeps prompt internal-only, reserved help honest, and WS durability unclaimed', async () => {
    const manifest = await buildW1ConformanceManifest();
    const prompt = manifest.help.operations.find(({ operation }) => operation === 'execution.prompt');

    expect(prompt).toMatchObject({
      exposure: 'internal',
      reason: 'use_message_send',
      publicComposite: 'messages.post',
      invocationSyntax: null,
      actionDiscoverable: false,
    });
    for (const name of ['search.query', 'bridge.fetchBlob']) {
      expect(manifest.help.operations.find(({ operation }) => operation === name)).toMatchObject({
        exposure: 'reserved',
        invocationSyntax: null,
        actionDiscoverable: false,
      });
    }
    expect(manifest.help.rejectedLegacyAliases).toEqual([
      'whoami', 'report', 'progress', 'session prompt',
    ]);
    expect(manifest.help.operations).toHaveLength(144);
    for (const operation of OPERATIONS) {
      expect(exactOperationHelp(manifest, operation.name).operation).toBe(operation.name);
    }
  });

  it('is total over 19 core kinds, c:* fallback, and the ui_template negative sentinel', () => {
    expect(Object.keys(CORE_KIND_DISPOSITIONS)).toHaveLength(19);
    expect(CUSTOM_KIND_DISPOSITION.kind).toBe('c:*');
    expect(UI_TEMPLATE_SENTINEL).toMatchObject({
      kind: 'ui_template',
      entityKind: false,
      route: { strategy: 'none' },
      migration: { strategy: 'none' },
    });
    expect(CORE_KIND_DISPOSITIONS.project.capabilities.profile).toBe('project-restricted');
    expect(CORE_KIND_DISPOSITIONS.project.capabilities).toMatchObject({
      genericPatch: false,
      genericHierarchy: false,
      genericDeleteRestore: false,
      genericPoints: false,
      messages: true,
      reactions: true,
      connections: true,
    });
    expect(CORE_KIND_DISPOSITIONS.interaction_profile.capabilities.profile)
      .toBe('interaction-profile-lifecycle');
    expect(CORE_KIND_DISPOSITIONS.interaction_profile.capabilities.lifecycleOperations).toEqual([
      'interactionProfiles.propose',
      'interactionProfiles.updateDraft',
      'interactionProfiles.validate',
      'interactionProfiles.preview',
      'interactionProfiles.activate',
      'interactionProfiles.retire',
    ]);
    expect(OPERATIONS.some(({ name }) => name.toLowerCase().includes('template'))).toBe(false);
  });

  it('fails closed on unknown operation, kind, and schema dispositions', async () => {
    const manifest = await buildW1ConformanceManifest();
    expect(() => exactOperationHelp(manifest, 'future.unknown')).toThrow(/unknown catalog operation/);
    expect(() => assertKindDispositionTotality([
      ...Object.keys(CORE_KIND_DISPOSITIONS),
      'future_kind',
    ])).toThrow(/core kind disposition drift/);
    expect(() => resolveSchema('FutureSchema' as SchemaRef)).toThrow(/unknown schema ref/);
  });

  it('names the shared A03/A20 settings-revision race without claiming DB execution', async () => {
    const manifest = await buildW1ConformanceManifest();
    expect(manifest.conformanceCases['W1-A03-A20-SHARED-SETTINGS-REVISION']).toMatchObject({
      owner: 'W1.B',
      status: 'foundation',
      executableHere: false,
      operations: ['spaces.defaultChannel.set', 'spaces.interactionProfile.setDefault'],
    });
  });

  it('binds migration dispositions to the frozen W1.B 015 inventory', async () => {
    const manifest = await buildW1ConformanceManifest();

    expect(manifest.migration).toEqual({
      status: 'finalized',
      source: 'db/migrations/015_w1_foundations.sql',
      finalized: true,
      sha256: '9f3258054fb1a0a3cbc80928edcea87760715f2402671534bd32a232773b5ee7',
      objects: {
        tables: [
          'project_links',
          'project_projection_details',
          'space_menu_configs',
          'interaction_profiles',
          'interaction_profile_versions',
          'work_session_interaction_pins',
          'work_session_view_preferences',
          'session_wake_budgets',
          'session_message_deliveries',
          'session_handoffs',
        ],
        entityKindSeeds: ['project', 'interaction_profile'],
        edgeTypeSeeds: [
          'in_project',
          'shared_into',
          'participates_in',
          'authored_from',
          'defaults_to_profile',
          'selected_profile',
        ],
        indexes: 24,
        triggers: 27,
        rlsTables: [
          'project_links',
          'project_projection_details',
          'space_menu_configs',
          'interaction_profiles',
          'interaction_profile_versions',
          'work_session_interaction_pins',
          'work_session_view_preferences',
          'session_wake_budgets',
          'session_message_deliveries',
          'session_handoffs',
        ],
        policies: 11,
        publicAppRpcs: [
          'set_space_default_channel',
          'set_space_profile_default',
          'set_space_menu_config',
          'reset_session_wake_budget_for_member_reply',
          'set_teammate_profile_default',
          'inspect_owned_teammate_inbox',
          'repair_w1_foundations',
          'compensate_w1_foundations',
        ],
        deliveryRpcs: [
          'reserve_session_message_delivery',
          'claim_session_message_delivery',
          'settle_session_message_delivery',
        ],
        replacedRpcs: ['create_space', 'mark_read', 'mark_notification_read'],
      },
    });
  });

  it('commits deterministic generated evidence and detects staleness byte-for-byte', async () => {
    const manifest = await buildW1ConformanceManifest();
    const generated = await readFile(generatedManifestPath, 'utf8');
    expect(generated).toBe(renderW1ConformanceManifest(manifest));
  });
});

/**
 * The CURRENT mounted boundary — deliberately brittle, and deliberately written
 * as literals rather than derived from the live registry. Deriving them would
 * make this pass forever and destroy the only detector that notices a
 * composition tranche moving the public surface without saying so.
 *
 * It has moved twice: at I02, when the frozen G02 group was composed, and at
 * I03, when the frozen G04, G12, G13 and G14 groups were:
 *
 *   | measure          | I01 tranche-v1                                        | I02 tranche-v2    | I03 tranche-v3    |
 *   |------------------|-------------------------------------------------------|-------------------|-------------------|
 *   | facade handlers  | 57                                                    | 68                | 92                |
 *   | all handlers     | 62                                                    | 73                | 97                |
 *   | handler-list sha | `4d45ae29…4379ea`                                     | `47f96949…67ea59` | `73b322ec…276da7` |
 *   | bound schemas    | 47                                                    | 49                | 54                |
 *   | unbound commands | `entities.delete`, `entities.restore`, `messages.delete` | `messages.delete` | (none)         |
 *   | residual v1 HTTP | 36                                                    | 25                | 1                 |
 *
 * I03 is the tranche that made `messages.post` answer for real: tranche-v2
 * mounted an unconditional 501 stub under that name, so the count moved by 24
 * while a twenty-fifth row, `messages.list`, changed call site without changing
 * behaviour. `presence.get` is the only registerable v1 HTTP row left unmounted.
 *
 * The historical W1 snapshot above (28 handlers / 36 bindings / 13 unbound, and
 * the generated manifest hash) is a SEPARATE frozen artifact and does not move
 * with a composition tranche.
 */
describe('W2.C01 current mounted registry inventory', () => {
  it('proves the exact I03 tranche-v3 handler and input-schema boundary from current source', async () => {
    const [handlers, inputSchemas] = await Promise.all([
      readHandlerSourceInventory(),
      readInputSchemaSourceInventory(),
    ]);

    expect(handlers.facade).toHaveLength(130);
    // Tranche-v5 = tranche-v4 plus exactly SEVEN facade handlers, each in a
    // concurrent feature lane (not the W1 amendment set):
    //  - voice.token.create (voice-channels lane);
    //  - the six artifacts.* writers/readers (artifacts lane): create, publish,
    //    revisions.list, preview.start, export, restore.
    // Control, verified this run: stripping exactly those seven names from the
    // live list reproduces the tranche-v4 sha efd55f5b…58229d byte-for-byte.
    expect(handlers.execution).toHaveLength(9);
    expect(handlers.events).toHaveLength(2);
    // 124 -> 125 (2026-08-07): `execution.transcript` joins the execution
    // handler module, so both the execution count and the whole list move.
    // projects.branches.list adds exactly one facade handler.
    // Tier 4 adds two facade handlers.
    // credentials.* add four facade handlers.
    expect(handlers.all).toHaveLength(141);
    expect(handlers.all).toEqual([...new Set(handlers.all)].sort());
    expect(createHash('sha256').update(JSON.stringify(handlers.all)).digest('hex'))
      // `projects.files.read` joins the w2 project-files handler module, so the
      // facade count and this sha move together. The sha is the detector
      // working, not a pin to route around.
      .toBe('63a97e87329ffae15c2e05ecbe8c1df734fd6487af27275b84e757cfcd12f8aa');

    expect(inputSchemas.bound).toHaveLength(77);
    expect(inputSchemas.unboundCommands).toEqual([
      'spaces.menu.update',
      'spaces.defaultChannel.set',
      'interactionProfiles.propose',
      'interactionProfiles.updateDraft',
      'interactionProfiles.validate',
      'interactionProfiles.activate',
      'interactionProfiles.retire',
      'teamMembers.interactionProfile.setDefault',
      'spaces.interactionProfile.setDefault',
    ]);

    const mounted = new Set(handlers.all);
    const registerableV1Http = OPERATIONS.filter(
      ({ method, status }) => method !== 'WS' && status === 'v1',
    );
    expect(registerableV1Http).toHaveLength(141);
    // Every registerable v1 HTTP op has a handler, including the six new
    // artifacts.* rows now that the artifacts server lane has mounted them.
    expect(registerableV1Http.filter(({ name }) => !mounted.has(name))).toHaveLength(0);
    expect(registerableV1Http.filter(({ name }) => !mounted.has(name)).map(({ name }) => name))
      .toEqual([]);
    expect(mounted.has('search.query')).toBe(false);
    expect(mounted.has('bridge.fetchBlob')).toBe(false);
  });
});
