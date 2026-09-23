/**
 * `team_members.mode` and `permission_mode` ride the team_member READ MODEL.
 *
 * The chat composer filters "coordinators only" for an orchestrate chat, and
 * before this the projection carried `kind, owner, model, agentTool, liveWork,
 * defaultProfileId` and nothing a picker could filter a role by. Both reads
 * that build the row — the facade assembler (`entity-read.ts`) and the event
 * projector (`events/projector.ts`) — are covered here through the same door
 * the UI uses, `collections.query`, plus the single-entity read.
 *
 * Self-provisioning: it creates its own scratch database and applies every
 * migration, so it runs wherever the W1 rehearsal harness does (postgres on
 * 127.0.0.1:5442 by default) and skips only when that admin URL is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import type { ServerConfig } from '../../src/http/config.js';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

interface Summary {
  id: string;
  state: { kind: string; mode?: string | null; permissionMode?: string | null };
}

const CAN_PG = process.env['TM8_SKIP_PG'] !== '1';
const describeDb = CAN_PG ? describe : describe.skip;

describeDb('team_member rows carry mode and permissionMode', () => {
  let scratch: W1ScratchDatabase;
  let server: FacadeServer;
  let db: Db;
  let base: string;
  let spaceId = '';
  let coordinator = '';
  let worker = '';
  let bare = '';

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
    scratch = await createW1ScratchDatabase('tm-mode');
    scratch.apply(migrationFiles());
    db = createDb(scratch.url);
    const registry = new HandlerRegistry();
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 8 * 1024 * 1024,
      databaseUrl: scratch.url,
    } as unknown as ServerConfig;
    registerFacadeHandlers(registry, { db, config });
    server = createFacadeServer({ config, registry });
    ({ url: base } = await server.listen());

    const space = await call<{ space: { id: string } }>('POST', '/v2/spaces', {
      clientMutationId: `cmid-space-${process.pid}`,
      name: `tm-mode-${process.pid}-${process.hrtime.bigint()}`,
    });
    spaceId = space.space.id;

    const mk = async (title: string, extra: Record<string, unknown>): Promise<string> => {
      const res = await call<{ entity: { id: string } }>('POST', '/v2/entities', {
        clientMutationId: `cmid-tm-${title}-${process.pid}`,
        spaceId,
        kind: 'team_member',
        title,
        content: { identity: `${title} persona.`, model: 'claude-opus-5', agentTool: 'claude-code', ...extra },
      });
      return res.entity.id;
    };
    coordinator = await mk('Conductor', { mode: 'coordinator', permissionMode: 'acceptEdits' });
    worker = await mk('Builder', { mode: 'worker' });
    bare = await mk('Bare', {});
  }, 240_000);

  afterAll(async () => {
    await server?.close();
    await db?.end();
    await scratch?.destroy();
  });

  it('collections.query — the picker read — states each teammate’s role and ceiling', async () => {
    const res = await call<{ page: { items: Summary[] } }>('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['team_member'],
    });
    const byId = new Map(res.page.items.map((row) => [row.id, row.state]));
    expect(byId.size).toBeGreaterThanOrEqual(3);
    expect(byId.get(coordinator)).toMatchObject({ mode: 'coordinator', permissionMode: 'acceptEdits' });
    expect(byId.get(worker)).toMatchObject({ mode: 'worker', permissionMode: null });
    /* `null`, present: absence would mean an older node; a row that simply
       has no role must SAY so, or the composer cannot tell the two apart. */
    const bareState = byId.get(bare);
    expect(bareState).toHaveProperty('mode');
    expect(bareState?.mode).toBeNull();
    expect(bareState?.permissionMode).toBeNull();
  });

  it('the single-entity read agrees with the page', async () => {
    const detail = await call<{ state: Summary['state'] }>('GET', `/v2/entities/${coordinator}`);
    expect(detail.state.kind).toBe('team_member');
    expect(detail.state.mode).toBe('coordinator');
    expect(detail.state.permissionMode).toBe('acceptEdits');
  });
});
