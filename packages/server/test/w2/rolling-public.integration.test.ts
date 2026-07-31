import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FILE_MAX_SIZE_BYTES_DEFAULT,
  getOperation,
  OPERATIONS,
  V1_OPERATIONS,
  type OperationName,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import {
  INPUT_SCHEMAS,
  registerFacadeHandlers,
  UNBOUND_COMMAND_OPERATIONS,
} from '../../src/facade/index.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import { loadConfig } from '../../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import type { RequestContext } from '../../src/http/types.js';
import {
  errorCode,
  startW3PublicServer,
  type W3PublicServer,
} from '../w3/public-harness.js';

/**
 * The frozen tranche-v1 facade surface (I01): G01/G03/G05/G06/G07/G08/G09 plus
 * the two legacy message reads. Tranche-v2 must not remove or disturb a single
 * row of it — seven of these groups already hold an independent W3 public PASS.
 */
const TRANCHE_V1_FACADE_OPERATIONS = [
  'actions.list',
  'collections.query',
  'commands.undo',
  'edgeTypes.list',
  'edges.create',
  'edges.delete',
  'edges.list',
  'edges.patch',
  'entities.activity',
  'entities.children',
  'entities.commands.complete',
  'entities.commands.work',
  'entities.create',
  'entities.get',
  'entities.patch',
  'entities.points.add',
  'files.download',
  'files.uploadAbort',
  'files.uploadComplete',
  'files.uploadInit',
  'graph.query',
  'identity.get',
  'inbox.list',
  'inbox.markRead',
  'messages.list',
  'messages.post',
  'placements.apply',
  'projects.associations.correct',
  'projects.create',
  'projects.get',
  'projects.link',
  'projects.list',
  'projects.unlink',
  'projects.update',
  'readMarks.upsert',
  'savedViews.create',
  'savedViews.delete',
  'savedViews.list',
  'savedViews.update',
  'spaces.awards',
  'spaces.create',
  'spaces.get',
  'spaces.home',
  'spaces.invites.create',
  'spaces.invites.list',
  'spaces.invites.redeem',
  'spaces.invites.revoke',
  'spaces.leaderboard',
  'spaces.list',
  'spaces.members.list',
  'spaces.navigation',
  'spaces.settings',
  'spaces.taskAxes.create',
  'spaces.taskAxes.delete',
  'spaces.taskAxes.list',
  'spaces.taskAxes.update',
  'spaces.update',
] as const;

/**
 * G02 owns eight operations tranche-v1 already registered from the legacy
 * `handlers/entities.ts` and `handlers/commands.ts` wrappers. Its seam must
 * REPLACE them — the registry throws on a duplicate `register`, so composing
 * both at once is not a merge, it is a crash.
 */
const G02_REPLACED_OPERATIONS = [
  'entities.activity',
  'entities.children',
  'entities.commands.complete',
  'entities.commands.work',
  'entities.create',
  'entities.get',
  'entities.patch',
  'entities.points.add',
] as const;

/** G02's eleven net-new operations — the entire growth of tranche-v2. */
const G02_NET_NEW_OPERATIONS = [
  'attentionRequests.create',
  'attentionRequests.list',
  'attentionRequests.resolveEntity',
  'attentionRequests.update',
  'entities.commands.linkCommit',
  'entities.commands.linkPr',
  'entities.commands.pull',
  'entities.connections',
  'entities.delete',
  'entities.hierarchy',
  'entities.move',
  'entities.react',
  'entities.restore',
  'entities.versions',
  'tracking.refresh',
] as const;

const EXPECTED_TRANCHE_V2_FACADE_OPERATIONS: readonly string[] = [
  ...TRANCHE_V1_FACADE_OPERATIONS,
  ...G02_NET_NEW_OPERATIONS,
].sort();

/**
 * Tranche-v3 (I03) composes the four remaining frozen groups. Each list below
 * is the group's registration seam read as source of truth, not a count.
 *
 * G04 is the one group that REPLACES as well as adds: it owns `messages.list`
 * and `messages.post`, both of which tranche-v1 registered inline from
 * `handlers/messages.ts`. Those two legacy registrations had to be DELETED from
 * `facade/index.ts` — `register()` throws on a duplicate name, so there is no
 * build where both are mounted and the swap goes unnoticed.
 */
