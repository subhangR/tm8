// Precedence, cwd resolution and command building — the parts of the spawn
// flow that are pure functions, and therefore the parts where a regression is
// cheap to catch and expensive to notice in production.

import { describe, expect, it } from 'vitest';
import {
  agentToolForModel,
  buildAgentCommand,
  composeEnv,
  composeManifest,
  resolveLaunchConfig,
  resolveWorkdir,
} from '../src/spawn/manifest.js';
import { SpawnError, type SpawnContext, type SpawnRequest } from '../src/spawn/types.js';

function context(overrides: Partial<SpawnContext['teamMember']> = {}): SpawnContext {
  return {
    spaceId: 'space-1',
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'tm-1',
      name: 'Draco',
      role: 'PTY engineer',
      identity: 'terminal seam',
      memories: [],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
      ...overrides,
    },
    tasks: [],
  };
}

const base: SpawnRequest = { spaceId: 'space-1', teamMemberId: 'tm-1' };

describe('resolveLaunchConfig', () => {
  it('prefers the request over the persona, and the persona over the default', () => {
    expect(resolveLaunchConfig({ ...base, model: 'haiku' }, context(), {}).model).toBe('haiku');
    expect(resolveLaunchConfig(base, context(), {}).model).toBe('opus');
    expect(resolveLaunchConfig(base, context({ model: null }), {}).model).toBe('sonnet');
  });

  it('infers the agent tool from the MODEL, not the persona stale tool', () => {
    // The bug this prevents: a persona switched from Codex to Opus still says
    // agent_tool='codex', and the spawn dies inside the wrong CLI on an
    // unrecognised model. The model is what the user chose.
    const resolved = resolveLaunchConfig(base, context({ model: 'opus', agentTool: 'codex' }), {});
    expect(resolved.agentTool).toBe('claude-code');
  });

  it('falls back to the persona tool only when the model implies nothing', () => {
    const resolved = resolveLaunchConfig(
      base,
      context({ model: 'some-private-model', agentTool: 'hermes' }),
      {},
    );
    expect(resolved.agentTool).toBe('hermes');
  });

  it('lets TM8_PERMISSION_MODE override the persona, and nothing override it', () => {
    expect(resolveLaunchConfig(base, context({ permissionMode: 'readOnly' }), {}).permissionMode).toBe(
      'readOnly',
    );
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'readOnly' }), {
        TM8_PERMISSION_MODE: 'bypassPermissions',
      }).permissionMode,
    ).toBe('bypassPermissions');
  });

  it('ignores permission and mode values that are not in the enum', () => {
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'yolo' }), {}).permissionMode,
    ).toBe('acceptEdits');
    expect(resolveLaunchConfig(base, context({ mode: 'nonsense' as never }), {}).mode).toBe('worker');
  });

  it('maps model families to tools', () => {
    expect(agentToolForModel('claude-opus-5')).toBe('claude-code');
    expect(agentToolForModel('gpt-5')).toBe('codex');
    expect(agentToolForModel('gemini-2.5-pro')).toBe('gemini');
    expect(agentToolForModel('something-else')).toBeNull();
    expect(agentToolForModel(null)).toBeNull();
  });
});

describe('resolveWorkdir', () => {
  const opts = { scratchRoot: '/tmp/tm8-scratch' };

  it('uses the project working dir from the graph', () => {
    expect(resolveWorkdir(base, context(), opts).path).toBe('/tmp/tm8-fixture');
  });

  it('refuses worktree mode loudly instead of silently using the project dir', () => {
    // A caller who asked for an isolated tree and got the shared one finds out
    // by having their branch stomped. R20, post-G1A.
    expect(() =>
      resolveWorkdir({ ...base, workdir: { mode: 'worktree' } }, context(), opts),
    ).toThrow(SpawnError);
  });

  it('rejects a working dir that is not a safe absolute path', () => {
    const ctx = context();
    ctx.project = { id: 'p', name: 'p', workingDir: '/tmp/../etc', trust: 'trusted' };
    expect(() => resolveWorkdir(base, ctx, opts)).toThrow(/safe absolute path/);
  });

  it('falls back to a server-managed scratch dir when there is no project', () => {
    const ctx = context();
    ctx.project = null;
    const resolved = resolveWorkdir(base, ctx, { ...opts, sessionIdHint: 'sess-9' });
    expect(resolved.path).toBe('/tmp/tm8-scratch/sess-9');
  });
});

