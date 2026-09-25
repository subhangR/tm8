// The workspace-trust watchdog (task 01a0d79e-1b86).
//
// FIXTURES ARE REAL. `fixtures/claude-trust-dialog/*.bin` are raw PTY bytes
// captured from Claude Code 2.1.280 at 80x24 (2026-09-25): the dialog as it
// boots (cursor on "No, exit"), after one Down-arrow (cursor on "Yes"), and the
// composer after Enter. They are rendered through the same TerminalStateMirror
// the server reads, so the matcher is tested against what production sees.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TerminalStateMirror } from '../src/pty/TerminalStateMirror.js';
import type { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  decideTrustWatchdog,
  readTrustDialog,
  TRUST_CONFIRM_KEYS,
  TRUST_PROMPT_UNANSWERED,
  TRUST_SELECT_YES_KEYS,
  TRUST_WATCHDOG_MAX_KEYSTROKES,
  type TrustWatchdogState,
} from '../src/spawn/trust-watchdog.js';
import type { Tm8Manifest } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude-trust-dialog');

async function render(name: 'dialog-no' | 'dialog-yes' | 'after-confirm'): Promise<string> {
  const mirror = new TerminalStateMirror(80, 24);
  mirror.append(await readFile(join(FIXTURES, `${name}.bin`)));
  const screen = await mirror.readViewport();
  mirror.dispose();
  return screen;
}

const state = (screen: string, over: Partial<TrustWatchdogState> = {}): TrustWatchdogState => ({
  screen,
  elapsedMs: 1_000,
  windowMs: 120_000,
  keystrokes: 0,
  absentReads: 0,
  autoTrust: true,
  ...over,
});

describe('readTrustDialog on real Claude Code 2.1.280 frames', () => {
  it('sees the booting dialog with the cursor on "No, exit"', async () => {
    expect(readTrustDialog(await render('dialog-no'))).toEqual({ visible: true, selected: 'no' });
  });

  it('sees the cursor move to "Yes, I trust this folder" after one Down-arrow', async () => {
    expect(readTrustDialog(await render('dialog-yes'))).toEqual({ visible: true, selected: 'yes' });
  });

  it('does not mistake the composer (whose prompt row also starts with ❯) for the dialog', async () => {
    const composer = await render('after-confirm');
    expect(composer).toContain('❯'); // control: the glyph IS on screen
    expect(readTrustDialog(composer)).toEqual({ visible: false, selected: null });
  });

  it('does not act on the dialog text quoted inside a task body', () => {
    // This task's own body quotes the dialog. Rendered as a user turn it has
    // every word, but no bare option row — so nothing may be pressed.
    const quoted = [
      '> FLEET DEFECT: a lane can hang at the WORKSPACE-TRUST prompt ("Quick safety',
      '  check: Is this a project you created or one you trust? … Yes, I trust this',
      '  folder"). Options were No, exit / Yes, I trust this folder. Enter to confirm.',
      '❯ Try "how does <filepath> work?"',
    ].join('\n');
    expect(readTrustDialog(quoted).visible).toBe(false);
  });
});

describe('decideTrustWatchdog', () => {
  it('moves the cursor off "No, exit" and NEVER presses Enter there', async () => {
    const onNo = await render('dialog-no');
    for (let keystrokes = 0; keystrokes < TRUST_WATCHDOG_MAX_KEYSTROKES; keystrokes += 1) {
      expect(decideTrustWatchdog(state(onNo, { keystrokes })).kind).toBe('select-yes');
    }
  });

  it('confirms once the cursor is on "Yes"', async () => {
    expect(decideTrustWatchdog(state(await render('dialog-yes'), { keystrokes: 1 }))).toEqual({
      kind: 'confirm',
    });
  });

  it('calls it recovered only after two dialog-free reads following a keystroke', async () => {
    const composer = await render('after-confirm');
    // One absent frame can be a mid-redraw read: keep watching.
    expect(decideTrustWatchdog(state(composer, { keystrokes: 2, absentReads: 0 })).kind).toBe('wait');
    expect(decideTrustWatchdog(state(composer, { keystrokes: 2, absentReads: 1 })).kind).toBe('recovered');
  });

  it('waits, then stands down, on a lane that never shows the dialog', async () => {
    const composer = await render('after-confirm');
    expect(decideTrustWatchdog(state(composer)).kind).toBe('wait');
    expect(decideTrustWatchdog(state(composer, { elapsedMs: 120_000 }))).toEqual({
      kind: 'stop',
      reason: 'window_elapsed',
    });
  });

  it('keeps answering a visible dialog past the window — a found hang is never abandoned', async () => {
    expect(decideTrustWatchdog(state(await render('dialog-no'), { elapsedMs: 500_000 })).kind).toBe(
      'select-yes',
    );
  });

  it('presses nothing when the operator opted out of auto-trust', async () => {
    expect(decideTrustWatchdog(state(await render('dialog-no'), { autoTrust: false }))).toEqual({
      kind: 'stop',
      reason: 'opted_out',
    });
  });

  it('fails by name when the dialog survives every keystroke', async () => {
    expect(
      decideTrustWatchdog(state(await render('dialog-yes'), { keystrokes: TRUST_WATCHDOG_MAX_KEYSTROKES })),
    ).toEqual({ kind: 'fail', reason: TRUST_PROMPT_UNANSWERED });
  });
});