const G04_REPLACED_OPERATIONS = [
  'messages.list',
  'messages.post',
] as const;

/** G04's eight net-new operations — messages/attachments/delivery/handoffs. */
const G04_NET_NEW_OPERATIONS = [
  'handoffs.list',
  'handoffs.send',
  'handoffs.withdraw',
  'messages.attachments.add',
  'messages.attachments.remove',
  'messages.delete',
  'messages.delivery.get',
  'messages.edit',
] as const;

/** G12's eleven net-new operations — entity kinds + Interaction Profiles. */
const G12_NET_NEW_OPERATIONS = [
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
] as const;

/** G13's two net-new operations — the universal feed and focus context. */
const G13_NET_NEW_OPERATIONS = [
  'entities.context',
  'entities.feed',
] as const;

/** G14's three net-new operations — space menu + default channel. */
const G14_NET_NEW_OPERATIONS = [
  'spaces.defaultChannel.set',
  'spaces.menu.get',
  'spaces.menu.update',
] as const;

const TRANCHE_V3_NET_NEW_OPERATIONS = [
  ...G04_NET_NEW_OPERATIONS,
  ...G12_NET_NEW_OPERATIONS,
  ...G13_NET_NEW_OPERATIONS,
  ...G14_NET_NEW_OPERATIONS,
] as const;

/**
 * The consolidation wave (2026-07-31): server connections, artifacts and voice
 * landed as facade registrations after tranche-v3 froze. Net-new only — no
 * replacements, so no closure-identity pin is owed for these.
 */
const CONSOLIDATION_NET_NEW_OPERATIONS = [
  'artifacts.create',
  'artifacts.export',
  'artifacts.preview.start',
  'artifacts.publish',
  'artifacts.restore',
  'artifacts.revisions.list',
  'serverConnections.create',
  'serverConnections.delete',
  'serverConnections.get',
  'serverConnections.list',
  'voice.token.create',
] as const;

const EXPECTED_TRANCHE_V3_FACADE_OPERATIONS: readonly string[] = [
  ...EXPECTED_TRANCHE_V2_FACADE_OPERATIONS,
  ...TRANCHE_V3_NET_NEW_OPERATIONS,
  ...CONSOLIDATION_NET_NEW_OPERATIONS,
].sort();

/** Substituted for every `:param` so one probe covers any catalog path shape. */
const PROBE_UUID = '00000000-0000-7000-8000-000000000901';
/** Unknown key + missing required fields: rejected by every `.strict()` DTO. */
const INVALID_BODY = { __definitely_not_a_contract_field: true };
const REFUSED_MUTATION_ID = 'i02-invariant-refused-9d1c';
const FAILED_MUTATION_ID = 'i02-invariant-failed-9d1c';

const FAKE_OWNER = {
  identityId: 'w2-i02-owner',
  accountId: '00000000-0000-7000-8000-000000000801',
  username: 'w2-i02-owner',
  isNodeAdmin: false,
  isOwner: true,
};

function context(
  opName: OperationName,
  options: { params?: Record<string, string>; query?: string; body?: unknown } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `req-${opName}`,
    identity: { kind: 'auto-owner', identityId: FAKE_OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

class RegistrationDb implements Db {
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> =
    async <T>(): Promise<T> => ({ patches: [] }) as T;

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(): Promise<R[]> => [],
      rpc: <T>(name: string, args: readonly unknown[] = []): Promise<T> =>
        this.rpcImpl<T>(name, args),
    });
  }

  async query<R>(): Promise<R[]> {
    return [];
  }

  rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.rpcImpl<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function composeTrancheV2(
  dataDir: string,
  db: RegistrationDb = new RegistrationDb(),
  owner?: FacadeDeps['owner'],
): HandlerRegistry {
  const config = loadConfig({ TM8_DATA_DIR: dataDir, TM8_FILE_MAX_SIZE_BYTES: '4096' });
  const registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db,
    config,
    ...(owner ? { owner } : {}),
    files: {
      blobStore: createW2BlobStore({ dataDir, maxSizeBytes: config.fileMaxSizeBytes }),
      maxSizeBytes: config.fileMaxSizeBytes,
    },
  });
  return registry;
}