describe('buildAgentCommand', () => {
  const launch = {
    mode: 'worker' as const,
    model: 'opus',
    agentTool: 'claude-code',
    permissionMode: 'acceptEdits' as const,
  };

  it('resolves the built-in echo agent to a runnable node command', () => {
    const cmd = buildAgentCommand(launch, { TM8_AGENT_CMD: 'echo-agent' });
    expect(cmd).toMatch(/^node '.*harness\/echo-agent\.mjs'$/);
  });

  it('derives claude flags from the manifest posture', () => {
    expect(buildAgentCommand(launch, {})).toBe('claude --permission-mode acceptEdits --model opus');
    expect(buildAgentCommand({ ...launch, permissionMode: 'readOnly' }, {})).toContain(
      '--permission-mode plan',
    );
    expect(
      buildAgentCommand({ ...launch, permissionMode: 'bypassPermissions' }, {}),
    ).toBe('claude --dangerously-skip-permissions --model opus');
  });

  it('uses any other TM8_AGENT_CMD verbatim rather than guessing its flags', () => {
    expect(buildAgentCommand(launch, { TM8_AGENT_CMD: 'my-agent --wrapped' })).toBe(
      'my-agent --wrapped',
    );
  });
});

describe('composeEnv', () => {
  const manifest = composeManifest({
    sessionId: 'sess-1',
    request: base,
    context: context(),
    launch: {
      mode: 'worker',
      model: 'opus',
      agentTool: 'claude-code',
      permissionMode: 'acceptEdits',
    },
    workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
    command: 'claude',
    baseUrl: 'http://127.0.0.1:4610',
  });

  it('sets the three variables that are the whole boot contract', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', {});
    expect(env.TM8_SESSION_ID).toBe('sess-1');
    expect(env.TM8_MANIFEST_PATH).toBe('/tmp/m.json');
    expect(env.TM8_BASE_URL).toBe('http://127.0.0.1:4610');
  });

  it('forwards provider credentials that the server itself holds', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://x', { ANTHROPIC_API_KEY: 'sk-test' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('blanks CLAUDE_CODE_ENTRYPOINT rather than deleting it', () => {
    // node-pty merges over process.env, so `delete` here would leave the
    // inherited value intact in the child and the agent would refuse to start,
    // believing it is already running inside itself.
    const env = composeEnv(manifest, '/tmp/m.json', 'http://x', { CLAUDECODE: '1' });
    expect(env.CLAUDECODE).toBe('');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('');
  });
});

describe('composeManifest', () => {
  it('carries the persona, the resolved posture and the server-computed cwd', () => {
    const manifest = composeManifest({
      sessionId: 'sess-2',
      request: { ...base, promptExtra: '  focus on the seam  ' },
      context: context(),
      launch: {
        mode: 'coordinated-worker',
        model: 'opus',
        agentTool: 'claude-code',
        permissionMode: 'bypassPermissions',
      },
      workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
      command: 'claude --dangerously-skip-permissions --model opus',
      baseUrl: 'http://127.0.0.1:4610',
      now: new Date('2026-07-25T12:00:00.000Z'),
    });

    expect(manifest.manifestVersion).toBe('1');
    expect(manifest.mode).toBe('coordinated-worker');
    expect(manifest.launch.permissionMode).toBe('bypassPermissions');
    expect(manifest.session.workingDirectory).toBe('/tmp/tm8-fixture');
    // `agent` is the PERSONA (Phoenix's CLI reader owns this shape); `launch`
    // is how the session was started. The two must never swap names again.
    expect(manifest.agent.name).toBe('Draco');
    expect(manifest.agent.teamMemberId).toBe('tm-1');
    expect(manifest.agent.memory).toEqual([]);
    expect(manifest.promptExtra).toBe('focus on the seam');
    expect(manifest.generatedAt).toBe('2026-07-25T12:00:00.000Z');
  });

  it('titles a session from its first task, then from the persona', () => {
    const withTask = context();
    withTask.tasks = [
      {
        id: 't1',
        title: 'wire the prompt seam',
        description: '',
        priority: 'high',
        workStatus: 'open',
        acceptanceCriteria: [],
      },
    ];
    const launch = {
      mode: 'worker' as const,
      model: 'opus',
      agentTool: 'claude-code',
      permissionMode: 'acceptEdits' as const,
    };
    const args = {
      sessionId: 's',
      request: base,
      launch,
      workdir: { mode: 'project' as const, path: '/tmp/x' },
      command: 'claude',
      baseUrl: 'http://x',
    };
    expect(composeManifest({ ...args, context: withTask }).session.title).toBe('wire the prompt seam');
    expect(composeManifest({ ...args, context: context() }).session.title).toBe('Draco session');
  });
});
