/**
 * THE PASTE HARNESS, DRIVEN THROUGH A REAL PTY.
 *
 * This is the only login "command" in tm8 that tm8 itself wrote, and the only
 * one that handles a secret in the terminal rather than sending the member to a
 * browser. Both facts make it the wrong program to test with a mocked stdin:
 * the containment it claims is a property of the TTY LINE DISCIPLINE, so a test
 * that fakes the terminal tests everything except the thing that matters.
 *
 * So these run the real `.mjs`, under a real PTY, through `PtyHostService` —
 * the same class the server spawns login terminals with — and read the SAME
 * bytes a subscribed client is served, which are the same bytes the replay ring
 * holds for one that reattaches later. If a pasted key can reach a viewer, it
 * reaches these assertions first.
 *
 * The vendor is a local HTTP server rather than the real one: every URL the
 * harness talks to arrives on argv (see `apiKeyLoginCommand`), which is what
 * makes verification testable without a key, a network or a bill.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { credentialPastePath } from '../src/credentials/CredentialSessionLauncher.js';

const GOOD_KEY = 'sk-test-good-key-0123456789';
/**
 * Ctrl-C as a BYTE, which is how the harness receives it in raw mode — and why
 * it handles it as one: a signal would skip the `finally` that gives the member
 * their echo back. Built rather than written literally so the byte cannot be
 * mangled by anything that reformats this file.
 */
const CTRL_C = String.fromCharCode(3);

let vendor: Server;
let vendorUrl: string;
let asked: string[] = [];
let host: PtyHostService;
let home: string;
let unsubscribes: Array<() => void> = [];

beforeEach(async () => {
  asked = [];
  vendor = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    asked.push(auth);
    if (auth === `Bearer ${GOOD_KEY}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"invalid_authentication_error"}}');
  });
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
  vendorUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1/models`;

  host = new PtyHostService({ defaultShell: '/bin/sh' });
  home = mkdtempSync(join(tmpdir(), 'tm8-paste-harness-'));
  unsubscribes = [];
});

afterEach(async () => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  host.shutdownAll();
  await new Promise<void>((resolve) => vendor.close(() => resolve()));
});