describe('W2.I02 tranche-v2 public composition', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w2-i01-'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('replaces G02\'s eight and G04\'s two legacy registrations and mounts the exact 92-operation facade tranche', () => {
    // The premise of "replacement, not duplication": all eight were already
    // registered at tranche-v1, and none of the eleven were.
    for (const operation of G02_REPLACED_OPERATIONS) {
      expect(TRANCHE_V1_FACADE_OPERATIONS, operation).toContain(operation);
    }
    for (const operation of G02_NET_NEW_OPERATIONS) {
      expect(TRANCHE_V1_FACADE_OPERATIONS, operation).not.toContain(operation);
    }

    // Same premise for tranche-v3: G04 REPLACES the two legacy message
    // registrations, and the other twenty-four rows are genuinely new. This is
    // the whole list a behavioural-drift review has to look at — a replaced
    // operation keeps its name and its count while changing what it does, which
    // is the one failure mode no accounting assertion in this file can catch.
    for (const operation of G04_REPLACED_OPERATIONS) {
      expect(TRANCHE_V1_FACADE_OPERATIONS, operation).toContain(operation);
    }
    for (const operation of TRANCHE_V3_NET_NEW_OPERATIONS) {
      expect(EXPECTED_TRANCHE_V2_FACADE_OPERATIONS, operation).not.toContain(operation);
    }

    // `HandlerRegistry.register` throws on a duplicate name, so composing G02
    // or G04 over the legacy wrappers without removing them cannot silently
    // pass here.
    const registry = composeTrancheV2(dataDir);

    expect(registry.implemented()).toEqual(EXPECTED_TRANCHE_V3_FACADE_OPERATIONS);
    expect(new Set(registry.implemented()).size).toBe(registry.size);
    expect(registry.size).toBe(107);
    expect(registry.size).toBe(
      TRANCHE_V1_FACADE_OPERATIONS.length
        + G02_NET_NEW_OPERATIONS.length
        + TRANCHE_V3_NET_NEW_OPERATIONS.length
        + CONSOLIDATION_NET_NEW_OPERATIONS.length,
    );
    expect(registry.has('search.query')).toBe(false);
    expect(registry.has('bridge.fetchBlob')).toBe(false);
  });

  /**
   * `messages.list` is the OTHER replaced operation, and the riskier-looking of
   * the two: unlike `messages.post` it is live today with a real working body,
   * so a frozen group taking it over could silently change a user-visible read.
   *
   * It does not, and this pins why: G04's seam registers `messagesList(deps)` —
   * the SAME factory, imported from the same `handlers/messages.js`, applied to
   * the same `FacadeDeps`. The replacement is a change of call site only, so the
   * roots-versus-replies switch, the cursor fingerprint accept/reject pair, the
   * oldest-first ordering, the separate `replyCount` group-by, the
   * nextCursor-versus-null decision and the non-'message' silent-drop path are
   * preserved by construction rather than by re-implementation.
   *
   * Comparing closure source is deliberate: it is what actually goes red if a
   * later edit points `messages.list` at a different implementation while
   * keeping the name and the count intact.
   *
   * BOTH HALVES, because an equality assertion that cannot fail proves nothing.
   * The negative controls below establish that closure-source comparison
   * genuinely DISCRIMINATES between handlers rather than collapsing everything
   * to a single string: a different operation's handler, and a different
   * factory over the same deps, must both compare UNEQUAL. Without them a
   * degenerate `toString()` would make the positive half pass forever.
   */
  it('keeps messages.list on the identical legacy factory, and the comparison discriminates', () => {
    const db = new RegistrationDb();
    const config = loadConfig({ TM8_DATA_DIR: dataDir, TM8_FILE_MAX_SIZE_BYTES: '4096' });
    const facade: FacadeDeps = { db, config, owner: async () => FAKE_OWNER };
    const registry = composeTrancheV2(dataDir, db, facade.owner);

    const composed = registry.get('messages.list')!;
    const legacy = messagesList(facade);

    // POSITIVE: the composed handler IS the legacy reader.
    expect(typeof composed).toBe('function');
    expect(composed.toString()).toBe(legacy.toString());

    // NEGATIVE CONTROLS: two genuinely different operations mounted by the SAME
    // G04 seam must both compare UNEQUAL. This is the shape a real drift would
    // take — a service method silently taking over the name — and it proves the
    // positive half above is not passing because every handler stringifies
    // alike. Both controls read the registry rather than importing a second
    // factory, so deleting a handler module's export cannot silently disarm
    // them the way it did when this control named `messagesPost` directly.
    expect(registry.get('messages.edit')!.toString()).not.toBe(legacy.toString());
    expect(registry.get('messages.delete')!.toString()).not.toBe(legacy.toString());
  });

  /**
   * `messages.post` is the single operation whose BEHAVIOUR this tranche
   * changes rather than adds: tranche-v1 mounted an unconditional
   * `not_implemented` stub from `handlers/messages.ts`, and G04's real handler
   * takes its place.
   *
   * The stub's `messagesPost` export has since been DELETED from
   * `handlers/messages.ts`, so this test can no longer compare against it —
   * and it no longer needs to. What it asserts instead is the property that
   * mattered all along: the handler mounted under this name reaches G04's
   * semantics and does NOT answer `not_implemented`. That survives the stub's
   * deletion, and it is still what goes red if the composition is reverted,
   * because a reverted build has no handler here at all.
   */
  it('answers messages.post with G04\'s semantics, never the retired 501', async () => {
    const registry = composeTrancheV2(dataDir, new RegistrationDb(), async () => FAKE_OWNER);

    // The composed handler reaches G04 and rejects an empty anchor set as
    // invalid input. The `not_implemented` assertion is the load-bearing half:
    // it is what the retired stub would have answered for this same input.
    const composed = registry.get('messages.post')!;
    await expect(composed(context('messages.post', {
      body: { clientMutationId: 'i03-post', anchorIds: [], body: 'drift probe' },
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(composed(context('messages.post', {
      body: { clientMutationId: 'i03-post', anchorIds: [], body: 'drift probe' },
    }))).rejects.not.toMatchObject({ code: 'not_implemented' });
  });

  it('preserves G02\'s two frozen non-200 command statuses through the composed registry', async () => {
    const db = new RegistrationDb();
    const calls: Array<{ fn: string; args: readonly unknown[] }> = [];
    db.rpcImpl = async <T>(fn: string, args: readonly unknown[]): Promise<T> => {
      calls.push({ fn, args });
      if (fn === 'queue_tracking_refresh') {
        return { accepted: true, status: 'queued' } as T;
      }
      return { patches: [] } as T;
    };
    const registry = composeTrancheV2(dataDir, db, async () => FAKE_OWNER);

    const created = await registry.get('entities.create')!(context('entities.create', {
      body: {
        clientMutationId: 'i02-create',
        spaceId: '00000000-0000-7000-8000-000000000802',
        kind: 'doc',
        title: 'Tranche-v2 doc',
      },
    }));
    expect(created).toMatchObject({ kind: 'json', status: 201 });

    const accepted = await registry.get('tracking.refresh')!(context('tracking.refresh', {
      body: {
        clientMutationId: 'i02-refresh',
        entityIds: ['00000000-0000-7000-8000-000000000803'],
      },
    }));
    expect(accepted).toMatchObject({
      kind: 'json',
      status: 202,
      data: { accepted: true, status: 'queued' },
    });
    expect(calls.map((call) => call.fn)).toEqual(['create_document', 'queue_tracking_refresh']);
  });

  it('resolves one absolute data root and one positive-safe-integer file ceiling from configuration', () => {
    const config = loadConfig({
      TM8_DATA_DIR: dataDir,
      TM8_FILE_MAX_SIZE_BYTES: '8192',
    });
    expect(config.dataDir).toBe(dataDir);
    expect(config.fileMaxSizeBytes).toBe(8192);
    expect(loadConfig({ TM8_DATA_DIR: dataDir }).fileMaxSizeBytes)
      .toBe(FILE_MAX_SIZE_BYTES_DEFAULT);

    expect(() => loadConfig({
      TM8_DATA_DIR: dataDir,
      TM8_FILE_MAX_SIZE_BYTES: '0',
    })).toThrow(/positive safe integer/);
    expect(() => loadConfig({
      TM8_DATA_DIR: dataDir,
      TM8_FILE_MAX_SIZE_BYTES: String(Number.MAX_SAFE_INTEGER + 1),
    })).toThrow(/positive safe integer/);
  });

  it('declaratively binds every completed tranche command and leaves only unfinished commands unbound', () => {
    // 59 -> 64 on 2026-07-31: the consolidation wave bound serverConnections,
    // artifacts and voice command DTOs as it landed them.
    expect(Object.keys(INPUT_SCHEMAS)).toHaveLength(64);
    // G02 resolved its two entries the way every other "unbound" catalog row was
    // resolved — a required command context, not an invented DTO. Tranche-v3
    // resolved the last one: G04's service casts `ctx.body` to its contract DTO
    // without validating, so composing it REQUIRED binding the five message and
    // handoff commands the contract already names 1:1. Nothing is unbound now.
    expect(UNBOUND_COMMAND_OPERATIONS).toEqual([]);
    for (const operation of [
      'messages.delete',
      'messages.attachments.add',
      'messages.attachments.remove',
      'handoffs.send',
      'handoffs.withdraw',
      'commands.undo',
      'entities.delete',
      'entities.restore',
      'edges.delete',
      'inbox.markRead',
      'projects.associations.correct',
      'projects.unlink',
      'readMarks.upsert',
      'savedViews.delete',
      'spaces.invites.create',
      'spaces.invites.redeem',
      'spaces.invites.revoke',
      'spaces.taskAxes.delete',
    ] as const) {
      expect(INPUT_SCHEMAS[operation], operation).toBeDefined();
    }
  });
});

describe('W2.I01 pre-body support-route integration', () => {
  let server: FacadeServer;
  let baseUrl: string;
  const observed: Array<{ requestId: string; identityId: string | undefined; bytes: string }> = [];

  beforeAll(async () => {
    server = createFacadeServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        uiDir: undefined,
        maxBodyBytes: 1024,
        databaseUrl: undefined,
      },
      registry: new HandlerRegistry(),
      identityResolver: async () => ({ kind: 'auto-owner', identityId: 'identity-i01' }),
      fileUploadRoute: async (req, res, context) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          observed.push({
            requestId: context.requestId,
            identityId: context.identity.identityId,
            bytes: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(204, { 'x-tm8-request-id': context.requestId });
          res.end();
        return true;
      },
    });
    baseUrl = (await server.listen()).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('handles raw grant bytes before JSON parsing with the request identity and requestId', async () => {
    const response = await fetch(
      `${baseUrl}/v2/files/uploads/00000000-0000-7000-8000-000000000701/content`,
      { method: 'PUT', body: 'raw-not-json' },
    );

    expect(response.status).toBe(204);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ identityId: 'identity-i01', bytes: 'raw-not-json' });
    expect(response.headers.get('x-tm8-request-id')).toBe(observed[0]?.requestId);
  });

  it('does not swallow a similar unknown support path or any unknown catalog path', async () => {
    const similar = await fetch(`${baseUrl}/v2/files/uploads/not-a-uuid/content`, {
      method: 'PUT',
    });
    expect(similar.status).toBe(404);

    const unknown = await fetch(`${baseUrl}/v2/not-a-catalog-route`);
    expect(unknown.status).toBe(404);
    expect(observed).toHaveLength(1);
  });
});

