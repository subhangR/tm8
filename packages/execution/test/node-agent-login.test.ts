// E12 — a session on the node's own login, on a host with no login, used to
// hang forever at Claude Code's first-run theme picker. Two halves: the
// pre-spawn gate refuses on a definite "no", and the PTY backstop fails a lane
// that boots into onboarding anyway.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  NODE_AGENT_LOGIN_CACHE_MS,
  NodeAgentLoginGate,
  nodeAgentLoginProvider,
  ONBOARDING_FAIL_READS,
  readClaudeOnboarding,
  type NodeAgentLoginAnswer,
} from '../src/spawn/node-agent-login.js';
import { SpawnError, type Tm8Manifest } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const answer = (verdict: NodeAgentLoginAnswer['verdict']): NodeAgentLoginAnswer => ({
  verdict,
  runAs: 'tm8',
  detail: verdict === 'missing' ? 'claude auth status reports loggedIn=false' : null,
  fix: 'sudo -u tm8 -H claude auth login',
});
const env = { HOME: '/home/tm8', PATH: '/usr/bin' };

describe('NodeAgentLoginGate (pre-spawn)', () => {
  it('maps agent tools to the provider whose node login they run on', () => {
    expect(nodeAgentLoginProvider('claude-code')).toBe('anthropic');
    expect(nodeAgentLoginProvider('codex')).toBe('openai');
    expect(nodeAgentLoginProvider('gemini')).toBeNull();
  });

  it('refuses a definite "no login", naming the user and the fix', async () => {
    const gate = new NodeAgentLoginGate(async () => answer('missing'));
    const refusal = await gate.assertUsable({ provider: 'anthropic', env, cwd: '/' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SpawnError);
    const error = refusal as SpawnError;
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('OS user tm8');
    expect(error.message).toContain('sudo -u tm8 -H claude auth login');
    expect(error.detail).toMatchObject({ reason: 'node_agent_login_missing' });
  });

  it('never refuses on doubt', async () => {
    const gate = new NodeAgentLoginGate(async () => answer('unknown'));
    await expect(gate.assertUsable({ provider: 'anthropic', env, cwd: '/' })).resolves.toBeUndefined();
  });

  it('caches a confirmed login briefly and re-asks after a refusal', async () => {
    let now = 0;
    const probe = vi.fn(async () => answer('usable'));
    const gate = new NodeAgentLoginGate(probe, () => now);
    await gate.assertUsable({ provider: 'anthropic', env, cwd: '/' });
    await gate.assertUsable({ provider: 'anthropic', env, cwd: '/' });
    expect(probe).toHaveBeenCalledTimes(1);
    now += NODE_AGENT_LOGIN_CACHE_MS + 1;
    await gate.assertUsable({ provider: 'anthropic', env, cwd: '/' });
    expect(probe).toHaveBeenCalledTimes(2);
    // A different config home is a different login.
    await gate.assertUsable({ provider: 'anthropic', env: { ...env, CLAUDE_CONFIG_DIR: '/x' }, cwd: '/' });
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

// Claude Code 2.x first-run frames as the server's TerminalStateMirror
// renders them (wrapped at the PTY width).
const THEME_PICKER = [
  ' Welcome to Claude Code',
  '',
  " Let's get started.",
  '',
  ' Choose the text style that looks best with your',
  ' terminal',
  ' To change this later, run /theme',
  '',
  ' ❯ 1. Dark mode ✔',
  '   2. Light mode',
].join('\n');
const LOGIN_METHOD = ' Select login method:\n\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account';

describe('readClaudeOnboarding', () => {
  it('sees the theme picker and the login-method screen, across a wrap', () => {
    expect(readClaudeOnboarding(THEME_PICKER)).toBe(true);
    expect(readClaudeOnboarding(LOGIN_METHOD)).toBe(true);
  });

  it('does not see an ordinary composer', () => {
    expect(readClaudeOnboarding('> \n  ? for shortcuts')).toBe(false);
  });
});

describe('SpawnService watchdog — onboarding backstop', () => {
  const SESSION = '55555555-5555-4555-8555-555555555555';

  async function run(screen: string | string[]) {
    let live = true;
    const frames = Array.isArray(screen) ? [...screen] : [screen];
    const kill = vi.fn(() => { live = false; return 'killed' as const; });
    const pty = {
      getEpoch: () => (live ? 'epoch-1' : null),
      hasSession: () => live,
      // Each read advances one frame; the last frame then stays up.
      readScreen: async () => (live ? (frames.length > 1 ? frames.shift()! : frames[0]!) : null),
      write: vi.fn(),
      kill,
    } as unknown as PtyHostService;
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-onboarding-'));
    const svc = new SpawnService({
      graph: new FakeGraph({ workingDir: '/tmp', withProject: false }),
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      trustWatchdogMs: 200,
      trustWatchdogPollMs: 2,
    });
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});
    await (svc as unknown as {
      runTrustWatchdog: (id: string, path: string, m: Tm8Manifest, e: NodeJS.ProcessEnv) => Promise<void>;
    }).runTrustWatchdog(SESSION, join(dataDir, 'm.json'), { launch: {} } as unknown as Tm8Manifest, {});
    const said = loud.mock.calls.flat().join(' ');
    loud.mockRestore();
    return { kill, said };
  }

  it(`fails a lane stuck at the first-run theme picker after ${String(ONBOARDING_FAIL_READS)} reads`, async () => {
    const { kill, said } = await run(THEME_PICKER);
    expect(kill).toHaveBeenCalledWith(SESSION, true);
    expect(said).toContain('agent_onboarding_screen');
  });

  it('still fails it when the banner renders a frame BEFORE the picker (measured on 2.1.280)', async () => {
    // The trust watchdog reads "Claude Code v2.1.280" as booted-past-trust; the
    // picker is drawn under that same banner one frame later.
    const banner = ' Welcome to Claude Code v2.1.280';
    const { kill, said } = await run(['', banner, `${banner}\n${THEME_PICKER}`]);
    expect(kill).toHaveBeenCalledWith(SESSION, true);
    expect(said).toContain('agent_onboarding_screen');
  });

  it('leaves a lane that boots to the composer alone', async () => {
    const { kill } = await run('> \n  ? for shortcuts');
    expect(kill).not.toHaveBeenCalled();
  });
});
