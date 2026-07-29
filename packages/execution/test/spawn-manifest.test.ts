// Precedence, cwd resolution and command building — the parts of the spawn
// flow that are pure functions, and therefore the parts where a regression is
// cheap to catch and expensive to notice in production.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentToolForModel,
  buildAgentCommand,
  composeEnv,
  composeManifest,
  resolveLaunchConfig,
  resolveWorkdir,
  withAgentPrompt,
} from '../src/spawn/manifest.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

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

  it('always skips permissions so an unattended agent cannot hang on a prompt', () => {
    // Claude can block forever on TWO dialogs — the folder-trust gate and
    // per-tool-use confirmations — and a blocked agent produces no output,
    // never reports, and burns a slot against the concurrency cap. The human
    // authorization layer is tm8's spawn-time project-trust gate, which has
    // already refused untrusted directories by the time we get here.
    expect(buildAgentCommand(launch, {})).toBe(
      "claude --dangerously-skip-permissions --model 'opus'",
    );
    expect(
      buildAgentCommand({ ...launch, permissionMode: 'bypassPermissions' }, {}),
    ).toBe("claude --dangerously-skip-permissions --model 'opus'");
  });

  it('overrides a MORE RESTRICTIVE permissionMode — deliberate, and worth knowing', () => {
    // `readOnly` used to map to `--permission-mode plan`. It no longer does:
    // permissionMode is currently ADVISORY for Claude. Honouring it needs a
    // launch path that cannot deadlock, which is post-Slice-1 work. Pinned as a
    // test so the trade-off stays visible rather than being rediscovered.
    expect(buildAgentCommand({ ...launch, permissionMode: 'readOnly' }, {})).toBe(
      "claude --dangerously-skip-permissions --model 'opus'",
    );
    expect(buildAgentCommand({ ...launch, permissionMode: 'readOnly' }, {})).not.toContain(
      '--permission-mode',
    );
  });

  it('appends the composed system prompt for claude, shell-quoted', () => {
    const base = buildAgentCommand(launch, {});
    const prompt = "<tm8_system_prompt>it's \"quoted\"\nand multiline</tm8_system_prompt>";
    const cmd = withAgentPrompt(base, prompt, launch, {});
    expect(cmd.startsWith(base)).toBe(true);
    expect(cmd).toContain('--append-system-prompt');
    // POSIX single-quote escaping: the embedded apostrophe MUST be broken out,
    // or the shell terminates the argument early and the agent boots with a
    // truncated briefing (or the command fails outright).
    expect(cmd).toContain(`'\\''`);
  });

  it('uses Codex developer_instructions and leaves complete operator wrappers unchanged', () => {
    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5-codex' };
    const codex = buildAgentCommand(codexLaunch, {});
    expect(codex).toContain("codex --model 'gpt-5-codex'");
    expect(withAgentPrompt(codex, 'PROMPT', codexLaunch, {})).toContain('developer_instructions=');
    const echo = buildAgentCommand(launch, { TM8_AGENT_CMD: 'echo-agent' });
    expect(withAgentPrompt(echo, 'PROMPT', launch, { TM8_AGENT_CMD: 'echo-agent' })).toBe(echo);
    expect(withAgentPrompt('my-agent', 'PROMPT', launch, { TM8_AGENT_CMD: 'my-agent' })).toBe('my-agent');
  });

  it('rejects unsupported tools instead of silently launching Claude', () => {
    expect(() => buildAgentCommand({ ...launch, agentTool: 'unknown-tool' }, {})).toThrow(
      /unsupported agent tool/,
    );
  });

  it('shell-quotes model names for every built-in CLI', () => {
    const hostileModel = "model'; touch /tmp/not-run; echo '";
    const claude = buildAgentCommand({ ...launch, model: hostileModel }, {});
    const codex = buildAgentCommand({ ...launch, agentTool: 'codex', model: hostileModel }, {});
    expect(claude).toContain(`--model ${"'model'\\''; touch /tmp/not-run; echo '\\'''"}`);
    expect(codex).toContain(`--model ${"'model'\\''; touch /tmp/not-run; echo '\\'''"}`);
  });

  it('appends nothing when the composed prompt is empty', () => {
    const base = buildAgentCommand(launch, {});
    expect(withAgentPrompt(base, '   ', launch, {})).toBe(base);
  });

  it('puts a RESOLVABLE `tm8` on the agent PATH, not merely a plausible directory', () => {
    // The prompt tells the agent to run `tm8 task report ...` — that IS the
    // reporting loop. The built entrypoint is `dist/index.js`, so a PATH entry
    // pointing at a directory that contains only `index.js` looks correct,
    // typechecks, and still leaves every reporting call dying with
    // `tm8: command not found` while the agent believes it reported. So assert
    // the executable NAME resolves, which is the thing that actually matters.
    const env = composeEnv(
      composeManifest({
        sessionId: 's-path',
        request: { spaceId: 'space-1', teamMemberId: 'tm-1' } as SpawnRequest,
        context: context(),
        launch,
        workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
        command: 'claude',
        baseUrl: 'http://127.0.0.1:4620',
      }),
      '/tmp/manifest.json',
      'http://127.0.0.1:4620',
      { PATH: '/usr/bin:/bin' },
    );
    const first = (env.PATH ?? '').split(':')[0] ?? '';
    expect(first).not.toBe('');
    expect(existsSync(join(first, 'tm8'))).toBe(true);
    // PREPENDED: a stale globally-installed tm8 must not shadow the build this
    // server actually shipped with.
    expect(env.PATH).toContain('/usr/bin:/bin');
    expect(env.PATH?.endsWith('/usr/bin:/bin')).toBe(true);
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

  it('does not inherit unrelated operator secrets into the child environment', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://x', {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://secret',
      TM8_DATABASE_URL: 'postgres://also-secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(env.PATH).toContain('/usr/bin');
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('TM8_DATABASE_URL');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
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
      command: "claude --dangerously-skip-permissions --model 'opus'",
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
    expect(manifest.interactionProfile).toMatchObject({
      profileId: null,
      templateKey: 'tm8.chat.core',
      source: 'core_default',
      pinRevision: 0,
      snapshot: { profile: { source: 'core_default' } },
    });
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
