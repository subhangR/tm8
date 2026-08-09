/**
 * Real-Postgres acceptance for short-lived, hash-only, atomic PTY grants.
 * The negative cases deliberately converge on one 403 response.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '@tm8/execution';

import { createDb, type Db } from '../src/db/index.js';
import {
  createPtyAttachAuthorizer,
  createPtyWsServer,
  hashPtyGrantToken,
  issuePtyGrantToken,
  PTY_GRANT_PROTOCOL_PREFIX,
  PTY_PROTOCOL,
  type PtyAttachAuthzLogger,
} from '../src/pty/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CWD = process.cwd();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  setNoDelay(): this { return this; }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  written(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}

function upgradeReq(
  sessionId: string,
  mode: 'view' | 'drive',
  token?: string,
): IncomingMessage {
  return {
    url: `/v2/ws?sessionId=${sessionId}&mode=${mode}&offset=0`,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...(token
        ? { 'sec-websocket-protocol': `${PTY_PROTOCOL}, ${PTY_GRANT_PROTOCOL_PREFIX}${token}` }
        : {}),
    },
  } as unknown as IncomingMessage;
}

/** Client frames must be masked under RFC 6455. */
function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i]! ^ mask[i % 4]!;
  }
  if (payload.length > 125) throw new Error('test frames stay short');
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

interface Fixture {
  aliceIdentity: string;
  bobIdentity: string;
  spaceId: string;
  aliceMember: string;
  bobMember: string;
  privateSession: string;
  sharedSession: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fx: Fixture;

async function seed(): Promise<Fixture> {
  return await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      aliceIdentity: 'pty-grant-alice',
      bobIdentity: 'pty-grant-bob',
      spaceId: randomUUID(),
      aliceMember: randomUUID(),
      bobMember: randomUUID(),
      privateSession: randomUUID(),
      sharedSession: randomUUID(),
    };
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Alice'), ($2, 'Bob')`,
      [ids.aliceIdentity, ids.bobIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'PTY grants', $2)`,
      [ids.spaceId, ids.aliceIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $3, 'member', $1), ($2, $3, 'member', $2)`,
      [ids.aliceMember, ids.bobMember, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Alice'), ($4, $2, $5, 'member', 'Bob')`,
      [ids.aliceMember, ids.spaceId, ids.aliceIdentity, ids.bobMember, ids.bobIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $3, 'work_session', $4), ($2, $3, 'work_session', $4)`,
      [ids.privateSession, ids.sharedSession, ids.spaceId, ids.aliceMember],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1, 'private', 'running', 'none'), ($2, 'shared', 'running', 'space')`,
      [ids.privateSession, ids.sharedSession],
    );
    return ids;
  });
}

async function issue(
  identityId: string,
  sessionId: string,
  mode: 'view' | 'drive',
  ttl = '30 seconds',
): Promise<string> {
  const token = issuePtyGrantToken();
  await db.rpc(
    { identityId },
    'public.grant_stream_attach',
    [sessionId, mode, token.tokenHash, ttl, null],
  );
  return token.token;
}

