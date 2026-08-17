/**
 * A TEAMMATE'S DEFAULT PROFILE MUST ARRIVE ON THE ROW, NOT ON A SECOND REQUEST.
 *
 * === WHY THIS EXISTS ===
 *
 * `state.defaultProfileId` is DERIVED from a `defaults_to_profile` edge, and it
 * was added for one reason: reading it must not cost a request. The client used
 * to answer "which profile does this teammate default to?" with
 * `entities.connections(teammate.id)` — once per teammate — because the row did
 * not carry it. Measured on the real app, a space with 129 teammates paid 136
 * round trips and ~3.0s of a 3.9s workspace boot for exactly that question.
 *
 * So the property under test is not "the field exists". It is that the field is
 * CORRECT on the reads a client already makes, for a teammate that has a default
 * and for one that does not — because a field that is silently null is worse
 * than no field at all: the client would trust it and quietly lose every
 * teammate's preselection.
 *
 * === WHY THE EDGE IS WRITTEN THROUGH THE REAL COMMAND ===
 *
 * `set_teammate_profile_default` (027:1146) is what production uses, and it is
 * the thing this projection has to agree WITH. Hand-inserting a row into
 * `public.edges` would test the reader against my belief about the writer rather
 * than against the writer, and those are exactly the two things that drift. The
 * cost is the full propose -> validate -> activate ceremony below, because the
 * command refuses a profile that is not active — which is itself worth
 * exercising, since it is the only path by which this field is ever non-null.
 *
 * === BOTH READS, DELIBERATELY ===
 *
 * `entities.get` and `collections.query` share one assembler
 * (`entity-read.ts`'s `assembleSummaries`), so asserting both looks redundant.
 * It is not: sharing the assembler is the INVARIANT, not a guarantee, and the
 * boot path that motivated this field uses `collections.query` exclusively. If
 * the two ever diverge, the one the client actually depends on is the one a
 * single-read test would be least likely to cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

interface TeamMemberState {
  kind: string;
  defaultProfileId?: string | null;
}
interface Summary {
  id: string;
  version: number;
  state: TeamMemberState;
}

describeDb('team_member rows carry defaultProfileId', () => {
  let server: FacadeServer;
  let db: Db;
  let base: string;

  /** The teammate that ends up WITH a default, and the one deliberately without. */
  let withDefault = '';
  let withoutDefault = '';
  let profileId = '';
  let spaceId = '';

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
    if (json.error) {
      throw new Error(`${method} ${path} -> ${res.status} ${json.error.code}: ${json.error.message}`);
    }
    return json.data as T;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    const registry = new HandlerRegistry();
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 8 * 1024 * 1024,
      databaseUrl: DATABASE_URL,
    } as unknown as ServerConfig;
    registerFacadeHandlers(registry, { db, config });
    server = createFacadeServer({ config, registry });
    ({ url: base } = await server.listen());

    const space = await call<{ space: { id: string } }>('POST', '/v2/spaces', {
      clientMutationId: `cmid-space-${process.pid}`,
      name: `tm-default-${process.pid}-${process.hrtime.bigint()}`,
    });
    spaceId = space.space.id;

    const mkTeammate = async (title: string): Promise<string> => {
      const res = await call<{ entity: { id: string } }>('POST', '/v2/entities', {
        clientMutationId: `cmid-tm-${title}-${process.pid}`,
        spaceId,
        kind: 'team_member',
        title,
        content: { identity: `${title} persona.`, model: 'claude-opus-4-8', agentTool: 'claude-code' },
      });
      return res.entity.id;
    };
    withDefault = await mkTeammate('Forge');
    withoutDefault = await mkTeammate('Bare');

    // propose -> validate -> activate. The command under test refuses anything
    // less than an ACTIVE profile (`w2g12_assert_active_profile`), so the whole
    // ceremony is load-bearing rather than ritual.
    const proposed = await call<{ profileId: string; currentDraftVersion: number }>(
      'POST', `/v2/spaces/${spaceId}/interaction-profiles`,
      {
        clientMutationId: `cmid-propose-${process.pid}`,
        spaceId,
        draft: PROFILE_DRAFT,
      },
    );
    profileId = proposed.profileId;
    const validated = await call<{
      status: string; validatedHash: string; profileVersion: number;
      issues: Array<{ path: string; message: string }>;
    }>(
      'POST', `/v2/interaction-profiles/${profileId}/validate`,
      { clientMutationId: `cmid-validate-${process.pid}`, expectedVersion: proposed.currentDraftVersion },
    );
    // Fail HERE with the reason rather than three lines down with an opaque
    // "profile is not active" — an invalid draft is the likeliest way this
    // setup breaks when the frozen template moves.
    if (validated.status !== 'valid') {
      throw new Error(`draft did not validate: ${JSON.stringify(validated.issues)}`);
    }
    await call('POST', `/v2/interaction-profiles/${profileId}/activate`, {
      clientMutationId: `cmid-activate-${process.pid}`,
      validatedVersion: validated.profileVersion,
      validatedHash: validated.validatedHash,
      confirm: true,
    });

    const before = await call<Summary>('GET', `/v2/entities/${withDefault}`);
    await call('PUT', `/v2/team-members/${withDefault}/interaction-profile-default`, {
      clientMutationId: `cmid-default-${process.pid}`,
      expectedVersion: before.version,
      profileId,
    });
  });

  afterAll(async () => {
    await server.close();
    await db.end();
  });

  it('entities.get projects the active default onto the teammate row', async () => {
    const detail = await call<Summary>('GET', `/v2/entities/${withDefault}`);
    expect(detail.state.kind).toBe('team_member');
    expect(detail.state.defaultProfileId).toBe(profileId);
  });

  it('entities.get reports null — not a missing key — for a teammate with no default', async () => {
    const detail = await call<Summary>('GET', `/v2/entities/${withoutDefault}`);
    /* `null`, asserted as `null` and not merely falsy: the contract says absence
       MEANS "no default of its own", and a client distinguishes that from "the
       node did not answer". `toBeNull` would pass on `undefined` under
       `toBeFalsy`, so the strict check is the point. */
    expect(detail.state.defaultProfileId).toBeNull();
  });

  it('collections.query — the read boot actually uses — carries it for the whole page', async () => {
    const res = await call<{ page: { items: Summary[] } }>('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['team_member'],
    });
    const byId = new Map(res.page.items.map((row) => [row.id, row.state.defaultProfileId]));
    // Guard against a vacuous pass: if the page were empty every assertion
    // below would hold and mean nothing.
    expect(byId.size).toBeGreaterThanOrEqual(2);
    expect(byId.get(withDefault)).toBe(profileId);
    expect(byId.get(withoutDefault)).toBeNull();
  });

  it('costs no extra query — one page read answers it for every teammate at once', async () => {
    /* The performance claim, made checkable. The field rides the batch edge
       query `loadRelations` already runs for the page, so N teammates cost the
       same ONE collections.query they always did. This asserts the shape of
       that claim (every row answered by a single request) rather than a
       wall-clock number, which would be a flake on a shared box. */
    const res = await call<{ page: { items: Summary[] } }>('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['team_member'],
    });
    for (const row of res.page.items) {
      expect(row.state).toHaveProperty('defaultProfileId');
    }
  });
});

