#!/usr/bin/env node
// tm8 credential paste harness — the login command for API-key providers.
//
// Every other provider's login terminal runs a VENDOR binary. Kimi and Groq
// have none to run (see `src/credentials/api-key-credentials.ts` for the
// measurement), so tm8 supplies the program itself and this file is it. It runs
// in exactly the same PTY, under the same per-identity HOME, reached by the same
// Connect button, and finishes into the same probe. From the session machinery's
// point of view nothing is special about it.
//
// WHY ECHO IS TURNED OFF, AND WHY THAT IS THE WHOLE CONTAINMENT.
//
// A PTY session keeps a 1 MiB offset-tracked ring of its OUTPUT
// (`OutputBuffer.ts`, `DEFAULT_CAP_BYTES`), and that ring is replayed to any
// client that reattaches to the session id. Client keystrokes do not enter it:
// `PtyHostService.write` hands them to `proc.write` and touches no buffer. So
// there is exactly ONE path by which a pasted key could reach the replay ring
// and be shown to a later viewer — the tty line discipline echoing the typed
// bytes back as output. Disabling ECHO closes that path, and closing it is not
// a nicety layered on top of some other protection; it IS the protection. This
// program therefore refuses to prompt at all if it cannot turn echo off, rather
// than falling back to a visible prompt that would look like it worked.
//
// WHY THE KEY IS VERIFIED BEFORE IT IS STORED.
//
// tm8's credential doctrine distinguishes `active` from `stale`, where `stale`
// means "cannot confirm" and is never persisted as success. A paste flow that
// merely wrote the file would make every typo an `active` credential until the
// member's next agent run failed somewhere far away with an unhelpful 401. One
// authenticated round trip here converts that into an immediate, local, correct
// answer, so a stored key is always a key that worked at least once.
//
// EVERY ARGUMENT IS SERVER-DERIVED. The launcher composes this argv from
// `api-key-credentials.ts`; no client input reaches it. That is the same
// closed-over-the-command property the other providers have, and it is why the
// vendor URLs are passed in rather than duplicated here — one authority for the
// vendor facts, in TypeScript, where the rest of the system reads them.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`flag ${token} needs a value`);
    }
    out.set(token.slice(2), value);
    i += 1;
  }
  return out;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`missing required --${name}`);
  return value;
}

