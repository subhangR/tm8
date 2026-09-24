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
      // 137 -> 138 (2026-08-09, merge): execution.dispatch joins from
      // feat/dispatcher-loops.
      // 142 -> 144 (2026-08-12): collections.addItem (POST/command) +
      // collections.removeItem (DELETE/command) — membership writes.
      // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows —
      // gitStatus/gitDiff (GET/read), gitCheckpoint/gitRollback/gitCommit/
      // gitMerge (POST/command).
      // 150 -> 163 (unledgered upstream bumps; measured on origin/main
      // 9b938647). 163 -> 166 (2026-08-16, W4/132): spaces.taskWorkflows
      // list (GET/read) + upsert (POST/command) + delete (DELETE/command).
      // Every figure READ OUT OF THE REGENERATED MANIFEST.
      // 166 -> 169 (141): auth.password.change + auth.invite.signup +
      // auth.claim.reissue, all POST/command. READ OUT OF THE REGENERATED MANIFEST.
      // 169 -> 172 (148, phase 2): spaces.workflows.list (GET read) +
      // .upsert (POST command) + .delete (DELETE command). READ OUT OF THE
      // REGENERATED MANIFEST, never delta-arithmetic.
      // 172 -> 197 (177): the 25 containers.* rows. READ OUT OF THE
      // REGENERATED MANIFEST, never delta-arithmetic.
      // 197 -> 198 (187): execution.sessions.share, one POST/command. It
      // MOUNTS, so `http`, `uniqueBindings` and `registerableV1Http` all move
      // with `total` this time — unlike the containers wave, where the WS
      // alias made them diverge. READ OUT OF THE REGENERATED MANIFEST.
      //
      // `http`/`ws` are MOUNT counts and `uniqueBindings` is over the mounted
      // set, which is why they land on 195/1/196 rather than 196/2/197:
      // `containers.stream` re-declares `events.subscribe`'s socket so the
      // family is discoverable under its own name, and mounts nothing.
      // 197 -> 198 (2026-09-19, Changes surface phase 1): execution.gitStage,
      // one POST/command v1 HTTP row. READ OUT OF THE REGENERATED MANIFEST.
      // 198 -> 199 and the whole block with it (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
      // branch's execution.gitStage BOTH land, so this moves twice. Git merged
      // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
      // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
      // 2026-09-23 F4 (#648): skills.roots/create/edit/equip/unequip, all mounted v1 HTTP. MEASURED on the merged tree.
      // 2026-09-23 Jev lane F: launch.suggest, one mounted v1 POST command. MEASURED from the regenerated manifest.
      // Jev lane K: credentials.serviceKeys.{status,put,delete}, three mounted v1 rows. MEASURED.
      // SC-3: credentials.space.* (8) and node.credentials.* (2), ten mounted v1 rows. MEASURED.
      total: 238, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). // +1 entities.commands.tick (bug 01a0d2f1). +1 events.changes (change feed step 3).
      v1: 236, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs. // +1 entities.commands.tick. +1 events.changes (change feed step 3).
      reserved: 2,
      http: 236, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs. // +1 entities.commands.tick. +1 events.changes (change feed step 3).
      ws: 1,
      registerableV1Http: 234, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs. // +1 entities.commands.tick. +1 events.changes (change feed step 3).
      methods: { GET: 78, /* +13 forms.* (Forms W1). MEASURED. */ POST: 113, PATCH: 16, DELETE: 16, PUT: 13, WS: 2 }, // +1 events.changes (change feed step 3).
      kinds: { read: 82, /* +13 forms.* (Forms W1). MEASURED. */ command: 154, stream: 2 }, // +1 events.changes (change feed step 3).
      uniqueNames: 238, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs. // +1 entities.commands.tick. +1 events.changes (change feed step 3).
      uniqueBindings: 237, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs. // +1 entities.commands.tick. +1 events.changes (change feed step 3).
    });
    expect(manifest.catalog.total).toBe(OPERATIONS.length);
    expect(manifest.catalog.v1).toBe(V1_OPERATIONS.length);
    expect(manifest.reservedOperations).toEqual(RESERVED_OPERATIONS.map(({ name }) => name));
    expect(manifest.additiveOperations.map(({ name }) => name)).toEqual(ADDITIVE_OPERATION_NAMES);

    // +24 (177): the container HTTP rows. 195 -> 196 (187): execution.sessions.share.
    // 196 -> 197 (2026-09-19): execution.gitStage. MEASURED on the merged tree.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
    // 206 -> 207 (Jev lane F): launch.suggest. MEASURED.
    expect(manifest.routes.http).toHaveLength(236); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 (SC-3). +3 (Jev lane K). MEASURED.
    // BOTH WS rows are LISTED here even though only one is MOUNTED. `routes`
    // is what a discovering client reads to learn an operation's transport,
    // and `containers.stream` has one — the same socket, dispatched on the
    // grant. Omitting it would leave a v1 row discovery can name but cannot
    // tell you how to reach. The mount count is `catalog.ws` above.
    expect(manifest.routes.ws).toEqual([{
      operation: 'events.subscribe',
      method: 'WS',
      path: '/v2/ws',
      status: 'skeleton',
      durabilityClaim: false,
    }, {
      operation: 'containers.stream',
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
    // Current registerable v1 HTTP ops minus the 28 W1-implemented. This axis
    // measures distance from the FROZEN W1 boundary, so it rises with every
    // amendment even when the new ops ARE mounted. 130 -> 132 upstream
    // (unledgered), 132 -> 135 (W4/132): the three taskWorkflows rows.
    // 138 -> 141 (148). This axis measures distance from the FROZEN W1
    // boundary, so it rises with every amendment EVEN THOUGH these three ops
    // are mounted — W2.C01's live inventory below is where that shows up.
    // 141 -> 165 (177): registerableV1Http 193 minus the frozen 28.
    // 165 -> 166 (187): registerableV1Http 194 minus the frozen 28. The
    // operation IS mounted; this axis measures distance from the FROZEN W1
    // boundary, which never rotates, so it rises anyway.
    // 165 -> 166 (2026-09-19, Changes surface phase 1): registerableV1Http 194
    // minus the frozen 28, because execution.gitStage joined the catalog.
    // 166 -> 167 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
    // branch's execution.gitStage BOTH land, so this moves twice. Git merged
    // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
    // 176 -> 177 (Jev lane F): registerableV1Http 205 minus the frozen 28. MEASURED.
    expect(manifest.serverRegistries.unimplementedV1Http).toBe(206); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // 180 -> 190 (SC-3). 177 -> 180 (Jev lane K).
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
      // 141 current registerable v1 HTTP ops minus the 28 in the
      // frozen snapshot. The snapshot itself never rotates, so new operations
      // raise this even when they ARE implemented — this axis measures
      // distance from the FROZEN W1 boundary, not from what is mounted today.
      // 111 -> 113 (2026-08-12): collections.addItem/removeItem.
      // 113 -> 119 (2026-08-12, Git UI landing): the six execution.git* rows.
      // 130 -> 132 upstream (unledgered); 132 -> 135 (W4/132).
      // +24 (177). 165 -> 166 (187), 166 -> 167 (2026-09-19, execution.gitStage):
      // registerableV1Http 195 minus the frozen 28. MEASURED on the merged tree.
      // 167 -> 171 (2026-09-23): the four skills.* rows; registerableV1Http 199 minus 28.
      // 171 -> 176 (2026-09-23 F4): registerableV1Http 204 minus 28.
      // 176 -> 177 (Jev lane F, launch.suggest): registerableV1Http 205 minus 28.
      unimplementedV1Http: 206, /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). // +1 entities.commands.tick (bug 01a0d2f1). 180 -> 190 (SC-3): registerableV1Http 218 minus 28. 177 -> 180 (Jev lane K). // +1 events.changes (change feed step 3).
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
    // +25 (177) containers; 197 -> 198 (187): execution.sessions.share.
    // 198 -> 199 (2026-09-19): execution.gitStage. MEASURED on the merged tree.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
    expect(manifest.help.operations).toHaveLength(238); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 (SC-3). // +3 service keys (Jev lane K). // +1 launch.suggest (Jev lane F). MEASURED.
    for (const operation of OPERATIONS) {
      expect(exactOperationHelp(manifest, operation.name).operation).toBe(operation.name);
    }
  });

  it('is total over 24 core kinds, c:* fallback, and the ui_template negative sentinel', () => {
    // 19 -> 20 (2026-08-09): `loop`; 20 -> 21 (2026-08-16): `graph` (Craft P1);
    // 21 -> 23 (2026-09-03): `chat` (migration 176, Chat as an Entity) and
    // `container` (TM8-CONTAINERS-DESIGN, migration 177). Both landed the
    // same day; the number is MEASURED on the merged tree, not summed from
    // two branches that each saw only its own kind.
    // 23 -> 24 (2026-09-17): `drawing` (migration 194, the Excalidraw canvas
    // kind). MEASURED on this tree — main at 28c07b6e plus this lane — by
    // counting the `core(` rows in kind-dispositions.ts, not by adding one to
    // the number that was here. No other unmerged branch adds a kind: the one
    // holding migrations 187..193 (feat/architecture_security) seeds no
    // entity_kinds row.
    // 24 -> 25 (2026-09-24): `form` (migration 209, Forms W0). MEASURED on
    // this tree by counting the `core(` rows in kind-dispositions.ts.
    expect(Object.keys(CORE_KIND_DISPOSITIONS)).toHaveLength(25);
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

    // ── containers (TM8-CONTAINERS-DESIGN §3.1, §15) ──────────────────────
    //
    // The disposition mirrors `work-session-execution`, NOT `worktree-lifecycle`,
    // and the difference between those two precedents is the whole decision. A
    // worktree keeps a generic patch door because its one semantic write IS an
    // ordinary forward-only status transition. A container has no such write:
    // `status` has a single writer (`public.set_container_status`, guarded by a
    // trigger that enforces the edges), and every other mutable field — title,
    // lifecycle, share mode, labels — is claimed by the named `containers.update`
    // door. Lane B confirmed `container` is in the server's
    // RESTRICTED_LIFECYCLE_KINDS, so this describes something real rather than
    // being a preference with a test around it.
    expect(CORE_KIND_DISPOSITIONS.container.capabilities.profile).toBe('container-lifecycle');
    expect(CORE_KIND_DISPOSITIONS.container.capabilities).toMatchObject({
      genericCreate: false,
      genericPatch: false,
      genericMove: false,
      genericHierarchy: false,
      genericDeleteRestore: false,
      genericPoints: false,
      // The four universal capabilities still pay rent: a machine is discussed,
      // reacted to, and connected to the sessions that run in it.
      messages: true,
      reactions: true,
      connections: true,
    });
    // Not menu-addressable and born only from the provisioning saga, exactly as
    // worktree and work_session are.
    expect(CORE_KIND_DISPOSITIONS.container.menu.strategy).toBe('not-addressable');
    expect(CORE_KIND_DISPOSITIONS.container.migration.strategy).toBe('container-detail');
    // Every lifecycle operation it names is a REAL catalog row. A disposition
    // that named an operation the catalog does not carry would be a promise
    // nothing could keep.
    for (const operation of CORE_KIND_DISPOSITIONS.container.capabilities.lifecycleOperations) {
      expect(OPERATIONS.some(({ name }) => name === operation), operation).toBe(true);
    }
    // The birth verb is `containers.create`, so the kind must be OUTSIDE the
    // generically-creatable set. This is the assertion that would fail if
    // someone "tidied" the exclusion away.
    expect(CORE_KIND_DISPOSITIONS.container.capabilities.lifecycleOperations)
      .toContain('containers.create');
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

    // 145 -> 147 upstream (unledgered); 147 -> 150 (2026-08-16, W4/132): the
    // three spaces.taskWorkflows handlers join the w2 identity-spaces module.
    // 153 -> 156 (148): the three spaces.workflows handlers join the SAME w2
    // identity-spaces module the taskWorkflows three live in.
    // 156 -> 180 (177): the 24 container HTTP handlers join the same w2 seam,
    // registered whatever the feature gate says — an unregistered v1 row
    // answers 404, and 404 claims the operation does not exist.
    // 180 -> 181 (2026-09-19, Changes surface phase 1): execution.gitStage is
    // served by the same facade execution-git service as the other git rows.
    // 181 -> 185 (2026-09-23): the four skills.* handlers. MEASURED on the merged tree.
    // 185 -> 190 (2026-09-23 F4): five skills.* handlers. MEASURED.
    // 190 -> 191 (Jev lane F): the launch.suggest placeholder (jev/handlers.ts). MEASURED.
    expect(handlers.facade).toHaveLength(219); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ // +10 space/node credentials (SC-3). +3 service keys (Jev lane K). MEASURED.
    // Tranche-v5 = tranche-v4 plus exactly SEVEN facade handlers, each in a
    // concurrent feature lane (not the W1 amendment set):
    //  - voice.token.create (voice-channels lane);
    //  - the six artifacts.* writers/readers (artifacts lane): create, publish,
    //    revisions.list, preview.start, export, restore.
    // Control, verified this run: stripping exactly those seven names from the
    // live list reproduces the tranche-v4 sha efd55f5b…58229d byte-for-byte.
    // execution.dispatch adds one execution-module handler (merge 2026-08-09).
    // execution.terminal.start adds one more (merge 2026-08-13, #161).
    // 11 -> 12 (187): execution.sessions.share registers in the execution
    // handler module, beside terminate and resume.
    expect(handlers.execution).toHaveLength(12);
    expect(handlers.events).toHaveLength(3); /* +1 events.changes (change feed step 3). MEASURED. */
    // 124 -> 125 (2026-08-07): `execution.transcript` joins the execution
    // handler module, so both the execution count and the whole list move.
    // projects.branches.list adds exactly one facade handler.
    // Tier 4 adds two facade handlers.
    // credentials.* add four facade handlers.
    // 139 -> 141 (2026-08-12): collections.addItem/removeItem join the G05
    // seam as two facade handlers.
    // 141 -> 147 (2026-08-12, Git UI landing): the six execution.git* facade
    // handlers (facade/services/execution-git.ts).
    // 158 -> 160 upstream (unledgered); 160 -> 163 (W4/132).
    // +24 (177): the container handlers. 193 -> 194 (187): execution.sessions.share.
    // 194 -> 195 (2026-09-19, Changes surface phase 1): the execution.gitStage
    // facade handler. MEASURED on the merged tree.
    // 195 -> 199 (2026-09-23): the four skills.* facade handlers. MEASURED on the merged tree.
    // 199 -> 204 (2026-09-23 F4). MEASURED.
    // 204 -> 205 (Jev lane F): launch.suggest. MEASURED.
    expect(handlers.all).toHaveLength(234); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 (SC-3). +3 (Jev lane K). MEASURED.
    expect(handlers.all).toEqual([...new Set(handlers.all)].sort());
    expect(createHash('sha256').update(JSON.stringify(handlers.all)).digest('hex'))
      // Re-measured at 114 (spaces.members.updateRole, auth.invite.resolve).
      // Re-measured 2026-08-16 (W4/132): the three spaces.taskWorkflows
      // handlers join, on top of two unledgered upstream arrivals — computed
      // by CALLING readHandlerSourceInventory on this tree, never by hand.
      // Re-measured 141: the three account-lifecycle facade handlers join —
      // computed by CALLING readHandlerSourceInventory on this tree, never by hand.
      // Re-measured 148: the three spaces.workflows handlers join. Read out of
      // the FAILING RUN's Received line, which is the same thing as calling the
      // inventory and the only version of it that cannot be typed from memory.
      // Re-measured on the MERGED tree: 176's chat handler rename AND the 24
      // container handlers. It hashes the sorted NAME list, so neither
      // branch's value survives — each hashed a list missing the other's
      // handlers. Read out of the FAILING RUN's Received line.
      // Re-measured on the MERGED tree: BOTH execution.sessions.share (187) and
      // execution.gitStage join the sorted handler name list, so this digest is a
      // THIRD value — neither branch's is correct here. Read out of the FAILING
      // RUN's Received line, not computed by hand.
      // The HANDLERS digest — sha256 over the sorted handler-name list, a
      // SEPARATE digest from the catalog digest. Read out of this assertion's
      // own failing-run Received line on the merged tree, never computed.
      // Re-measured 2026-09-23: the four skills.* handlers join — computed by
      // CALLING readHandlerSourceInventory on the merged tree, never by hand.
      // Re-measured 2026-09-23 with F4 by CALLING readHandlerSourceInventory.
      // Re-measured (Jev lane F): launch.suggest joins; read out of this assertion's own failing-run Received line.
      // Re-measured (Jev lane K): the three service-key handlers join; read from the failing run's Received line.
      // Re-measured (SC-3): the ten space/node credential handlers join; read from the failing run's Received line.
      // Re-measured (change feed step 3): events.changes joins the events module. Read from the failing run.
      // Re-measured (bug 01a0d2f1): entities.commands.tick joins. Read from the failing run.
      // Re-measured (task 01a0d350): spaces.configs joins. Read from the failing run.
      .toBe('a94ca1da4c76b7f31203f4c2008b9805683cfa2f324b9e3e6b198854974f8d98'); // Re-measured (Forms W1): the thirteen forms.* handlers join; read from the failing run's Received line.

    // 74 -> 75 (2026-08-09, merge): execution.dispatch binds its command body.
    // 78 -> 80 (2026-08-12): collections.addItem/removeItem bind their bodies.
    // 80 -> 84 (2026-08-12, Git UI landing): the four execution.git* command
    // bodies bind.
    // +1 (2026-08-13, merge): execution.terminal.start binds its body.
    // +1 (2026-08-13, merge union): chat.threads.start binds its body —
    //     RENAMED to chat.start by 176; the count is unchanged because the
    //     operation was replaced, not added to.
    // +2 (114): UpdateMemberRoleInput binds spaces.members.updateRole, and
    // ResolveInviteInput binds auth.invite.resolve — the latter claim-free, so
    // strictness is the only control on that body.
    // +2 (2026-08-16, W4/132): TaskWorkflowInputSchema binds
    // spaces.taskWorkflows.upsert; RequiredCommandContextSchema binds .delete.
    // +2 (148): WorkflowInputSchema binds spaces.workflows.upsert;
    // RequiredCommandContextSchema binds .delete. `.list` is a READ and binds
    // nothing, which is why three ops move this by two.
    // +19 (177): the container command bodies that bind. 118 -> 119 (187):
    // ExecutionSessionsShareInput. 119 -> 120 (2026-09-19): GitStageInput binds
    // execution.gitStage's command body. MEASURED on the merged tree.
    // 120 -> 121 (2026-09-23): skills.scan binds SkillScanInputSchema. MEASURED on the merged tree.
    // 121 -> 125 (2026-09-23 F4): create/edit/equip/unequip bind local schemas. MEASURED.
    // 125 -> 126 (Jev lane F): launch.suggest binds LaunchSuggestInputSchema. MEASURED.
    expect(inputSchemas.bound).toHaveLength(146) /* +10 forms.* command schemas (Forms W1). MEASURED. */ // +1: entities.commands.tick binds TickCriteriaInputSchema (bug 01a0d2f1). +7: the SC-3 space/node credential commands bind. +2: service-key put and delete bind (Jev lane K).
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
      // 141: auth.claim.reissue is genuinely body-less (no input, auth.* so no
      // CommandContext), enumerated in UNBOUND_COMMAND_OPERATIONS as such.
      'auth.claim.reissue',
      // 177: containers.files.put carries a TAR OCTET-STREAM, not JSON, so a
      // strict object schema would refuse every legitimate upload. Genuinely
      // body-less in the zod sense — the first clause of that constant's rule,
      // not a gap. The family's other nineteen commands all bind.
      'containers.files.put',
    ]);

    const mounted = new Set(handlers.all);
    const registerableV1Http = OPERATIONS.filter(
      ({ method, status }) => method !== 'WS' && status === 'v1',
    );
    // 160 -> 163 (W4/132): the three taskWorkflows routes, all mounted.
    // 166 -> 169 (148): the three workflows routes, all mounted.
    // 169 -> 193 (2026-09-03): 24 of the 25 containers.* rows are registerable
    // v1 HTTP; the 25th is the WS alias, which mounts nothing. MEASURED.
    // 193 -> 194 (187): execution.sessions.share is v1 HTTP and mounted, so
    // the zero-residual assertion below still holds. MEASURED.
    // 193 -> 194 (2026-09-19, Changes surface phase 1): execution.gitStage is a
    // registerable v1 HTTP command. MEASURED.
    // 194 -> 195 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): sharing + gitStage. MEASURED on the merged tree from this assertion's own failing run.
    // 195 -> 199 (2026-09-23): the four skills.* rows, all mounted v1 HTTP. MEASURED on the merged tree.
    // 199 -> 204 (2026-09-23 F4). MEASURED.
    // 204 -> 205 (Jev lane F): launch.suggest, mounted (placeholder). MEASURED.
    expect(registerableV1Http).toHaveLength(234); /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 (SC-3). +3 (Jev lane K). MEASURED. /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */
    // Every registerable v1 HTTP op has a handler, including the six new
    // artifacts.* rows now that the artifacts server lane has mounted them.
    expect(registerableV1Http.filter(({ name }) => !mounted.has(name))).toHaveLength(0);
    expect(registerableV1Http.filter(({ name }) => !mounted.has(name)).map(({ name }) => name))
      .toEqual([]);
    expect(mounted.has('search.query')).toBe(false);
    expect(mounted.has('bridge.fetchBlob')).toBe(false);
  });
});
