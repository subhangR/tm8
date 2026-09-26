/**
 * W3-client a3 — T8c END TO END under TM8_SPACE_SESSIONS=enforce, no logout.
 *
 * The BUILT server runs with the enforce flag set for THIS test only (the
 * default stays `agents`; flipping it is an owner step). The BUILT CLI binary
 * does everything a person would: log in, enter A, work in A, get refused in B
 * with the hint, enter B, work in B, go back to A. It never logs out, and the
 * gate credential stays the one it logged in with.
 *
 * The user and both spaces are made over HTTP: signup through the loopback
 * owner (not gated), and the spaces through the user's own gate session
 * (`spaces.create` is on the gate list), so the user is a member of both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;
let scratch = '';
let credPath = '';
let env: Record<string, string> = {};
const username = `w3c${randomUUID().slice(0, 8)}`;
const password = `pw-${randomUUID()}`;
let spaceA = '';
let spaceB = '';
let gate = '';

async function http(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(new URL(path, server.baseUrl), {
    method,
    headers: {
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, data: parsed?.data ?? parsed };
}

const pinKeys = (): string[] => Object.keys(stored()).filter((k) => k.includes('#space:'));

const stored = (): Record<string, { token: string }> =>
  (JSON.parse(readFileSync(credPath, 'utf8')) as { credentials: Record<string, { token: string }> }).credentials;

beforeAll(async () => {
  await assertBuilt();
  const previous = process.env.TM8_SPACE_SESSIONS;
  process.env.TM8_SPACE_SESSIONS = 'enforce';
  try {
    server = await startRealServer('w3c-enforce');
  } finally {
    if (previous === undefined) delete process.env.TM8_SPACE_SESSIONS;
    else process.env.TM8_SPACE_SESSIONS = previous;
  }
  scratch = mkdtempSync(join(tmpdir(), 'tm8-w3c-e2e-'));
  credPath = join(scratch, 'credentials.json');
  env = { TM8_CREDENTIALS_PATH: credPath, TM8_CREDENTIALS_MODE: 'file' };

  const signedUp = await http('POST', '/v2/auth/signup', null, { username, password });
  expect(signedUp.status, JSON.stringify(signedUp.data)).toBeLessThan(300);
}, 180_000);

afterAll(async () => {
  await server?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('a3: T8c under enforce through the built CLI, without logout', () => {
  it('logs in: the stored credential is a gate session', async () => {
    const r = await cli(['auth', 'login', username, '--password', password], server, env);
    expect(r.code, r.stderr).toBe(0);
    gate = stored()[server.baseUrl]!.token;
    expect(gate).toMatch(/^tm8s_/);
    // Two spaces, made from the gate (spaces.create is on the gate list).
    for (const name of ['W3C A', 'W3C B']) {
      const made = await http('POST', '/v2/spaces', gate, { name, clientMutationId: `w3c-${randomUUID()}` });
      expect(made.status, JSON.stringify(made.data)).toBeLessThan(300);
      if (name.endsWith('A')) spaceA = made.data.space.id;
      else spaceB = made.data.space.id;
    }
  });

  it('the gate still lists spaces (a gate command keeps the gate)', async () => {
    const r = await cli(['space', 'list', '--format', 'json'], server, env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(spaceA);
    expect(r.stdout).toContain(spaceB);
  });

  it('no pin for A: refused, and told to run auth space enter A', async () => {
    const r = await cli(['space', 'get', spaceA, '--space', spaceA], server, env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`tm8 auth space enter ${spaceA}`);
  });

  it('enter A stores the pin and never prints it; --space A then works', async () => {
    const entered = await cli(['auth', 'space', 'enter', spaceA], server, env);
    expect(entered.code, entered.stderr).toBe(0);
    expect(pinKeys()).toHaveLength(1);
    const pin = stored()[pinKeys()[0]!]!.token;
    expect(pin).not.toBe(gate);
    expect(entered.stdout + entered.stderr).not.toContain(pin);
    const r = await cli(['space', 'get', spaceA, '--space', spaceA, '--format', 'json'], server, env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(spaceA);
  });

  it('switch to B without logout: refused until entered, then B works and A still works', async () => {
    const before = await cli(['space', 'get', spaceB, '--space', spaceB], server, env);
    expect(before.code).not.toBe(0);
    expect(before.stderr).toContain(`tm8 auth space enter ${spaceB}`);

    const entered = await cli(['auth', 'space', 'enter', spaceB], server, env);
    expect(entered.code, entered.stderr).toBe(0);

    const inB = await cli(['space', 'get', spaceB, '--space', spaceB, '--format', 'json'], server, env);
    expect(inB.code, inB.stderr).toBe(0);
    expect(inB.stdout).toContain(spaceB);
    const backInA = await cli(['space', 'get', spaceA, '--space', spaceA, '--format', 'json'], server, env);
    expect(backInA.code, backInA.stderr).toBe(0);

    // A's pin is confined to A: asking for B through A's pin is refused.
    const crossed = await cli(['space', 'get', spaceB, '--space', spaceA], server, env);
    expect(crossed.code).not.toBe(0);

    // Never logged out: the gate is the same token login stored.
    expect(stored()[server.baseUrl]!.token).toBe(gate);
    expect(pinKeys()).toHaveLength(2);
  });

  it('the stored pins are real pinned sessions on the server', async () => {
    const pinnedTo: string[] = [];
    for (const key of pinKeys()) {
      const { token } = stored()[key]!;
      const session = await http('GET', '/v2/auth/session', token);
      expect(session.status).toBe(200);
      pinnedTo.push(session.data.session.spaceId);
    }
    expect(pinnedTo.sort()).toEqual([spaceA, spaceB].sort());
    // Positive twin: the gate itself is pinned to nothing.
    const gateSession = await http('GET', '/v2/auth/session', gate);
    expect(gateSession.status).toBe(200);
    expect(gateSession.data.session).not.toBeNull();
    expect(gateSession.data.session.spaceId ?? null).toBeNull();
  });
});