function authorizerFor(identityId?: string, logger?: PtyAttachAuthzLogger) {
  return createPtyAttachAuthorizer({
    db,
    resolveIdentityId: async () => identityId,
    ...(logger ? { logger } : {}),
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('pty-single-use-grants');
  database.apply(migrationFiles());
  db = createDb(database.url);
  fx = await seed();
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('PTY single-use attach grants — real database', () => {
  it('stores only the SHA-256 hash, never the bearer', async () => {
    const token = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    const row = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const result = await client.query<{ token_hash: string }>(
        `select token_hash from public.stream_grants
          where work_session_id = $1 and mode = 'drive' and revoked_at is null`,
        [fx.privateSession],
      );
      return result.rows[0];
    });
    expect(row?.token_hash).toBe(hashPtyGrantToken(token));
    expect(row?.token_hash).not.toContain(token);
  });

  it('consumes exactly once under a concurrent race', async () => {
    const token = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    const authorize = authorizerFor(fx.aliceIdentity);
    const req = upgradeReq(fx.privateSession, 'drive', token);
    const results = await Promise.all([
      authorize(req, fx.privateSession),
      authorize(req, fx.privateSession),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, status: 403, message: 'attach refused' },
    ]);
  });

  it('makes expired, replayed, wrong-session, wrong-mode and wrong-identity uses identical', async () => {
    const refused = { ok: false, status: 403, message: 'attach refused' } as const;

    const replayToken = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    const alice = authorizerFor(fx.aliceIdentity);
    expect(await alice(upgradeReq(fx.privateSession, 'drive', replayToken), fx.privateSession)).toMatchObject({ ok: true });
    expect(await alice(upgradeReq(fx.privateSession, 'drive', replayToken), fx.privateSession)).toEqual(refused);

    const sessionToken = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    expect(await alice(upgradeReq(fx.sharedSession, 'drive', sessionToken), fx.sharedSession)).toEqual(refused);

    const modeToken = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    expect(await alice(upgradeReq(fx.privateSession, 'view', modeToken), fx.privateSession)).toEqual(refused);

    const identityToken = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    expect(await authorizerFor(fx.bobIdentity)(
      upgradeReq(fx.privateSession, 'drive', identityToken),
      fx.privateSession,
    )).toEqual(refused);

    const expiredToken = await issue(fx.aliceIdentity, fx.privateSession, 'drive', '1 second');
    await delay(1_100);
    expect(await alice(upgradeReq(fx.privateSession, 'drive', expiredToken), fx.privateSession)).toEqual(refused);
  });

  it('selects only the public protocol and keeps credentials out of audit logs', async () => {
    const lines: string[] = [];
    const logger: PtyAttachAuthzLogger = {
      warn: (message, meta) => lines.push(JSON.stringify({ message, meta })),
    };
    const token = await issue(fx.aliceIdentity, fx.privateSession, 'drive');
    const host = new PtyHostService({ logger: quiet });
    try {
      host.spawn({ sessionId: fx.privateSession, command: 'cat', cwd: CWD, env: {} });
      await delay(250);
      const server = createPtyWsServer({
        pty: host,
        authorize: authorizerFor(fx.aliceIdentity, logger),
      });
      const socket = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.privateSession, 'drive', token), socket, Buffer.alloc(0));
      expect(socket.written()).toContain('101 Switching Protocols');
      expect(socket.written()).toContain(`sec-websocket-protocol: ${PTY_PROTOCOL}`);
      expect(socket.written()).not.toContain(token);

      // Replay once to exercise the refusal audit record.
      const replay = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.privateSession, 'drive', token), replay, Buffer.alloc(0));
      expect(lines.join('\n')).not.toContain(token);
      expect(lines.join('\n')).not.toContain(hashPtyGrantToken(token));
    } finally {
      host.shutdownAll();
    }
  });

  it('view-only attach renders but suppresses binary input and resize', async () => {
    const token = await issue(fx.bobIdentity, fx.sharedSession, 'view');
    const host = new PtyHostService({ logger: quiet });
    const write = vi.spyOn(host, 'write');
    try {
      host.spawn({
        sessionId: fx.sharedSession,
        command: 'cat',
        cwd: CWD,
        env: {},
        cols: 80,
        rows: 24,
      });
      await delay(250);
      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.bobIdentity) });
      const socket = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.sharedSession, 'view', token), socket, Buffer.alloc(0));
      expect(socket.written()).toContain('101 Switching Protocols');

      socket.push(maskedClientFrame(0x2, Buffer.from('must-not-run\n')));
      socket.push(maskedClientFrame(
        0x1,
        Buffer.from(JSON.stringify({ type: 'resize', cols: 200, rows: 60 })),
      ));
      await delay(200);
      expect(write).not.toHaveBeenCalled();
      expect(host.getSize(fx.sharedSession)).toEqual({ cols: 80, rows: 24 });
    } finally {
      write.mockRestore();
      host.shutdownAll();
    }
  });

  it('refuses a missing capability before upgrade', async () => {
    const host = new PtyHostService({ logger: quiet });
    const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.aliceIdentity) });
    const socket = new FakeSocket();
    await server.handleUpgrade(upgradeReq(fx.privateSession, 'drive'), socket, Buffer.alloc(0));
    expect(socket.written()).toContain('401 Unauthorized');
    expect(socket.written()).not.toContain('101 Switching Protocols');
  });
});
