// Coverage for the two-signal prompt-delivery completion (onPromptSettled), added
// alongside the closed-loop submit fix so a delivery-saga caller can settle a
// durable record on the REAL outcome instead of deliverPrompt's admission-only
// boolean. Real PTYs throughout -- this is the exact class of bug ("passed 40/40
// under fake timers, submitted 0/4 against a live agent") the closed loop itself
// was ported to fix, so its completion signal gets the same real-process scrutiny.

import { describe, expect, it, afterEach } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';

// The interpreter running this suite. `spawn` is given `env: {}`, so the shell
// has only its compiled-in default PATH and a bare `node` resolves only when it
// happens to sit in `/usr/bin` or `/usr/local/bin`. See prompt-fidelity.test.ts.
const NODE = JSON.stringify(process.execPath);

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await wait(20);
  }
}

describe('PtyHostService onPromptSettled -- two-signal prompt delivery', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  it('reports delivered once a real agent submits and the text leaves the cursor', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-delivered';
    const chunks: Buffer[] = [];
    // A real shell reading lines and echoing them back with a prefix -- Enter
    // genuinely clears the composer, so verification finds the text gone.
    host.spawn({
      sessionId,
      command: `while IFS= read -r line; do printf 'GOT: %s\\n' "$line"; done`,
      cwd: '/tmp',
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));
    const seen = () => Buffer.concat(chunks).toString('utf8');

    const admitted = await host.deliverPrompt(sessionId, 'hello there', 'send', 'delivery-1');
    expect(admitted).toBe(true);

    await waitFor(() => seen().includes('GOT: hello there'));
    await waitFor(() => settled.length === 1);

    expect(settled[0]).toEqual({ sessionId, deliveryId: 'delivery-1', outcome: 'delivered', reason: undefined });
  }, 20000);

  it('reports unknown/submit_unverified when the text never leaves the cursor', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-stuck';
    // A raw byte echo with NO canonical line processing: every byte we write,
    // including the '\r' the closed loop presses, is written straight back.
    // xterm treats a bare '\r' with no '\n' as "return to column 0 on the SAME
    // row", so the cursor never advances to a new line and our token stays
    // glued to the cursor's row forever -- the real-process analogue of a
    // composer whose Enter is swallowed and never clears the input box.
    host.spawn({
      sessionId,
      // Raw mode is load-bearing: without it the PTY's own line discipline
      // (ICRNL) turns our '\r' into a real newline before this script ever
      // sees it, advancing the cursor to a fresh row and defeating the whole
      // point of this fixture (verification would then find the token gone,
      // same as a real, working submit).
      command: `${NODE} -e "process.stdin.setRawMode(true); process.stdin.on('data', d => process.stdout.write(d))"`,
      cwd: '/tmp',
      env: {},
    });

    const admitted = await host.deliverPrompt(sessionId, 'stuck-token', 'send', 'delivery-2');
    expect(admitted).toBe(true);

    await waitFor(() => settled.length === 1, 60000);

    expect(settled[0]?.sessionId).toBe(sessionId);
    expect(settled[0]?.deliveryId).toBe('delivery-2');
    expect(settled[0]?.outcome).toBe('unknown');
    expect(settled[0]?.reason).toBe('submit_unverified');
  }, 70000);

  it('reports delivered for paste mode as soon as the body is written (no submit expected)', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-paste';
    host.spawn({ sessionId, command: 'cat', cwd: '/tmp', env: {} });

    const admitted = await host.deliverPrompt(sessionId, 'pasted body', 'paste', 'delivery-3');
    expect(admitted).toBe(true);

    await waitFor(() => settled.length === 1);
    expect(settled[0]).toEqual({ sessionId, deliveryId: 'delivery-3', outcome: 'delivered', reason: undefined });
  }, 15000);

  it('never fires the callback for a delivery admitted without a deliveryId', async () => {
    const settled: unknown[] = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (...args) => {
        settled.push(args);
      },
    });
    const sessionId = 'settle-no-id';
    const chunks: Buffer[] = [];
    host.spawn({
      sessionId,
      command: `while IFS= read -r line; do printf 'GOT: %s\\n' "$line"; done`,
      cwd: '/tmp',
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));
    const seen = () => Buffer.concat(chunks).toString('utf8');

    // No deliveryId passed -- exactly the pre-existing call shape.
    await host.deliverPrompt(sessionId, 'no correlation', 'send');
    await waitFor(() => seen().includes('GOT: no correlation'));
    await wait(200); // give a stray callback a chance to fire if it were going to
    expect(settled).toEqual([]);
  }, 20000);

  it('reports unknown when the session is killed while the prompt is still queued', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-killed-queued';

    // Queue a prompt BEFORE any PTY exists -- it sits in the FIFO, never dequeued.
    const admitted = await host.deliverPrompt(sessionId, 'never gets there', 'send', 'delivery-4');
    expect(admitted).toBe(true);

    // Explicit kill of a session with no live entry still must not strand the
    // queued delivery's completion signal.
    expect(host.kill(sessionId, true)).toBe('not_found');

    await waitFor(() => settled.length === 1);
    expect(settled[0]).toEqual({
      sessionId,
      deliveryId: 'delivery-4',
      outcome: 'unknown',
      reason: 'session_killed_with_prompt_queued',
    });
  }, 10000);

  /**
   * ARRIVAL CONFIRMATION on a spawn's first turn.
   *
   * The regression: the submit verifier can only ask "is our text still at the
   * cursor?", and a body that never reached the composer answers that exactly
   * as a submitted one does. So a first turn written into a not-yet-drawn
   * composer settled as `delivered`, the session went `running`, and the agent
   * sat at an empty prompt with its task nowhere — the live failure on sessions
   * 01a035b9 / 01a035d3.
   */
  it('reports unknown/body_never_reached_composer when a first turn never reaches the composer', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-swallowed-first-turn';
    // A booting agent, modelled honestly: it SPEAKS once (so the cold gate's
    // `everSpoke` requirement is satisfied and the process is not mistaken for
    // inert), then falls quiet past the cold idle window (so the gate releases
    // and we write), then swallows every byte written to it without ever
    // rendering one. Raw mode is what makes that true — it turns off the tty's
    // own echo, so nothing our writes contain can ever appear at the cursor,
    // which is precisely a TUI that has not drawn its composer yet.
    host.spawn({
      sessionId,
      command: `node -e "process.stdout.write('booting\\n'); process.stdin.setRawMode(true); process.stdin.resume(); setInterval(() => {}, 1000)"`,
      cwd: '/tmp',
      env: {},
    });

    const admitted = await host.deliverPrompt(
      sessionId,
      'first turn that never lands',
      'send',
      'delivery-arrival',
      true, // requireReadyOutput — spawn's first turn
    );
    expect(admitted).toBe(true);

    await waitFor(() => settled.length === 1, 60000);
    expect(settled[0]?.outcome).toBe('unknown');
    expect(settled[0]?.reason).toBe('body_never_reached_composer');
  }, 70000);

  /**
   * The other half of the same contract: arrival confirmation must not turn a
   * working first turn into a failure. A child that echoes what it is given —
   * the same shape every real agent composer has — still settles `delivered`.
   */
  it('still reports delivered for a first turn that does reach the composer', async () => {
    const settled: Array<{ sessionId: string; deliveryId: string; outcome: string; reason?: string }> = [];
    host = new PtyHostService({
      logger: quiet,
      onPromptSettled: (sessionId, deliveryId, outcome, reason) => {
        settled.push({ sessionId, deliveryId, outcome, reason });
      },
    });
    const sessionId = 'settle-arrival-ok';
    const chunks: Buffer[] = [];
    // Speaks a banner first, exactly as a real agent does at boot: the cold gate
    // refuses to write a first turn into a process that has never emitted a byte
    // (`agent_never_became_ready`), so a fixture that only ever answers input
    // could never receive one.
    host.spawn({
      sessionId,
      command: `printf 'ready\\n'; while IFS= read -r line; do printf 'GOT: %s\\n' "$line"; done`,
      cwd: '/tmp',
      env: {},
    });
    host.onFrames(sessionId, (f) => chunks.push(f));
    const seen = () => Buffer.concat(chunks).toString('utf8');

    const admitted = await host.deliverPrompt(
      sessionId,
      'first turn that lands',
      'send',
      'delivery-arrival-ok',
      true, // requireReadyOutput — spawn's first turn
    );
    expect(admitted).toBe(true);

    await waitFor(() => seen().includes('GOT: first turn that lands'), 30000);
    await waitFor(() => settled.length === 1, 30000);
    expect(settled[0]?.outcome).toBe('delivered');
    expect(settled[0]?.reason).toBeUndefined();
  }, 40000);
});