function start(sessionId: string, over: { verifyUrl?: string } = {}) {
  const command = [
    // `process.execPath` rather than the bare `node` the launcher composes:
    // this suite is not testing PATH resolution, and the node running vitest is
    // the node whose `fetch` and `stty` behaviour the harness depends on.
    process.execPath,
    credentialPastePath(),
    '--provider',
    'kimi',
    '--display',
    "'Kimi (Moonshot AI)'",
    '--console-url',
    'https://platform.moonshot.ai/console/api-keys',
    '--verify-url',
    over.verifyUrl ?? vendorUrl,
    '--key-prefix',
    'sk-',
    '--filename',
    'api-key',
  ].join(' ');
  host.spawn({
    sessionId,
    command,
    cwd: home,
    // The shape `composeCredentialEnv` produces: a per-identity HOME and little
    // else. The harness writes beneath HOME, so this is also what keeps the
    // test out of any real credential directory.
    env: { HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin', TERM: 'xterm-256color' },
  });

  // WHAT IS CAPTURED, AND WHY IT IS NOT `getReplay`.
  //
  // `getReplay` reads the live session map, and `onExit` DELETES the entry
  // (`PtyHostService.ts:632`). Two of the paths below — a stored key, and
  // Ctrl-C — finish by exiting the harness ON PURPOSE, so polling the ring
  // races the process's own exit and reads `''` from a session that has already
  // been reaped. Measured: both tests failed that way, and only those two.
  //
  // The live fan-out is fed from the same `proc.onData` that appends to the
  // ring, so accumulating frames here captures exactly the bytes the ring
  // holds — and keeps them after the entry is gone. It also captures the
  // terminal `{type:'exit'}` frame, which is deliberate: the leak assertion
  // should cover everything a client is sent, not only the pty bytes.
  let seen = '';
  const unsubscribe = host.onFrames(sessionId, (frame) => {
    seen += frame.toString('utf8');
  });
  if (!unsubscribe) throw new Error(`no live PTY for ${sessionId}`);
  unsubscribes.push(unsubscribe);
  return () => seen;
}

const keyFile = () => join(home, 'kimi', 'api-key');

describe('the credential paste harness', () => {
  it('verifies the key, stores it 0600, and never echoes it into the replay ring', async () => {
    const output = start('paste-ok');
    await expect.poll(output, { timeout: 15000 }).toContain('Paste your');

    host.write('paste-ok', `${GOOD_KEY}\r`);
    await expect.poll(output, { timeout: 15000 }).toContain('Connected');

    // It asked the vendor, with a bearer header, before writing anything.
    expect(asked).toEqual([`Bearer ${GOOD_KEY}`]);

    expect(existsSync(keyFile())).toBe(true);
    expect(readFileSync(keyFile(), 'utf8')).toBe(`${GOOD_KEY}\n`);
    // 0600 asserted on the file itself, not on the write call: `writeFileSync`'s
    // `mode` applies only on CREATE, so an overwrite of an existing key would
    // otherwise silently keep whatever mode was there before.
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. These are the bytes a client
    // subscribed to this session id receives, and the ring replays the same
    // ones to a client that reattaches later. The key must not be in them —
    // not in full, and not in a prefix long enough to matter.
    expect(output()).not.toContain(GOOD_KEY);
    expect(output()).not.toContain(GOOD_KEY.slice(0, 12));
  }, 30000);

  it('stores nothing when the vendor rejects the key', async () => {
    const output = start('paste-rejected');
    await expect.poll(output, { timeout: 15000 }).toContain('Paste your');

    host.write('paste-rejected', 'sk-wrong-key\r');
    await expect.poll(output, { timeout: 15000 }).toContain('rejected that key');

    expect(existsSync(keyFile())).toBe(false);
    // Still prompting: a rejection inside the attempt budget is a retry rather
    // than an exit, because the overwhelmingly likely cause is a half-copied key.
    expect(output()).toContain('try again');
    expect(output()).not.toContain('sk-wrong-key');
  }, 30000);

  /* "CANNOT CONFIRM" IS NOT "WRONG", and the harness must not persist on it. A
     key that fails to reach the vendor is very often a perfectly good key — the
     same distinction the probe draws between `stale` and a 401. */
  it('stores nothing, and blames nobody, when the vendor cannot be reached', async () => {
    // Port 1 refuses immediately. Closing the real vendor first would race the
    // harness's startup, and an unroutable address would make this a test of
    // the network's timeout rather than of the harness's branch.
    const output = start('paste-unreachable', { verifyUrl: 'http://127.0.0.1:1/v1/models' });
    await expect.poll(output, { timeout: 15000 }).toContain('Paste your');

    host.write('paste-unreachable', `${GOOD_KEY}\r`);
    await expect.poll(output, { timeout: 20000 }).toContain('Could not reach');

    expect(existsSync(keyFile())).toBe(false);
    expect(output()).toContain('does not save a key it could not');
    expect(output()).not.toContain(GOOD_KEY);
  }, 40000);

  it('cancels cleanly on Ctrl-C without storing anything', async () => {
    const output = start('paste-cancel');
    await expect.poll(output, { timeout: 15000 }).toContain('Paste your');

    host.write('paste-cancel', CTRL_C);
    await expect.poll(output, { timeout: 15000 }).toContain('Cancelled');

    expect(existsSync(keyFile())).toBe(false);
    expect(asked).toEqual([]);
  }, 30000);

  /* An advisory prefix check must not become authentication. The vendors can
     change a prefix; the 401 is the real answer. */
  it('warns about an unexpected prefix and verifies the key anyway', async () => {
    const output = start('paste-prefix');
    await expect.poll(output, { timeout: 15000 }).toContain('Paste your');

    host.write('paste-prefix', 'gsk_not_the_expected_prefix\r');
    await expect.poll(output, { timeout: 15000 }).toContain('usually begin with');

    // It went on to ask the vendor rather than refusing locally.
    await expect.poll(() => asked.length, { timeout: 15000 }).toBe(1);
    expect(asked[0]).toBe('Bearer gsk_not_the_expected_prefix');
  }, 30000);
});
