/**
 * SOCKET-LEVEL attach authorization, against a REAL database.
 *
 * This is the acceptance test for the finding that `GET /v2/ws?sessionId=...`
 * enforced none of what `execution.streams.attach` decides. It deliberately
 * drives the REAL upgrade path (`createPtyWsServer.handleUpgrade`), the REAL
 * frame codec, a REAL PTY and the REAL `pg`-backed `Db` — the same
 * `createDb(...)` the composition root builds, so `translateDbError`'s
 * SQLSTATE mapping is exercised rather than stubbed.
 *
 * WHY A REAL DATABASE IS NOT OPTIONAL HERE. The policy lives in plpgsql and
 * RLS: `share_mode`, `internal.can_act_as` and `internal.current_member_id`.
 * An in-memory test double cannot answer any of them, so a green FakeDb run
 * would be evidence of nothing at all. Every migration is applied to a scratch
 * database and the verdicts come from the same `public.grant_stream_attach`
 * production calls.
 *
 * WHY TWO DISTINCT PRINCIPALS. A single-principal run proves only that a
 * caller can reach their own terminal, which was never in doubt. Alice creates
 * the sessions; BOB is the attacker, with his own identity, his own member row
 * and his own claims. Alice is also asserted as a POSITIVE CONTROL on every
 * negative: without her, a test that refuses everything — including a socket
 * that is simply broken — would look green.
 *
 * THE THREE CASES, and why the middle one is the interesting one:
 *
 *   share_mode='none',  Bob  -> no attach at all (403 before the 101)
 *   share_mode='space', Bob  -> attach GRANTED, drive REFUSED
 *   share_mode='space', Alice-> attach and drive both granted
 *
 * The middle case is the one the old code could not represent: view and drive
 * are different answers in `grant_stream_attach` (view turns on share_mode and
 * the creator, drive turns on `can_act_as` alone), and the verdict type had no
 * field to carry the difference. Bob's keystrokes are asserted NOT to reach
 * the PTY by spying on `PtyHostService.write` — the observable effect — rather
 * than by inspecting a computed flag.
 */
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '@tm8/execution';

import { createDb, type Db } from '../src/db/index.js';
import { createPtyAttachAuthorizer, createPtyWsServer } from '../src/pty/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './db/w1-pg.js';

