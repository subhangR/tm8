// Prompt-delivery FIDELITY — does `deliverPrompt` hand the PTY exactly the bytes
// it was given?
//
// WHY THIS EXISTS. A long prompt injected into Claude's TUI *looked* corrupted
// when read back ("actually" → "atualy", collapsed spaces), and that was
// reported as silent data corruption in the channel prompts and future
// coordinator→worker directives ride on. It was NOT: the raw PTY bytes were
// intact, the agent acted on the correct text, and the message it posted to the
// graph was byte-perfect. The apparent damage came from flattening a TUI's
// REDRAW stream with a regex — a TUI expresses layout as cursor movement, so
// concatenating intermediate render states loses whatever was never emitted as a
// character. Rendering the same bytes through a real emulator shows them intact.
//
// So these tests pin the property that actually matters and is cheap to assert:
// what goes in comes out, byte for byte, with no terminal emulator in the loop.
// The echo-agent is the oracle — its `TM8-ECHO: ` prefix cannot appear unless
// the agent genuinely read that line from its own stdin.
//
// If someone later "fixes" delivery by chunking, pacing, or adding bracketed
// paste, these tests say whether the bytes still arrive whole.

import { describe, expect, it, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';

import { PtyHostService } from '../src/pty/PtyHostService.js';

const ECHO_AGENT = fileURLToPath(new URL('../harness/echo-agent.mjs', import.meta.url));
// THE INTERPRETER RUNNING THIS SUITE, not whatever `node` a bare PATH lookup
// finds — because there is no PATH to look in. `spawn` is given `env: {}` (the
// caller supplies the COMPLETE child environment; PtyHostService never merges
// `process.env`), so the shell falls back to its compiled-in default PATH:
// `/bin:/usr/bin:/usr/ucb:/usr/local/bin`. A node installed anywhere else —
// nvm, `~/.local/bin`, Homebrew on Apple Silicon (`/opt/homebrew/bin`) — is
// simply not on it, the echo agent never starts, and all five tests below fail
// as `timeout waiting for condition` with nothing naming the cause.
const NODE = JSON.stringify(process.execPath);
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await wait(20);
  }
}

describe('prompt delivery fidelity', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  /** Deliver `payload` and return the line the agent echoed back. */
  async function roundTrip(payload: string): Promise<string> {
    host = new PtyHostService({ logger: quiet });
    const chunks: Buffer[] = [];
    const sessionId = 'fidelity';
    host.spawn({
      sessionId,
      command: `${NODE} ${JSON.stringify(ECHO_AGENT)}`,
      cwd: '/tmp',
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));
    const seen = () => Buffer.concat(chunks).toString('utf8');

    await waitFor(() => seen().includes('TM8-ECHO-READY'));
    await host.deliverPrompt(sessionId, payload, 'send');
    await waitFor(() => seen().includes('TM8-ECHO: '));
    // Let any trailing bytes of a long line arrive before asserting.
    await wait(150);

    const line = seen()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('TM8-ECHO: '));
    return line ? line.slice('TM8-ECHO: '.length) : '(no echo line)';
  }

  it('delivers a plain sentence byte-for-byte, spaces included', async () => {
    // Collapsed spaces were the headline symptom of the phantom bug.
    const payload = 'actually RUN the tm8 command to report progress on that task';
    expect(await roundTrip(payload)).toBe(payload);
  }, 20000);

  it('delivers a long prompt without truncation', async () => {
    // Long prompts are where a single unpaced write would first overflow a tty
    // input buffer if that were the failure mode.
    const payload = `${'abcdefghij'.repeat(40)} END-${'x'.repeat(120)}`;
    expect(await roundTrip(payload)).toBe(payload);
  }, 20000);

  it('preserves punctuation and shell metacharacters', async () => {
    // These reach the PTY as data, never as shell input — a regression that
    // started interpreting them would corrupt file paths and flags.
    const payload = `it's "quoted" & <tagged> | piped; colon: $VAR \`tick\` \\slash`;
    expect(await roundTrip(payload)).toBe(payload);
  }, 20000);

  it('preserves multi-byte UTF-8 across the write boundary', async () => {
    const payload = 'héllo → wörld ✓ 日本語 🚀 done';
    expect(await roundTrip(payload)).toBe(payload);
  }, 20000);

  it('preserves repeated tokens, where a dropped word hides easily', async () => {
    const payload = 'the the the and and and to to to of of of id id id';
    expect(await roundTrip(payload)).toBe(payload);
  }, 20000);
});