function fail(message) {
  process.stderr.write(`tm8: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// terminal echo
// ---------------------------------------------------------------------------

// `stty` rather than a native termios binding: this harness must run from a
// plain `node` with no build step and no optional dependency, and it is always
// launched inside a PTY where `stty` has a controlling terminal to act on.
function setEcho(on) {
  execFileSync('stty', [on ? 'echo' : '-echo'], { stdio: ['inherit', 'inherit', 'ignore'] });
}

/**
 * Read one line with echo disabled.
 *
 * Resolves with the raw line. The caller is responsible for restoring echo; it
 * is restored in a `finally` at the top level so that an exception on any path
 * — including a failed verification — cannot leave the member's terminal
 * silently swallowing their keystrokes.
 */
function readSecretLine() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (typeof stdin.setRawMode === 'function' && stdin.isTTY) {
      // Raw mode so Ctrl-C reaches us as a byte we can handle deliberately
      // rather than as a signal that would skip the echo-restoring `finally`.
      stdin.setRawMode(true);
    }
    stdin.resume();

    const done = (err, value) => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (typeof stdin.setRawMode === 'function' && stdin.isTTY) stdin.setRawMode(false);
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl-C. Not an error condition — the member changed their mind.
          // Handled as a BYTE rather than as SIGINT because raw mode is on and
          // a signal would bypass the `finally` that restores echo.
          done(null, null);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          done(null, buffer);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Everything else accumulates. Nothing is written back to the terminal;
        // not even a masking asterisk, because the length of a key is itself
        // information and the ring that would carry it is replayed to
        // reattaching clients.
        buffer += ch;
      }
    };

    stdin.on('data', onData);
    stdin.once('error', (err) => done(err));
  });
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/**
 * Ask the vendor whether this key is real.
 *
 * Returns one of `ok`, `rejected`, `unreachable` — deliberately the same three
 * outcomes the server-side probe reports, so that a key which passes here
 * cannot be classified differently there for a reason this program never saw.
 */
async function verifyKey(verifyUrl, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(verifyUrl, {
      method: 'GET',
      headers: {
        // Both vendors authenticate a bearer token on their OpenAI-compatible
        // model list. This request lists models; it runs no inference and costs
        // the member nothing.
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (response.ok) return { outcome: 'ok' };
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'rejected', detail: `HTTP ${response.status}` };
    }
    // A 429 or a 5xx says nothing about the key. Reporting it as a rejection
    // would tell the member their key is wrong when it may well be fine.
    return { outcome: 'unreachable', detail: `HTTP ${response.status}` };
  } catch (err) {
    const detail = controller.signal.aborted
      ? `no response in ${VERIFY_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return { outcome: 'unreachable', detail };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const provider = required(args, 'provider');
const display = required(args, 'display');
const consoleUrl = required(args, 'console-url');
const verifyUrl = required(args, 'verify-url');
const keyPrefix = required(args, 'key-prefix');
const filename = required(args, 'filename');

const home = process.env.HOME;
if (!home) fail('HOME is not set; refusing to guess where the credential belongs');

const out = process.stdout;
const write = (line) => out.write(`${line}\n`);

write('');
write(`  Connect ${display}`);
write('  ' + '─'.repeat(`Connect ${display}`.length));
write('');
write(`  ${display} issues a long-lived API key from its web console rather than`);
write('  a device login, so tm8 asks you to paste one here.');
write('');
write(`  Get a key:  ${consoleUrl}`);
write('');
write('  Your key is NOT shown as you type or paste, and is not kept in this');
write("  terminal's scrollback. tm8 checks it against the vendor before storing");
write('  it, so a mistyped key is rejected here rather than failing later.');
write('');

let echoDisabled = false;
let exitCode = 1;
let settled = false;

try {
  try {
    setEcho(false);
    echoDisabled = true;
  } catch (err) {
    // See the header: without echo off there is no containment, so there is no
    // acceptable degraded mode. Say why, plainly, and stop.
    write('');
    write('  Cannot switch this terminal to hidden input, so tm8 will not ask');
    write('  for a key here — it would be visible to anyone who reopens this');
    write('  session. Nothing has been stored.');
    write(`  (${err instanceof Error ? err.message : String(err)})`);
    process.exit(3);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    out.write(`  Paste your ${display} API key and press Enter: `);
    // eslint-disable-next-line no-await-in-loop
    const entered = await readSecretLine();
    write('');

    if (entered === null) {
      write('  Cancelled. Nothing has been stored.');
      exitCode = 130;
      settled = true;
      break;
    }

    const key = entered.trim();

    if (key.length === 0) {
      write('  Nothing entered.');
      write('');
      continue;
    }

    if (!key.startsWith(keyPrefix)) {
      // Advisory only — see `keyPrefix` in api-key-credentials.ts. The vendor's
      // answer below is the real verdict, so this warns and continues rather
      // than refusing a key that may simply predate a prefix change.
      write(`  Note: ${display} keys usually begin with "${keyPrefix}". Checking anyway.`);
    }

    write(`  Checking the key with ${display}…`);
    // eslint-disable-next-line no-await-in-loop
    const result = await verifyKey(verifyUrl, key);

    if (result.outcome === 'ok') {
      const dir = join(home, provider);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, filename);
      // `mode` on writeFileSync applies only when the file is CREATED, so an
      // overwrite of an existing key would silently keep the old file's mode.
      // The explicit chmod makes 0600 true on both paths.
      writeFileSync(target, `${key}\n`, { mode: 0o600 });
      chmodSync(target, 0o600);
      write('');
      write(`  ✓ Connected. ${display} accepted the key and tm8 has stored it.`);
      write('');
      write('  You can close this terminal.');
      exitCode = 0;
      settled = true;
      break;
    }

    if (result.outcome === 'rejected') {
      write(`  ✗ ${display} rejected that key (${result.detail}).`);
      if (attempt < MAX_ATTEMPTS) {
        write('    Check you copied the whole key, then try again.');
        write('');
        continue;
      }
      write('    Nothing has been stored.');
      exitCode = 1;
      settled = true;
      break;
    }

    // Unreachable. Do not consume an attempt's worth of blame on the member:
    // this is tm8's or the network's problem, and retrying a key we could not
    // check is unlikely to answer differently in the next few seconds.
    write(`  ? Could not reach ${display} to check the key (${result.detail}).`);
    write('    Nothing has been stored — tm8 does not save a key it could not');
    write('    verify. Try Connect again in a moment.');
    exitCode = 4;
    settled = true;
    break;
  }

  if (!settled) {
    // Fell out of the loop by exhausting every attempt on empty input.
    write('  No key entered. Nothing has been stored.');
  }
} finally {
  if (echoDisabled) {
    try {
      setEcho(true);
    } catch {
      // Restoring echo is best-effort: the PTY is about to be torn down, and
      // throwing here would replace a real outcome with a cleanup error.
    }
  }
}

process.exit(exitCode);
