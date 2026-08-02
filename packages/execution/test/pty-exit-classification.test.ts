// Regression coverage for the PTY exit classification, added from a LIVE defect
// on the prod node (tm8 task 019fbec1, defect #4, reproduced 2026-08-02).
//
// The bug: `const status = exitCode === 0 ? 'completed' : 'failed'`. node-pty
// reports a signal death as exit code 0 WITH a non-zero signal, so every
// SIGKILL/SIGTERM was filed as a clean completion. Measured on the live node:
// SIGKILLing a running agent left work_sessions holding
// status='exited', exit_code=0, error=NULL -- identical to an agent that
// finished its work, and with the terminating signal recorded nowhere.
//
// This matters well beyond a manual kill: tm8-prod.service runs
// KillMode=control-group, so ONE `systemctl restart` SIGTERMs every live agent
// on the node and, before this fix, recorded all of them as having completed
// successfully.
//
// Real PTYs throughout, deliberately: the whole defect lived in what node-pty
// actually reports, which a fake would have had to assert -- wrongly, since the
// pre-fix code was written against the assumption that a clean exit reports no
// signal at all. It reports `signal: 0`.

import { describe, expect, it, afterEach } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import type { PtyExitInfo, PtySessionStatus } from '../src/pty/types.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await wait(20);
  }
}

interface Recorded {
  status: PtySessionStatus;
  info: PtyExitInfo;
}

describe('PtyHostService exit classification -- a signal death is not a completion', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  function makeHost(seen: Map<string, Recorded>): PtyHostService {
    return new PtyHostService({
      logger: quiet,
      onSessionStatus: (sessionId, status, info) => {
        seen.set(sessionId, { status, info });
      },
    });
  }

  // `kill -N $$` from inside the PTY's own shell rather than a pid lookup from
  // outside: it kills exactly the process node-pty is watching, needs no new
  // public accessor on the host, and reproduces the live defect identically --
  // measured against node-pty 1.1.0, `kill -9 $$` reports { exitCode: 0,
  // signal: 9 } and `kill -TERM $$` reports { exitCode: 0, signal: 15 }.
  it.each([
    ['SIGKILL', 9],
    ['SIGTERM', 15],
  ])('files a %s death as failed, and preserves the signal that caused it', async (name, signum) => {
    const seen = new Map<string, Recorded>();
    host = makeHost(seen);
    const sessionId = `exit-signal-${signum}`;
    host.spawn({ sessionId, command: `kill -${signum} $$`, cwd: '/tmp', env: {} });

    await waitFor(() => seen.has(sessionId));
    const rec = seen.get(sessionId) as Recorded;

    // The regression itself: both of these were 'completed' before the fix,
    // because node-pty pairs the signal with exit code 0.
    expect(rec.status).toBe('failed');
    // And the evidence survives rather than being discarded with the status --
    // this is what makes describePtyExit reachable for the case it describes.
    expect(rec.info.signal).toBe(signum);
  }, 20000);

  it('files a clean exit 0 as completed, with no phantom signal', async () => {
    const seen = new Map<string, Recorded>();
    host = makeHost(seen);
    const sessionId = 'exit-clean';
    host.spawn({ sessionId, command: 'exit 0', cwd: '/tmp', env: {} });

    await waitFor(() => seen.has(sessionId));
    const rec = seen.get(sessionId) as Recorded;

    expect(rec.status).toBe('completed');
    expect(rec.info.exitCode).toBe(0);
    // node-pty spells "no signal" as 0 here. If that leaks through unnormalised,
    // every `signal !== null` consumer downstream reads it as a real signal --
    // describePtyExit would narrate a clean exit as "after signal 0".
    expect(rec.info.signal).toBeNull();
  }, 20000);

  it('files a non-zero exit as failed, and does not invent a signal for it', async () => {
    const seen = new Map<string, Recorded>();
    host = makeHost(seen);
    const sessionId = 'exit-code-7';
    host.spawn({ sessionId, command: 'exit 7', cwd: '/tmp', env: {} });

    await waitFor(() => seen.has(sessionId));
    const rec = seen.get(sessionId) as Recorded;

    expect(rec.status).toBe('failed');
    expect(rec.info.exitCode).toBe(7);
    expect(rec.info.signal).toBeNull();
  }, 20000);
});
