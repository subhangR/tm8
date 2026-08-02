/**
 * The per-server credential store (doc 13 §4.1) — file backend and the rules
 * that bind every caller. The keychain backend is deliberately untested here:
 * it shells out to macOS `security(1)` against the developer's real login
 * keychain, which a test suite must never touch. Its selection logic IS
 * tested; its IO is proven by the manual smoke in the task record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  credentialOrigin,
  credentialsPath,
  credentialStoreFor,
  isAgentContext,
  tokenSessionId,
} from '../src/credentials.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function scratchPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-cred-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'credentials.json');
}

/** An env with NO ambient tm8 variables, so the host machine cannot leak in. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('credentialOrigin — one canonical spelling per server', () => {
  it('lower-cases the host, strips paths, trailing slashes and default ports', () => {
    expect(credentialOrigin('http://LOCALHOST:4610/some/path/')).toBe('http://localhost:4610');
    expect(credentialOrigin('https://tm8-server.tail28ac62.ts.net:443/')).toBe(
      'https://tm8-server.tail28ac62.ts.net',
    );
    expect(credentialOrigin('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888');
  });

  it('refuses a non-URL rather than inventing a key', () => {
    expect(() => credentialOrigin('not a url')).toThrow();
  });
});

describe('tokenSessionId — the routing hint embedded in a tm8s_ pass', () => {
  it('extracts the session id between the prefix and the first dot', () => {
    expect(tokenSessionId('tm8s_sess-123.secretbytes')).toBe('sess-123');
  });
  it('is undefined for anything that is not a well-formed tm8s_ token', () => {
    expect(tokenSessionId('bearer-something')).toBeUndefined();
    expect(tokenSessionId('tm8s_.secret')).toBeUndefined();
    expect(tokenSessionId('tm8s_nodot')).toBeUndefined();
  });
});

describe('the agent-context guard (doc 13 §4.3)', () => {
  it('any spawn marker disables the store entirely', () => {
    expect(credentialStoreFor(env({ TM8_AGENT_TOKEN: 'tok' }))).toBeUndefined();
    expect(credentialStoreFor(env({ TM8_SESSION_ID: 'ws_1' }))).toBeUndefined();
    expect(credentialStoreFor(env({ TM8_TEAM_MEMBER_ID: 'tm_1' }))).toBeUndefined();
  });

  it('blank markers are absent markers', () => {
    expect(isAgentContext(env({ TM8_AGENT_TOKEN: '  ', TM8_SESSION_ID: '' }))).toBe(false);
  });

  it('TM8_CREDENTIALS_MODE=off disables the store for humans too', () => {
    expect(credentialStoreFor(env({ TM8_CREDENTIALS_MODE: 'off' }))).toBeUndefined();
  });

  it('TM8_CREDENTIALS_PATH forces the file backend', () => {
    const store = credentialStoreFor(env({ TM8_CREDENTIALS_PATH: scratchPath() }));
    expect(store?.kind).toBe('file');
  });

  it('TM8_CREDENTIALS_MODE picks a backend explicitly', () => {
    expect(credentialStoreFor(env({ TM8_CREDENTIALS_MODE: 'file' }))?.kind).toBe('file');
    expect(credentialStoreFor(env({ TM8_CREDENTIALS_MODE: 'keychain' }))?.kind).toBe('keychain');
  });
});

describe('credentialsPath', () => {
  it('honours TM8_CREDENTIALS_PATH, then XDG_CONFIG_HOME', () => {
    expect(credentialsPath(env({ TM8_CREDENTIALS_PATH: '/x/creds.json' }))).toBe('/x/creds.json');
    expect(credentialsPath(env({ XDG_CONFIG_HOME: '/xdg' }))).toBe('/xdg/tm8/credentials.json');
  });
});

describe('the file backend — a 0600 file written atomically', () => {
  const ORIGIN_A = 'http://127.0.0.1:8888';
  const ORIGIN_B = 'https://tm8-server.tail28ac62.ts.net';

  function store(path: string) {
    const s = credentialStoreFor(env({ TM8_CREDENTIALS_PATH: path }));
    if (!s) throw new Error('expected a file store');
    return s;
  }

  it('round-trips a token per origin and keeps entries independent', () => {
    const path = scratchPath();
    const s = store(path);
    s.set(ORIGIN_A, 'tm8s_a.secret-a', { username: 'alice', expiresAt: '2026-11-01T00:00:00Z' });
    s.set(ORIGIN_B, 'tm8s_b.secret-b');
    expect(s.get(ORIGIN_A)).toBe('tm8s_a.secret-a');
    expect(s.get(ORIGIN_B)).toBe('tm8s_b.secret-b');
    expect(s.delete(ORIGIN_A)).toBe(true);
    expect(s.get(ORIGIN_A)).toBeUndefined();
    expect(s.get(ORIGIN_B)).toBe('tm8s_b.secret-b');
  });

  it('creates the file 0600 in a 0700 directory, and stores metadata for inspection', () => {
    const path = scratchPath();
    store(path).set(ORIGIN_A, 'tm8s_a.s', { username: 'alice' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    const shape = JSON.parse(readFileSync(path, 'utf8')) as {
      credentials: Record<string, { token: string; username?: string }>;
    };
    expect(shape.credentials[ORIGIN_A]).toMatchObject({ token: 'tm8s_a.s', username: 'alice' });
  });

  it('removes the file entirely when the last entry is deleted', () => {
    const path = scratchPath();
    const s = store(path);
    s.set(ORIGIN_A, 'tm8s_a.s');
    expect(s.delete(ORIGIN_A)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('delete of an absent entry is false, not an error', () => {
    expect(store(scratchPath()).delete(ORIGIN_A)).toBe(false);
  });

  it('a corrupt file reads as an empty store and is repaired by the next write', () => {
    const path = scratchPath();
    const s = store(path);
    s.set(ORIGIN_A, 'tm8s_a.s');
    writeFileSync(path, 'not json{{{');
    expect(s.get(ORIGIN_A)).toBeUndefined();
    s.set(ORIGIN_B, 'tm8s_b.s');
    expect(s.get(ORIGIN_B)).toBe('tm8s_b.s');
  });
});