// ── the loop inside SpawnService ────────────────────────────────────────────

const SESSION = '44444444-4444-4444-8444-444444444444';

/** A PTY whose screen follows a script: each written key advances a frame. */
function scriptedPty(frames: Record<string, string>, transitions: (screen: string, keys: string) => string) {
  let screen = frames.start!;
  const writes: string[] = [];
  let live = true;
  const pty = {
    getEpoch: () => (live ? 'epoch-1' : null),
    hasSession: () => live,
    readScreen: async () => (live ? screen : null),
    write: (_id: string, keys: string) => {
      writes.push(keys);
      screen = transitions(screen, keys);
    },
    kill: vi.fn(() => {
      live = false;
      return 'killed' as const;
    }),
  };
  return { pty: pty as unknown as PtyHostService, writes, kill: pty.kill };
}

async function runWatchdog(pty: PtyHostService, dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const svc = new SpawnService({
    graph: new FakeGraph({ workingDir: '/tmp', withProject: false }),
    pty,
    baseUrl: 'http://127.0.0.1:4614',
    dataDir,
    trustWatchdogMs: 2_000,
    trustWatchdogPollMs: 5,
  });
  const manifestPath = join(dataDir, 'manifests', `${SESSION}.json`);
  const manifest = { launch: { tool: 'claude-code' } } as unknown as Tm8Manifest;
  await (svc as unknown as {
    runTrustWatchdog: (id: string, path: string, m: Tm8Manifest, e: NodeJS.ProcessEnv) => Promise<void>;
  }).runTrustWatchdog(SESSION, manifestPath, manifest, env);
  const written = await readFile(manifestPath, 'utf8').then(JSON.parse, () => null);
  return { written };
}

describe('SpawnService workspace-trust watchdog loop', () => {
  it('answers Down then Enter and records launch.trustRecovered in the manifest file', async () => {
    const [no, yes, composer] = await Promise.all([
      render('dialog-no'),
      render('dialog-yes'),
      render('after-confirm'),
    ]);
    const { pty, writes } = scriptedPty({ start: no }, (screen, keys) =>
      keys === TRUST_SELECT_YES_KEYS && screen === no ? yes : keys === TRUST_CONFIRM_KEYS && screen === yes ? composer : screen,
    );
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-watchdog-'));

    const { written } = await runWatchdog(pty, dataDir);

    expect(writes).toEqual([TRUST_SELECT_YES_KEYS, TRUST_CONFIRM_KEYS]);
    expect(written?.launch).toEqual({ tool: 'claude-code', trustRecovered: true });
  });

  it('presses nothing and records nothing on a lane that boots straight to the composer', async () => {
    const { pty, writes } = scriptedPty({ start: await render('after-confirm') }, (s) => s);
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-watchdog-'));

    const { written } = await runWatchdog(pty, dataDir);

    expect(writes).toEqual([]);
    expect(written).toBeNull();
  });

  it('fails the lane by name — never leaves it idle — when the dialog will not close', async () => {
    const yes = await render('dialog-yes');
    const { pty, writes, kill } = scriptedPty({ start: yes }, (s) => s); // Enter "does nothing"
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-watchdog-'));
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { written } = await runWatchdog(pty, dataDir);

    expect(writes).toEqual(Array(TRUST_WATCHDOG_MAX_KEYSTROKES).fill(TRUST_CONFIRM_KEYS));
    expect(kill).toHaveBeenCalledWith(SESSION, true);
    expect(written).toBeNull();
    loud.mockRestore();
  });

  it('with auto-trust opted out, presses nothing and says so', async () => {
    const { pty, writes, kill } = scriptedPty({ start: await render('dialog-no') }, (s) => s);
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-watchdog-'));
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runWatchdog(pty, dataDir, { TM8_AUTO_TRUST_WORKSPACE: 'false' });

    expect(writes).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(loud.mock.calls.flat().join(' ')).toContain('TM8_AUTO_TRUST_WORKSPACE=false');
    loud.mockRestore();
  });
});