/**
 * The smallest draft the frozen template accepts.
 *
 * Kept beside the test rather than imported from a fixture module on purpose:
 * when the template version moves, the failure should point HERE, at a literal
 * a reader can compare against the schema, rather than at a shared constant
 * three files away whose other consumers also broke.
 */
const PROFILE_DRAFT = {
  name: 'Shapes Default',
  // The key WITHOUT the version — the resolver stores them separately and only
  // renders them joined (`prompt/src/index.ts` writes `<template>key@n`). A
  // draft that folds the '@1' in fails validation as unknown_static_template.
  templateKey: 'tm8.chat.core',
  templateVersion: 1,
  promptPolicy: {
    kernelTemplate: 'tm8.chat.core',
    manifestMaxBytes: 2048,
    kernelMaxBytes: 4096,
    initialContextMaxBytes: 8192,
    rollingControlMaxBytes: 8192,
    allowedInjectionKinds: ['task_assignment'],
    untrustedEncoding: 'escaped-xml',
  },
  toolDiscoveryPolicy: {
    rootHelpRef: 'tm8://help',
    preloadNouns: ['task'],
    semanticSearchEnabled: true,
    semanticMaxMatches: 5,
    nounShardMaxBytes: 8192,
    commandShardMaxBytes: 8192,
    entityContextDefaultBytes: 8192,
  },
  feedPolicy: { scope: 'session_chat_v1', pageSize: 50, bodyExcerptBytes: 1024 },
  providerCaptureMode: 'explicit-only',
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: false,
    allowedAttachmentKinds: [],
    operationBindings: ['messages.post'],
  },
} as const;