describe.sequential('W2.I02 real production public surface', () => {
  let harness: W3PublicServer;

  beforeAll(async () => {
    harness = await startW3PublicServer('i02_surface');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('reports the exact 99-handler production composition and preserves 501/404 honesty', async () => {
    const healthResponse = await fetch(`${harness.baseUrl}/health`);
    const health = await healthResponse.json() as {
      ok: boolean;
      operations: number;
      implemented: number;
    };
    expect(healthResponse.status).toBe(200);
    // 92 facade + the FIVE execution handlers (A21 execution.liveness joined
    // spawn/prompt/terminate/streams-attach) + `events.poll` + `presence.get`.
    // `presence.get` mounts ONLY when bootstrap() supplies a presence source, so
    // this number is reachable exclusively through the real composition root —
    // a hand-rolled registry that omits the presence store measures 98 and is
    // not measuring production. `implemented` is `registry.size`, the count of
    // MOUNTED handlers: the honest answer to "what is registered on this node",
    // which is not the same claim as "what is behaviourally complete".
    expect(health).toMatchObject({ ok: true, operations: 116, implemented: 114 });
    expect(harness.production.server.registry.size).toBe(114);

    // Residual honesty, derived from the live catalog rather than a literal.
    // This is now ZERO: every registerable v1 HTTP operation is mounted, and the
    // only refusals left in the whole catalog are the two contractually reserved
    // reads. An empty residual is a real milestone, so it is asserted as an
    // exact empty array rather than a length nobody would notice moving.
    const registered = new Set<string>(harness.production.server.registry.implemented());
    const residual = V1_OPERATIONS
      .filter((op) => op.method !== 'WS' && !registered.has(op.name))
      .map((op) => op.name);
    expect(residual).toEqual([]);
    expect(registered.size + residual.length).toBe(114);
    expect(residual).not.toContain('search.query');
    expect(residual).not.toContain('bridge.fetchBlob');

    const reserved = await harness.request('GET', '/v2/search?q=rolling');
    expect(reserved.status).toBe(501);
    expect(errorCode(reserved)).toBe('not_implemented');
    const bridge = await harness.request(
      'GET',
      '/v2/bridge/blobs/00000000-0000-7000-8000-000000000001',
    );
    expect(bridge.status).toBe(501);
    expect(errorCode(bridge)).toBe('not_implemented');

    // `entities.move` was tranche-v1's proof that an uncomposed operation stays
    // 501. It is composed now, so it must answer with real semantics — an
    // honest `not_found` for an entity that does not exist, never a 501.
    const moved = await harness.request(
      'POST',
      '/v2/entities/00000000-0000-7000-8000-000000000001/move',
      { parentId: null, position: 0, expectedVersion: 1, clientMutationId: 'i02-move' },
    );
    expect(moved.status).not.toBe(501);
    expect(moved.status).toBe(404);
    expect(errorCode(moved)).toBe('not_found');

    // ...and its newly bound input schema now guards it, which only happens
    // after a successful registry lookup.
    const malformed = await harness.request(
      'POST',
      '/v2/entities/00000000-0000-7000-8000-000000000001/move',
      { parentId: null, clientMutationId: 'i02-move-malformed' },
    );
    expect(malformed.status).toBe(400);
    expect(errorCode(malformed)).toBe('invalid_input');

    // `messages.edit` was tranche-v2's proof that an uncomposed G04 operation
    // answered 501 ahead of validation. G04 is composed now, so the SAME body
    // must reach validation and be rejected as invalid input — which only
    // happens after a successful registry lookup.
    const composedEdit = await harness.request(
      'PATCH',
      '/v2/messages/00000000-0000-7000-8000-000000000001',
      { nope: true },
    );
    expect(composedEdit.status).not.toBe(501);
    expect(composedEdit.status).toBe(400);
    expect(errorCode(composedEdit)).toBe('invalid_input');

    // `presence.get` was the last residual v1 HTTP operation and is mounted now
    // (bootstrap() supplies the in-process presence store). It must therefore
    // answer with real semantics rather than a 501 — the same transition
    // `entities.move` made at tranche-v2 and `messages.edit` made above.
    const presence = await harness.request(
      'GET',
      '/v2/entities/00000000-0000-7000-8000-000000000001/presence',
    );
    expect(presence.status).not.toBe(501);

    const unknown = await harness.request('GET', '/v2/not-a-catalog-route');
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe('not_found');
  });

  /**
   * W3 proved this empirically at the tranche-v1 gate rather than assuming it,
   * and its gate re-checks it. Binding G02's input schemas must not drag
   * validation ahead of the not-implemented decision for the operations that
   * remain residual: an unbuilt route must not leak that it would have
   * validated. The second half is what makes the first half mean anything —
   * the SAME body must reach validation on a built operation.
   */
  it('refuses all 2 remaining operations before input validation, and validates the composed ones', async () => {
    const registered = new Set<string>(harness.production.server.registry.implemented());
    const refusing = OPERATIONS.filter((op) => op.method !== 'WS' && !registered.has(op.name));
    expect(refusing).toHaveLength(2);
    expect(refusing.map((op) => op.name).sort())
      .toEqual(['bridge.fetchBlob', 'search.query']);
    // The refusing set is now EXACTLY the reserved set — nothing is unbuilt any
    // more, only contractually withheld. If these two ever stop matching, the
    // node has either implemented a reserved operation or regressed a built one.
    expect(refusing.filter((op) => op.status === 'reserved').map((op) => op.name))
      .toEqual(['search.query', 'bridge.fetchBlob']);
    expect(refusing.every((op) => op.status === 'reserved')).toBe(true);
    // Both are reads. No v1 command is unmounted, which is why the
    // refusal-costs-nothing probe below cannot be built from a residual command
    // and uses a reserved read instead.
    expect(refusing.every((op) => op.method === 'GET')).toBe(true);

    for (const op of refusing) {
      const path = op.path.replace(/:([A-Za-z]+)/g, () => PROBE_UUID);
      // fetch refuses to attach a body to GET, so those probe the route alone.
      const response = op.method === 'GET'
        ? await harness.request(op.method, path)
        : await harness.request(op.method, path, INVALID_BODY);
      expect(response.status, op.name).toBe(501);
      expect(errorCode(response), op.name).toBe('not_implemented');
    }

    // Non-vacuity: the identical body is genuinely capable of failing
    // validation, and does so on five freshly composed G02 operations. The
    // `delete`/`restore` pair is here on purpose — it is the runtime proof that
    // both really are schema-bound now, rather than merely absent from the
    // source-level `UNBOUND_COMMAND_OPERATIONS` list.
    for (const [method, path] of [
      ['POST', `/v2/entities/${PROBE_UUID}/move`],
      ['PUT', `/v2/entities/${PROBE_UUID}/reaction`],
      ['DELETE', `/v2/entities/${PROBE_UUID}`],
      ['POST', `/v2/entities/${PROBE_UUID}/restore`],
      ['POST', '/v2/tracking/refresh'],
    ] as const) {
      const response = await harness.request(method, path, INVALID_BODY);
      expect(response.status, path).toBe(400);
      expect(errorCode(response), path).toBe('invalid_input');
    }
  });

  /**
   * A refusal must cost nothing. No mutation ID may be reserved and no row
   * partially written before an operation decides it cannot proceed — otherwise
   * a client that retried a refused command with the same ID would replay a
   * result that never happened.
   */
  it('reserves no mutation ID and writes no row when a command is refused or fails', async () => {
    const totals = async (): Promise<Record<string, string>> => {
      const [row] = await harness.rows<Record<string, string>>(
        `select (select count(*) from public.command_ledger)::text ledger,
                (select count(*) from public.entities)::text entities,
                (select count(*) from public.edges)::text edges`,
      );
      return row!;
    };

    const before = await totals();

    // Refused: tranche-v3 leaves no residual v1 COMMAND, so the refusal is
    // probed on the reserved read that must answer 501 forever. The mutation ID
    // travels as a query parameter because there is no longer any refusing
    // operation that accepts a body at all.
    const refused = await harness.request(
      'GET',
      `/v2/search?q=${REFUSED_MUTATION_ID}`,
    );
    expect(refused.status).toBe(501);
    expect(errorCode(refused)).toBe('not_implemented');

    // The same G04 handoff command that tranche-v2 probed as refused is now
    // composed. It must reach its handler and fail there — not 501 — and it
    // must still leave the ledger untouched, which is the invariant this test
    // actually protects.
    const composedHandoff = await harness.request(
      'POST',
      `/v2/work-sessions/${PROBE_UUID}/handoffs`,
      { clientMutationId: REFUSED_MUTATION_ID, sourceEntityId: PROBE_UUID },
    );
    expect(composedHandoff.status).not.toBe(501);

    // Failed: a composed G02 command that reaches its handler and aborts.
    const failed = await harness.request(
      'POST',
      `/v2/entities/${PROBE_UUID}/move`,
      { parentId: null, position: 0, expectedVersion: 1, clientMutationId: FAILED_MUTATION_ID },
    );
    expect(failed.status).toBe(404);
    expect(errorCode(failed)).toBe('not_found');

    const ledger = await harness.rows(
      `select client_mutation_id from public.command_ledger where client_mutation_id = any($1)`,
      [[REFUSED_MUTATION_ID, FAILED_MUTATION_ID]],
    );
    expect(ledger).toEqual([]);
    expect(await totals()).toEqual(before);
  });
});
