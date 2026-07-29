// MANUAL live-agent verification for the closed-loop prompt-injection fix
// (ported from maestro 6adab1b). NOT part of the standard suite: it spawns a
// REAL agent CLI (codex / claude), burns real API tokens, and takes 30-100s
// per case. Run explicitly:
//
//   npx vitest run test/live-agent-prompt-submit.manual.test.ts --testTimeout=180000
//
// It asserts the property unit tests structurally cannot: that a prompt
// written into a COLD (just-spawned) or WARM (actively streaming) agent PTY
// both LANDS and SUBMITS — the agent must echo back a unique marker it could
// only produce by actually processing the message, not merely by having the
// text sit unread in its composer.

import { describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';

const logger = {
  info: () => {},
  warn: (...a: unknown[]) => console.warn('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
  debug: () => {},
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout after ${String(ms)}ms waiting for condition`);
    await wait(100);
  }
}

function marker(tag: string): string {
  return `PTYVERIFY_${tag}_${Math.random().toString(36).slice(2, 10)}`;
}

describe('LIVE agent prompt-injection verification (manual only)', () => {
  it('codex: cold-spawn message lands and submits', async () => {
    const host = new PtyHostService({ logger });
    const chunks: Buffer[] = [];
    const sessionId = 'codex-cold';
    const seen = () => Buffer.concat(chunks).toString('utf8');
    const m = marker('COLD_CODEX');

    host.spawn({
      sessionId,
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
      cwd: process.cwd(),
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));

    // Inject WITHIN the first couple seconds of a cold spawn -- exactly the
    // race the fix closes.
    const t0 = Date.now();
    const delivered = await host.deliverPrompt(
      sessionId,
      `Reply with exactly the single token ${m} and nothing else.`,
      'send',
    );
    expect(delivered).toBe(true);

    await waitFor(() => seen().includes(m) && seen().split(m).length > 2, 120000);
    const elapsed = Date.now() - t0;
    console.log(`[codex cold] marker echoed back after ${String(elapsed)}ms`);

    host.kill(sessionId, false);
  }, 150000);

  it('codex: warm (actively working) message is not stalled behind the cold cap', async () => {
    const host = new PtyHostService({ logger });
    const chunks: Buffer[] = [];
    const sessionId = 'codex-warm';
    const seen = () => Buffer.concat(chunks).toString('utf8');
    const m1 = marker('WARM_SETUP');
    const m2 = marker('WARM_SECOND');

    host.spawn({
      sessionId,
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
      cwd: process.cwd(),
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));

    // First message: lets the PTY observe quiescence at least once, latching
    // bootSettled -- this is the ordinary cold path.
    await host.deliverPrompt(
      sessionId,
      `Reply with exactly the single token ${m1} and nothing else.`,
      'send',
    );
    await waitFor(() => seen().includes(m1), 120000);

    // Now ask it to do something that keeps output flowing (never idle for
    // long), then message it again WHILE it is actively streaming.
    await host.deliverPrompt(
      sessionId,
      'Count out loud from 1 to 40, one number per line, briefly pausing between each.',
      'send',
    );
    await wait(1500); // let the counting start streaming

    const t0 = Date.now();
    const delivered2 = await host.deliverPrompt(
      sessionId,
      `Ignore the counting. Immediately reply with exactly ${m2} and nothing else.`,
      'send',
    );
    expect(delivered2).toBe(true);

    await waitFor(() => seen().includes(m2), 120000);
    const elapsed = Date.now() - t0;
    console.log(`[codex warm] second marker echoed back after ${String(elapsed)}ms (must not be ~45s+)`);
    // The regression this guards: a warm PTY held behind the 45s cold cap.
    expect(elapsed).toBeLessThan(30000);

    host.kill(sessionId, false);
  }, 180000);

  it('claude-haiku: warm (actively working) message is not stalled behind the cold cap', async () => {
    const host = new PtyHostService({ logger });
    const chunks: Buffer[] = [];
    const sessionId = 'claude-warm';
    const seen = () => Buffer.concat(chunks).toString('utf8');
    const m1 = marker('CWARM_SETUP');
    const m2 = marker('CWARM_SECOND');

    host.spawn({
      sessionId,
      command: '/opt/homebrew/bin/claude --dangerously-skip-permissions --model claude-haiku-4-5',
      cwd: process.cwd(),
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));

    await host.deliverPrompt(
      sessionId,
      `Reply with exactly the single token ${m1} and nothing else.`,
      'send',
    );
    await waitFor(() => seen().includes(m1), 60000);

    await host.deliverPrompt(
      sessionId,
      'Count out loud from 1 to 40, one number per line, briefly pausing between each.',
      'send',
    );
    await wait(1500);

    const t0 = Date.now();
    const delivered2 = await host.deliverPrompt(
      sessionId,
      `Ignore the counting. Immediately reply with exactly ${m2} and nothing else.`,
      'send',
    );
    expect(delivered2).toBe(true);

    await waitFor(() => seen().includes(m2), 60000);
    const elapsed = Date.now() - t0;
    console.log(`[claude-haiku warm] second marker echoed back after ${String(elapsed)}ms (must not be ~45s+)`);
    expect(elapsed).toBeLessThan(30000);

    host.kill(sessionId, false);
  }, 150000);

  it('claude-haiku: cold-spawn message lands and submits', async () => {
    const host = new PtyHostService({ logger });
    const chunks: Buffer[] = [];
    const sessionId = 'claude-cold';
    const seen = () => Buffer.concat(chunks).toString('utf8');
    const m = marker('COLD_CLAUDE');

    host.spawn({
      sessionId,
      // Absolute path: this box's PATH resolves bare `claude` to a stale
      // npm-global install (v2.1.77) that self-triggers a long, noisy
      // "Auto-updating..." / "switched from npm to native" boot animation on
      // every launch, with quiet gaps >1500ms WHILE still mid-transition --
      // that spuriously satisfies the cold readiness gate and writes into a
      // not-actually-ready composer. The homebrew install boots clean in ~2s.
      command: '/opt/homebrew/bin/claude --dangerously-skip-permissions --model claude-haiku-4-5',
      cwd: process.cwd(),
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));

    const t0 = Date.now();
    const delivered = await host.deliverPrompt(
      sessionId,
      `Reply with exactly the single token ${m} and nothing else.`,
      'send',
    );
    expect(delivered).toBe(true);

    await waitFor(() => seen().includes(m) && seen().split(m).length > 2, 120000);
    const elapsed = Date.now() - t0;
    console.log(`[claude-haiku cold] marker echoed back after ${String(elapsed)}ms`);

    host.kill(sessionId, false);
  }, 150000);
});