// Applying ~80 migrations to a fresh database and spawning real PTYs is well
// past vitest's 5s/10s defaults, and the file-level hook abort is unnamed and
// therefore very hard to diagnose. Precedent: test/db/agent-auth-session.pg.test.ts.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CWD = process.cwd();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** A Duplex that captures everything the server writes to the socket. */
class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  setNoDelay(): this {
    return this;
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  written(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function upgradeReq(sessionId: string): IncomingMessage {
  return {
    url: `/v2/ws?sessionId=${sessionId}&offset=0`,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  } as unknown as IncomingMessage;
}

/** Client→server frames MUST be masked (RFC 6455 §5.1) or the decoder drops them. */
function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  if (payload.length > 125) throw new Error('test frames stay short on purpose');
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Fixture {
  aliceIdentity: string;
  bobIdentity: string;
  spaceId: string;
  aliceMember: string;
  bobMember: string;
  /** Alice's session, share_mode='none' — the one Bob must not reach at all. */
  privateSession: string;
  /** Alice's session, share_mode='space' — Bob may watch, must not type. */
  sharedSession: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fx: Fixture;

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      aliceIdentity: 'pr0-alice',
      bobIdentity: 'pr0-bob',
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
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'PR0', $2)`,
      [ids.spaceId, ids.aliceIdentity],
    );
    // BOTH are real members of the SAME space. That is the point: this is not
    // an outsider being kept out, it is one colleague being kept out of
    // another colleague's terminal. Prod is a six-member space.
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
    // created_by is Alice's MEMBER row, not a team_member. That matters: 075's
    // can_act_as grants drive over any team_member in the space to every
    // member of it (finding D2), so a team_member-authored session would be
    // drivable by Bob BY DESIGN and would prove nothing about the drive gate.
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $3, 'work_session', $4), ($2, $3, 'work_session', $4)`,
      [ids.privateSession, ids.sharedSession, ids.spaceId, ids.aliceMember],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1, 'alice private', 'running', 'none'),
              ($2, 'alice shared',  'running', 'space')`,
      [ids.privateSession, ids.sharedSession],
    );
    return ids;
  });
}

/** The production authorizer, bound to one principal's claims. */
function authorizerFor(identityId: string) {
  return createPtyAttachAuthorizer({
    db,
    resolveIdentityId: async () => identityId,
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('pr0-attach-authz');
  database.apply(migrationFiles());
  db = createDb(database.url);
  fx = await seed();
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('PTY socket attach authorization, real DB, two principals', () => {
  it('confirms the fixture is genuinely two principals over one shared space', async () => {
    // If this ever collapses to one identity the rest of the file proves
    // nothing, so it is asserted rather than assumed.
    expect(fx.aliceIdentity).not.toBe(fx.bobIdentity);
    expect(fx.aliceMember).not.toBe(fx.bobMember);
    const rows = await db.query(
      { identityId: fx.bobIdentity },
      'select 1 from public.entities where id = $1 and deleted_at is null',
      [fx.privateSession],
    );
    // Bob CAN see the entity. That is exactly why a visibility check alone was
    // never authorization — it is the check the old code stopped at.
    expect(rows).toHaveLength(1);
  });

  it("BOB CANNOT ATTACH to Alice's share_mode='none' session — refused before the 101", async () => {
    const host = new PtyHostService({ logger: quiet });
    try {
      host.spawn({ sessionId: fx.privateSession, command: 'sleep 5', cwd: CWD, env: {} });
      await delay(300);

      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.bobIdentity) });
      const sock = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.privateSession), sock, Buffer.alloc(0));

      const raw = sock.written();
      expect(raw).not.toContain('101 Switching Protocols');
      expect(raw).toContain('403 Forbidden');
      expect(raw).toContain('this session is not shared');
      // No socket exists, so nothing was subscribed to the live stream either.
      expect(server.connectionCount()).toBe(0);
    } finally {
      host.shutdownAll();
    }
  });

  it('POSITIVE CONTROL: Alice attaches to her OWN private session and drives it', async () => {
    // Without this, the test above would pass against a socket that refuses
    // everyone, including one that is simply broken.
    const host = new PtyHostService({ logger: quiet });
    const write = vi.spyOn(host, 'write');
    try {
      host.spawn({ sessionId: fx.privateSession, command: 'cat', cwd: CWD, env: {} });
      await delay(300);

      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.aliceIdentity) });
      const sock = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.privateSession), sock, Buffer.alloc(0));

      expect(sock.written()).toContain('101 Switching Protocols');
      sock.push(maskedClientFrame(0x2, Buffer.from('alice-keystroke\n', 'utf8')));
      await delay(200);

      expect(write).toHaveBeenCalled();
      expect(write.mock.calls.some(([, data]) => String(data).includes('alice-keystroke'))).toBe(
        true,
      );
    } finally {
      write.mockRestore();
      host.shutdownAll();
    }
  });

  it("BOB CANNOT DRIVE Alice's share_mode='space' session, even though he MAY view it", async () => {
    // The half a socket-blind test misses. Bob gets a real 101 here — view is
    // legitimately granted — so the only thing standing between him and
    // somebody else's shell is the drive gate on the input path.
    const host = new PtyHostService({ logger: quiet });
    const write = vi.spyOn(host, 'write');
    try {
      host.spawn({ sessionId: fx.sharedSession, command: 'cat', cwd: CWD, env: {}, cols: 80, rows: 24 });
      await delay(300);

      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.bobIdentity) });
      const sock = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.sharedSession), sock, Buffer.alloc(0));

      // ATTACH SUCCEEDED — Bob is watching. This is not a refusal test.
      expect(sock.written()).toContain('101 Switching Protocols');
      expect(server.connectionCount()).toBe(1);

      sock.push(maskedClientFrame(0x2, Buffer.from('bob-keystroke\n', 'utf8')));
      sock.push(
        maskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }))),
      );
      await delay(300);

      // THE ASSERTION THAT MATTERS: the bytes never reached the PTY. Not "a
      // flag was false" — `pty.write` was never called at all.
      expect(write).not.toHaveBeenCalled();
      // And a resize is a PTY mutation (TIOCSWINSZ + SIGWINCH), so a viewer
      // must not be able to reflow the driver's live terminal either.
      expect(host.getSize(fx.sharedSession)).toEqual({ cols: 80, rows: 24 });
    } finally {
      write.mockRestore();
      host.shutdownAll();
    }
  });

  it('POSITIVE CONTROL: Alice drives the SAME shared session Bob could only watch', async () => {
    // Same session, same server construction, different principal — so the
    // refusal above is attributable to WHO Bob is and nothing else.
    const host = new PtyHostService({ logger: quiet });
    const write = vi.spyOn(host, 'write');
    try {
      host.spawn({ sessionId: fx.sharedSession, command: 'cat', cwd: CWD, env: {}, cols: 80, rows: 24 });
      await delay(300);

      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.aliceIdentity) });
      const sock = new FakeSocket();
      await server.handleUpgrade(upgradeReq(fx.sharedSession), sock, Buffer.alloc(0));
      expect(sock.written()).toContain('101 Switching Protocols');

      sock.push(maskedClientFrame(0x2, Buffer.from('alice-drives\n', 'utf8')));
      sock.push(
        maskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }))),
      );
      await delay(300);

      expect(write.mock.calls.some(([, data]) => String(data).includes('alice-drives'))).toBe(true);
      expect(host.getSize(fx.sharedSession)).toEqual({ cols: 200, rows: 60 });
    } finally {
      write.mockRestore();
      host.shutdownAll();
    }
  });

  it('an unauthenticated caller is 401 and an unknown id is 404, unchanged', async () => {
    // The refusal vocabulary is load-bearing: it is the discriminator the
    // original finding was measured with, so this fix must not widen it.
    const host = new PtyHostService({ logger: quiet });
    try {
      const anon = createPtyWsServer({
        pty: host,
        authorize: createPtyAttachAuthorizer({ db, resolveIdentityId: async () => undefined }),
      });
      const a = new FakeSocket();
      await anon.handleUpgrade(upgradeReq(fx.privateSession), a, Buffer.alloc(0));
      expect(a.written()).toContain('401 Unauthorized');

      const server = createPtyWsServer({ pty: host, authorize: authorizerFor(fx.bobIdentity) });
      const b = new FakeSocket();
      await server.handleUpgrade(upgradeReq(randomUUID()), b, Buffer.alloc(0));
      // Nonexistent and not-visible share one 404 so ids cannot be enumerated.
      expect(b.written()).toContain('404 Not Found');
      expect(b.written()).toContain('no such session');
    } finally {
      host.shutdownAll();
    }
  });
});
