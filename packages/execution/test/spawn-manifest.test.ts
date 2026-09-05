// Precedence, cwd resolution and command building — the parts of the spawn
// flow that are pure functions, and therefore the parts where a regression is
// cheap to catch and expensive to notice in production.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentToolForModel,
  buildAgentCommand,
  buildCodexArgs,
  CODEX_LOOPBACK_CONFIG_OVERRIDES,
  composeEnv,
  composeManifest,
  resolveCommandNetworkPolicy,
  resolveCoordinatorKind,
  resolveCoordinatorSessionId,
  resolveLaunchConfig,
  resolveWorkdir,
  supportsPositionalPrompt,
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
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'preserves Astra effort %s during launch resolution', (reasoningEffort) => {
      expect(resolveLaunchConfig({ ...base, reasoningEffort }, context({ model: 'gpt-6-astra' }), {}))
        .toMatchObject({ model: 'gpt-6-astra', agentTool: 'codex', reasoningEffort });
    },
  );
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

  it('uses explicit access over the node override, then persona/default posture', () => {
    expect(resolveLaunchConfig(base, context({ permissionMode: 'readOnly' }), {}).permissionMode).toBe(
      'readOnly',
    );
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'readOnly' }), {
        TM8_PERMISSION_MODE: 'bypassPermissions',
      }).permissionMode,
    ).toBe('bypassPermissions');
    const explicit = resolveLaunchConfig(
      { ...base, accessMode: 'plan', reasoningEffort: 'low' },
      context({ permissionMode: 'bypassPermissions' }),
      { TM8_PERMISSION_MODE: 'bypassPermissions' },
    );
    expect(explicit).toMatchObject({
      permissionMode: 'readOnly',
      accessMode: 'plan',
      reasoningEffort: 'low',
    });
  });

  /**
   * Every tm8 session is unattended, so the posture nothing named must be one
   * that does not stop to ask. `acceptEdits` frees edits and nothing else — the
   * agent still blocked on its first Bash approval with no human at the PTY.
   */
  it('defaults to auto when neither the request, the node nor the persona names a posture', () => {
    const resolved = resolveLaunchConfig(base, context(), {});
    expect(resolved).toMatchObject({ permissionMode: 'auto', accessMode: 'auto' });
    expect(buildAgentCommand(resolved, {})).toContain('--permission-mode auto');
  });

  it('lets a request pin auto explicitly, over a persona that says otherwise', () => {
    expect(
      resolveLaunchConfig({ ...base, accessMode: 'auto' }, context({ permissionMode: 'readOnly' }), {})
        .permissionMode,
    ).toBe('auto');
  });

  /**
   * The dispatcher link, which is the only one that outranks the request.
   * A resident dispatcher has no human at its PTY and does its whole job
   * through shell commands, so any prompting posture parks it silently while
   * it still reports `running`.
   */
  it('always launches a dispatcher with bypass, whoever asked for what', () => {
    const parked = { accessMode: 'plan' as const, permissionMode: 'readOnly' as const };
    for (const resolved of [
      resolveLaunchConfig({ ...base, mode: 'dispatcher' }, context(), {}),
      resolveLaunchConfig(base, context({ mode: 'dispatcher', permissionMode: 'readOnly' }), {}),
      resolveLaunchConfig(
        { ...base, mode: 'dispatcher', accessMode: 'plan' },
        context({ permissionMode: 'readOnly' }),
        { TM8_PERMISSION_MODE: 'interactive' },
        parked,
      ),
    ]) {
      expect(resolved).toMatchObject({
        mode: 'dispatcher',
        permissionMode: 'bypassPermissions',
        accessMode: 'fullAccess',
      });
    }
    // Control: the same inputs on any other mode still resolve down the chain.
    expect(
      resolveLaunchConfig({ ...base, accessMode: 'plan' }, context(), {}, parked).permissionMode,
    ).toBe('readOnly');
  });

  it('ignores permission and mode values that are not in the enum', () => {
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'yolo' }), {}).permissionMode,
    ).toBe('auto');
    expect(resolveLaunchConfig(base, context({ mode: 'nonsense' as never }), {}).mode).toBe('worker');
  });

  /**
   * The inherited link. A child spawned by a session nobody is watching must
   * not quietly drop to a posture that stops and asks — that is the stall this
   * link exists to remove.
   */
  it('inherits the spawning session posture over the persona default', () => {
    const resolved = resolveLaunchConfig(base, context({ permissionMode: 'interactive' }), {}, {
      accessMode: 'fullAccess',
      permissionMode: 'bypassPermissions',
    });
    expect(resolved).toMatchObject({
      permissionMode: 'bypassPermissions',
      accessMode: 'fullAccess',
    });
    expect(buildAgentCommand(resolved, {})).toContain('--dangerously-skip-permissions');
  });

  it('inherits a RESTRICTIVE parent posture just as faithfully', () => {
    // Inheritance is not a synonym for bypass: a parent launched in plan mode
    // hands its children plan mode, even when the persona asks for more.
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'bypassPermissions' }), {}, {
        accessMode: 'plan',
        permissionMode: 'readOnly',
      }),
    ).toMatchObject({ permissionMode: 'readOnly', accessMode: 'plan' });
  });

  it('lets the request and the node override outrank what a parent held', () => {
    const parent = { accessMode: 'fullAccess' as const, permissionMode: 'bypassPermissions' as const };
    expect(
      resolveLaunchConfig({ ...base, accessMode: 'safe' }, context(), {}, parent).permissionMode,
    ).toBe('interactive');
    expect(
      resolveLaunchConfig(base, context(), { TM8_PERMISSION_MODE: 'readOnly' }, parent).permissionMode,
    ).toBe('readOnly');
  });

  it('reconstructs an inherited posture from permissionMode alone', () => {
    // A manifest written before `accessMode` existed still names the posture,
    // just in the other half of the bijection.
    expect(
      resolveLaunchConfig(base, context(), {}, { accessMode: null, permissionMode: 'bypassPermissions' })
        .accessMode,
    ).toBe('fullAccess');
  });

  it('ignores an unrecognised inherited posture instead of launching on it', () => {
    expect(
      resolveLaunchConfig(base, context({ permissionMode: 'readOnly' }), {}, {
        accessMode: 'yolo' as never,
        permissionMode: 'yolo' as never,
      }),
    ).toMatchObject({ permissionMode: 'readOnly', accessMode: 'plan' });
  });

  it('has nothing to inherit for a root spawn', () => {
    expect(resolveLaunchConfig(base, context(), {}, null).permissionMode).toBe('auto');
    expect(
      resolveLaunchConfig(base, context(), {}, { accessMode: null, permissionMode: null })
        .permissionMode,
    ).toBe('auto');
  });

  /**
   * `credentialSource` rides the same precedence chain as the posture: the
   * request outranks what a parent held, and absence means auto — the
   * pre-field behaviour, byte for byte. The values are narrowed rather than
   * trusted because the inherited half comes out of a stored JSON manifest.
   */
  it('resolves credentialSource from the request, then the parent posture, then auto', () => {
    expect(resolveLaunchConfig(base, context(), {}).credentialSource).toBeNull();
    expect(
      resolveLaunchConfig({ ...base, credentialSource: 'member' }, context(), {}).credentialSource,
    ).toBe('member');
    // A child of a 'node'-credentialed session inherits that choice…
    expect(
      resolveLaunchConfig(base, context(), {}, {
        accessMode: null,
        permissionMode: null,
        credentialSource: 'node',
      }).credentialSource,
    ).toBe('node');
    // …unless the request says otherwise.
    expect(
      resolveLaunchConfig({ ...base, credentialSource: 'member' }, context(), {}, {
        accessMode: null,
        permissionMode: null,
        credentialSource: 'node',
      }).credentialSource,
    ).toBe('member');
  });

  it('ignores an unrecognised stored credentialSource instead of launching on it', () => {
    expect(
      resolveLaunchConfig(base, context(), {}, {
        accessMode: null,
        permissionMode: null,
        credentialSource: 'somebody-else' as never,
      }).credentialSource,
    ).toBeNull();
  });

  it('resolves each provider credential source independently and keeps legacy fallback', () => {
    expect(resolveLaunchConfig(base, context(), {}).credentialSources).toEqual({
      anthropic: null,
      openai: null,
      gemini: null,
      hermes: null,
      cursor: null,
      github: null,
    });

    expect(resolveLaunchConfig({
      ...base,
      credentialSources: {
        anthropic: 'node',
        github: 'member',
        gemini: 'member',
        cursor: 'node',
      },
    }, context(), {}).credentialSources).toEqual({
      anthropic: 'node',
      openai: null,
      gemini: 'member',
      hermes: null,
      cursor: 'node',
      github: 'member',
    });

    // A new provider-specific choice overrides only its own legacy/global arm.
    expect(resolveLaunchConfig({
      ...base,
      credentialSource: 'node',
      credentialSources: { github: 'member' },
    }, context(), {}).credentialSources).toEqual({
      anthropic: 'node',
      openai: 'node',
      gemini: 'node',
      hermes: 'node',
      cursor: 'node',
      github: 'member',
    });

    // Existing manifests remain inheritable: their one source fans out only
    // when no provider-specific value exists.
    expect(resolveLaunchConfig(base, context(), {}, {
      accessMode: null,
      permissionMode: null,
      credentialSource: 'member',
      credentialSources: { github: 'node' },
    }).credentialSources).toEqual({
      anthropic: 'member',
      openai: 'member',
      gemini: 'member',
      hermes: 'member',
      cursor: 'member',
      github: 'node',
    });
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

  /**
   * THE FOURTH COMBINATION, which used to be the only unguarded one.
   *
   * `scratch` with a project throws. `worktree` without a project throws.
   * `project` WITHOUT a project fell through to the projectless return and came
   * back as `.../scratch/pending` — while still reporting `mode: 'project'`.
   * Nothing failed, so the session spawned, the row recorded `project`, and the
   * agent ran in a scratch directory instead of the repository it was asked for.
   *
   * The operator's report was "my sessions are not starting from /root/strykr".
   */
  it('refuses project mode when there is no project, rather than silently using scratch', () => {
    const ctx = context();
    ctx.project = null;
    const request = { ...base, workdir: { mode: 'project' as const } };

    expect(() => resolveWorkdir(request, ctx, opts)).toThrow(/"project" requires a project/);
  });

  it('leaves the DEFAULT untouched, which is why the guard is safe to add', () => {
    // An unspecified mode already resolves to `project` only when one exists, so
    // a caller that simply does not know is unaffected by the guard above. Only
    // a caller explicitly asking for a project it does not have now fails.
    const ctx = context();
    ctx.project = null;
    expect(() => resolveWorkdir(base, ctx, opts)).not.toThrow();
    expect(resolveWorkdir(base, ctx, opts).mode).toBe('scratch');

    const withProject = context();
    expect(resolveWorkdir(base, withProject, opts).mode).toBe('project');
    expect(resolveWorkdir(base, withProject, opts).path).toBe('/tmp/tm8-fixture');
  });
});

describe('buildAgentCommand', () => {
  const launch = {
    mode: 'worker' as const,
    model: 'opus',
    agentTool: 'claude-code',
    permissionMode: 'acceptEdits' as const,
    accessMode: 'acceptEdits' as const,
    reasoningEffort: null,
  };

  it('resolves the built-in echo agent to a runnable node command', () => {
    const cmd = buildAgentCommand(launch, { TM8_AGENT_CMD: 'echo-agent' });
    expect(cmd).toMatch(/^node '.*harness\/echo-agent\.mjs'$/);
  });

  it('maps the resolved access posture to Claude flags without escalating it', () => {
    expect(buildAgentCommand(launch, {})).toBe(
      "claude --permission-mode acceptEdits --model 'opus'",
    );
    // `auto` is a real Claude mode, passed through rather than approximated —
    // approximating it upward would be a silent escalation, downward a hang.
    expect(buildAgentCommand({ ...launch, permissionMode: 'auto' }, {})).toBe(
      "claude --permission-mode auto --model 'opus'",
    );
    expect(
      buildAgentCommand({ ...launch, permissionMode: 'bypassPermissions' }, {}),
    ).toBe("claude --dangerously-skip-permissions --model 'opus'");
  });

  it('honours restrictive Claude access and provider reasoning effort', () => {
    expect(buildAgentCommand({ ...launch, permissionMode: 'readOnly' }, {})).toBe(
      "claude --permission-mode plan --model 'opus'",
    );
    expect(buildAgentCommand({ ...launch, reasoningEffort: 'low' }, {})).toBe(
      "claude --permission-mode acceptEdits --model 'opus' --effort low",
    );
  });

  it('quotes the 1M-context suffix so the shell cannot glob it away', () => {
    // `claude-opus-5[1m]` is a real catalog id and `[1m]` is a shell character
    // class: unquoted it expands to `1` or `m` if such a file exists in the
    // workdir, and the agent silently starts on the wrong model.
    expect(buildAgentCommand({ ...launch, model: 'claude-opus-5[1m]' }, {})).toBe(
      "claude --permission-mode acceptEdits --model 'claude-opus-5[1m]'",
    );
  });

  it('appends the composed system prompt for claude, shell-quoted', () => {
    const base = buildAgentCommand(launch, {});
    const prompt = "<tm8_system_prompt>it's \"quoted\"\nand multiline</tm8_system_prompt>";
    const cmd = withAgentPrompt(base, { system: prompt, task: '' }, launch, {});
    expect(cmd.startsWith(base)).toBe(true);
    expect(cmd).toContain('--append-system-prompt');
    // POSIX single-quote escaping: the embedded apostrophe MUST be broken out,
    // or the shell terminates the argument early and the agent boots with a
    // truncated briefing (or the command fails outright).
    expect(cmd).toContain(`'\\''`);
  });

  /**
   * THE REGRESSION THIS FILE DID NOT CATCH. Every assertion above passed while
   * the task prompt was being concatenated into `--append-system-prompt` and no
   * positional argument was emitted, which left every real agent idle at an
   * interactive REPL. `toContain('--append-system-prompt')` cannot see that; the
   * shape of the argv TAIL is what matters, so it is pinned here.
   */
  it('sends the task prompt as the positional first user turn, after every flag', () => {
    const base = buildAgentCommand(launch, {});
    const cmd = withAgentPrompt(base, { system: 'SYS', task: '<tm8_task_prompt/>' }, launch, {});
    expect(cmd).toBe(`${base} --append-system-prompt 'SYS' '<tm8_task_prompt/>'`);
    // A positional is what makes both CLIs run once instead of waiting for input,
    // so it must be LAST — both stop parsing options at the first non-option arg.
    expect(cmd.endsWith(`'<tm8_task_prompt/>'`)).toBe(true);

    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5-codex' };
    const codexCmd = withAgentPrompt(
      buildAgentCommand(codexLaunch, {}),
      { system: 'SYS', task: 'TASK' },
      codexLaunch,
      {},
    );
    expect(codexCmd).toContain('developer_instructions=');
    expect(codexCmd.endsWith(`'TASK'`)).toBe(true);
    // The system prompt must NOT carry the task: that was the bug.
    expect(codexCmd).toContain(`developer_instructions="SYS"`);
  });

  it('uses Codex developer_instructions and leaves complete operator wrappers unchanged', () => {
    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5-codex' };
    const codex = buildAgentCommand(codexLaunch, {});
    expect(codex).toContain("codex --model 'gpt-5-codex'");
    expect(
      withAgentPrompt(codex, { system: 'PROMPT', task: '' }, codexLaunch, {}),
    ).toContain('developer_instructions=');
    const echo = buildAgentCommand(launch, { TM8_AGENT_CMD: 'echo-agent' });
    expect(
      withAgentPrompt(echo, { system: 'PROMPT', task: 'TASK' }, launch, { TM8_AGENT_CMD: 'echo-agent' }),
    ).toBe(echo);
    // An operator wrapper gets NEITHER flag NOR a bare positional: tm8 cannot
    // know whether the wrapper would read it as a prompt or as a path.
    expect(
      withAgentPrompt('my-agent', { system: 'PROMPT', task: 'TASK' }, launch, { TM8_AGENT_CMD: 'my-agent' }),
    ).toBe('my-agent');
  });

  /**
   * `supportsPositionalPrompt` is what SpawnService consults to decide whether
   * it still has to hand the first turn to the PTY. If it and `withAgentPrompt`
   * ever disagreed, the assignment would be delivered twice (duplicate first
   * turn) or not at all (the empty-session bug) — so they are pinned together,
   * against the same launches, here.
   */
  it('agrees with withAgentPrompt about which launches carry the task in argv', () => {
    const codexLaunch = { ...launch, agentTool: 'codex' as const, model: 'gpt-5-codex' };
    const cases = [
      { launch, env: {}, positional: true },
      { launch: codexLaunch, env: {}, positional: true },
      { launch, env: { TM8_AGENT_CMD: 'echo-agent' }, positional: false },
      { launch, env: { TM8_AGENT_CMD: 'my-agent' }, positional: false },
    ];
    for (const { launch: l, env, positional } of cases) {
      expect(supportsPositionalPrompt(l, env)).toBe(positional);
      const base = buildAgentCommand(l, env);
      const embedded = withAgentPrompt(base, { system: 'SYS', task: 'TASK' }, l, env);
      // "Carries the task in argv" is exactly "the command grew a 'TASK' tail".
      expect(embedded.endsWith(`'TASK'`)).toBe(positional);
    }
  });

  /**
   * Codex used to get `--model` and nothing else — no approval policy, no
   * sandbox — so a launched Codex stopped at its first approval request with no
   * human at the terminal. Same unattended-hang class as Claude's, which this
   * file already pins via `--dangerously-skip-permissions`.
   */
  it('gives codex an approval policy and a sandbox so it cannot hang unattended', () => {
    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5-codex' };
    const bypass = buildAgentCommand({ ...codexLaunch, permissionMode: 'bypassPermissions' }, {});
    expect(bypass).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(bypass).not.toContain('--ask-for-approval');

    const accept = buildAgentCommand({ ...codexLaunch, permissionMode: 'acceptEdits' }, {});
    expect(accept).toContain('--ask-for-approval never');
    expect(accept).toContain('--sandbox workspace-write');
    for (const override of CODEX_LOOPBACK_CONFIG_OVERRIDES) {
      expect(accept).toContain(`-c '${override}'`);
    }

    const readOnly = buildAgentCommand({ ...codexLaunch, permissionMode: 'readOnly' }, {});
    // Codex's legacy read-only sandbox cannot enable command networking. tm8
    // plan authorization is prompt-enforced while the runtime stays on
    // workspace-write so the graph remains reachable.
    expect(readOnly).toContain('--sandbox workspace-write');
    expect(readOnly).toContain('sandbox_workspace_write.network_access=true');

    // `auto` is Claude's word and Codex has no equivalent. It must NOT become
    // `on-request`, which asks — and nobody is here to answer. tm8's default
    // posture therefore lands codex exactly where it landed before auto existed.
    const auto = buildAgentCommand({ ...codexLaunch, permissionMode: 'auto' }, {});
    expect(auto).toContain('--ask-for-approval never');
    expect(auto).toContain('--sandbox workspace-write');

    const low = buildAgentCommand({ ...codexLaunch, reasoningEffort: 'low' }, {});
    expect(low).toContain(`-c 'model_reasoning_effort="low"'`);

    // Server-hosted PTY rendered into a browser xterm: Codex must stay inline,
    // or a reconnecting client replays a redrawn alternate screen as garbage.
    expect(accept).toContain('--no-alt-screen');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'passes Astra effort %s to Codex', (reasoningEffort) => {
      const command = buildAgentCommand({ ...launch, agentTool: 'codex', model: 'gpt-6-astra', reasoningEffort }, {});
      expect(command).toContain("--model 'gpt-6-astra'");
      expect(command).toContain(`-c 'model_reasoning_effort="${reasoningEffort}"'`);
    },
  );

  it('builds the exact Codex argv for every posture before shell joining', () => {
    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5.6-sol' };
    expect(CODEX_LOOPBACK_CONFIG_OVERRIDES).toEqual([
      'sandbox_workspace_write.network_access=true',
      'features.network_proxy.enabled=true',
      'features.network_proxy.domains={"127.0.0.1"="allow", "localhost"="allow"}',
      'features.network_proxy.allow_local_binding=false',
    ]);
    const loopback = CODEX_LOOPBACK_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]);
    const expected = (approval: 'never' | 'untrusted') => [
      '--model',
      'gpt-5.6-sol',
      '--ask-for-approval',
      approval,
      '--sandbox',
      'workspace-write',
      ...loopback,
      '--no-alt-screen',
    ];

    expect(buildCodexArgs({ ...codexLaunch, permissionMode: 'auto' })).toEqual(
      expected('never'),
    );
    expect(buildCodexArgs({ ...codexLaunch, permissionMode: 'acceptEdits' })).toEqual(
      expected('never'),
    );
    expect(buildCodexArgs({ ...codexLaunch, permissionMode: 'interactive' })).toEqual(
      expected('untrusted'),
    );
    expect(buildCodexArgs({ ...codexLaunch, permissionMode: 'readOnly' })).toEqual(
      expected('untrusted'),
    );
    expect(buildCodexArgs({ ...codexLaunch, permissionMode: 'bypassPermissions' })).toEqual([
      '--model',
      'gpt-5.6-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ]);
  });

  it('resolves command networking independently from filesystem and approval posture', () => {
    const codexLaunch = { ...launch, agentTool: 'codex', model: 'gpt-5.6-sol' };
    for (const permissionMode of ['auto', 'acceptEdits', 'interactive', 'readOnly'] as const) {
      expect(resolveCommandNetworkPolicy({ ...codexLaunch, permissionMode }, {})).toEqual({
        mode: 'loopback-proxy',
        commandNetworkAccess: true,
        proxyEnabled: true,
        allowedHosts: ['127.0.0.1', 'localhost'],
        portScoped: false,
      });
    }
    expect(
      resolveCommandNetworkPolicy(
        { ...codexLaunch, permissionMode: 'bypassPermissions' },
        {},
      ),
    ).toMatchObject({ mode: 'full-access', proxyEnabled: false });
    expect(
      resolveCommandNetworkPolicy(codexLaunch, { TM8_AGENT_CMD: 'company-codex-wrapper' }),
    ).toMatchObject({ mode: 'operator-defined', commandNetworkAccess: null });
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
    expect(withAgentPrompt(base, { system: '   ', task: '  ' }, launch, {})).toBe(base);
    // Each half is independently omittable — a whitespace-only task must not
    // become an empty positional, which both CLIs would read as an empty prompt.
    expect(withAgentPrompt(base, { system: 'SYS', task: '   ' }, launch, {})).toBe(
      `${base} --append-system-prompt 'SYS'`,
    );
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
    // server actually shipped with. The inherited PATH must survive INTACT and
    // in order — agent-binary fallbacks may follow it, but nothing may reorder
    // or drop what the operator already had.
    expect(env.PATH).toContain('/usr/bin:/bin');
    const segments = (env.PATH ?? '').split(':');
    expect(segments.indexOf('/usr/bin')).toBeLessThan(segments.indexOf('/bin'));
    expect(segments.indexOf('/usr/bin')).toBe(1);
  });

  /**
   * The launchd bug. tm8-server run as a macOS service gets
   * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, but `claude` lives in
   * `/opt/homebrew/bin` and `codex` in `~/.local/bin`, so every launch from the
   * UI died with `exitCode 127` while the same request against a hand-started
   * server in a login shell succeeded. Launch must not depend on who started
   * the server.
   */
  it('adds the standard agent install dirs to PATH without disturbing the inherited order', () => {
    const manifest = composeManifest({
      sessionId: 's-path2',
      request: { spaceId: 'space-1', teamMemberId: 'tm-1' } as SpawnRequest,
      context: context(),
      launch,
      workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
      command: 'claude',
      baseUrl: 'http://127.0.0.1:4620',
    });
    const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4620', {
      PATH: launchdPath,
      HOME: '/Users/nobody-xyz',
    });
    const segments = (env.PATH ?? '').split(':');
    // The inherited PATH stays contiguous and in order at the front (after the
    // prepended tm8 bin dir): additions are FALLBACKS, not a reordering.
    expect(env.PATH).toContain(launchdPath);
    // Whatever of the candidate list exists on this machine is appended AFTER
    // the inherited entries — never before, or tm8 would silently override a
    // resolution the machine's owner arranged.
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
      if (existsSync(dir)) {
        expect(segments.indexOf(dir)).toBeGreaterThan(segments.indexOf('/sbin'));
      }
    }
    // A directory that does not exist is never added — PATH stays meaningful as
    // evidence in exit diagnostics and in the manifest's env record.
    expect(env.PATH).not.toContain('/Users/nobody-xyz/.local/bin');
    // Idempotent: an entry already present is not duplicated.
    const homebrewCount = segments.filter((s) => s === '/opt/homebrew/bin').length;
    expect(homebrewCount).toBeLessThanOrEqual(1);
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

  it('sets the session and exact persona variables in the boot contract', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', {});
    expect(env.TM8_SESSION_ID).toBe('sess-1');
    expect(env.TM8_MANIFEST_PATH).toBe('/tmp/m.json');
    expect(env.TM8_BASE_URL).toBe('http://127.0.0.1:4610');
    expect(env).not.toHaveProperty('NODE_USE_ENV_PROXY');
  });

  it('enables Node proxy support only for a sandboxed Codex loopback launch', () => {
    const codexLaunch = {
      mode: 'worker' as const,
      model: 'gpt-5.6-sol',
      agentTool: 'codex',
      permissionMode: 'acceptEdits' as const,
      accessMode: 'acceptEdits' as const,
      reasoningEffort: null,
    };
    const codexManifest = composeManifest({
      sessionId: 'sess-proxy-env',
      request: base,
      context: context(),
      launch: codexLaunch,
      commandNetwork: resolveCommandNetworkPolicy(codexLaunch, {}),
      workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
      command: buildAgentCommand(codexLaunch, {}),
      baseUrl: 'http://127.0.0.1:4610',
    });
    expect(composeEnv(codexManifest, '/tmp/m.json', 'http://x', {}).NODE_USE_ENV_PROXY).toBe(
      '1',
    );
  });

  it('injects TM8_JOURNAL_PATH when a journal path is given', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', {}, '/data/journals/sess-1.jsonl');
    expect(env.TM8_JOURNAL_PATH).toBe('/data/journals/sess-1.jsonl');
  });

  it('OMITS TM8_JOURNAL_PATH when none is given — the var IS the feature gate', () => {
    // A CLI that never sees this variable journals nothing at all, which is
    // exactly right for a human running `tm8` at their own terminal.
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', {});
    expect('TM8_JOURNAL_PATH' in env).toBe(false);
  });

  it('uses only the explicitly minted session credential and never inherits one', () => {
    const inherited = composeEnv(manifest, '/tmp/m.json', 'http://x', {
      TM8_AGENT_TOKEN: 'operator-token-must-not-cross',
    });
    expect(inherited).not.toHaveProperty('TM8_AGENT_TOKEN');

    const minted = composeEnv(
      manifest,
      '/tmp/m.json',
      'http://x',
      { TM8_AGENT_TOKEN: 'operator-token-must-not-cross' },
      undefined,
      'tm8s_auth-session.session-secret',
    );
    expect(minted.TM8_AGENT_TOKEN).toBe('tm8s_auth-session.session-secret');
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
  it('requires and preserves the parent return route for coordinated modes', () => {
    expect(resolveCoordinatorSessionId('coordinated-worker', ' coord-session-1 ')).toBe(
      'coord-session-1',
    );
    expect(resolveCoordinatorSessionId('worker', 'coord-session-1')).toBeNull();
    expect(() => resolveCoordinatorSessionId('coordinated-worker', null)).toThrow(
      /requires parentSessionId/,
    );
  });

  /**
   * 176 — the parent of a coordinated worker may be a CHAT.
   *
   * `resolveCoordinatorSessionId` stays a string by design: the id and what it
   * names are two facts, and the kind arrives on the SpawnContext because a
   * spawn's parent is graph state the loader reads, not something the caller
   * asserts about someone else's row.
   */
  describe('the coordinator kind (176)', () => {
    const coordinated = {
      sessionId: 'sess-chat-parent',
      request: { ...base, parentSessionId: 'chat-1' },
      launch: {
        mode: 'coordinated-worker' as const,
        model: 'opus',
        agentTool: 'claude-code',
        permissionMode: 'bypassPermissions' as const,
      },
      workdir: { mode: 'project' as const, path: '/tmp/tm8-fixture' },
      command: "claude --model 'opus'",
      baseUrl: 'http://127.0.0.1:4610',
    };

    it('carries a chat parent through to the manifest coordinator block', () => {
      const manifest = composeManifest({
        ...coordinated,
        context: { ...context(), parentKind: 'chat' },
      });
      expect(manifest.coordinator).toEqual({ sessionId: 'chat-1', kind: 'chat' });
    });

    it('reads a parent the loader could not resolve as the pre-176 meaning', () => {
      // Never a refused launch and never a blank: the return ADDRESS is what a
      // coordinated mode requires, and that guard is resolveCoordinatorSessionId's.
      for (const parentKind of [undefined, null] as const) {
        const manifest = composeManifest({
          ...coordinated,
          context: { ...context(), parentKind },
        });
        expect(manifest.coordinator).toEqual({
          sessionId: 'chat-1',
          kind: 'work_session',
        });
      }
    });

    it('emits no coordinator at all for an uncoordinated mode, chat parent or not', () => {
      const manifest = composeManifest({
        ...coordinated,
        launch: { ...coordinated.launch, mode: 'worker' },
        context: { ...context(), parentKind: 'chat' },
      });
      expect(manifest.coordinator).toBeNull();
    });

    it('folds an unrecognised parent kind rather than passing it through', () => {
      expect(resolveCoordinatorKind('chat')).toBe('chat');
      expect(resolveCoordinatorKind('work_session')).toBe('work_session');
      expect(resolveCoordinatorKind(null)).toBe('work_session');
      expect(resolveCoordinatorKind(undefined)).toBe('work_session');
      expect(resolveCoordinatorKind('channel' as never)).toBe('work_session');
    });
  });

  it('persists the effective Codex command-network policy separately from posture', () => {
    const codexLaunch = {
      mode: 'worker' as const,
      model: 'gpt-5.6-sol',
      agentTool: 'codex',
      permissionMode: 'acceptEdits' as const,
      accessMode: 'acceptEdits' as const,
      reasoningEffort: null,
    };
    const manifest = composeManifest({
      sessionId: 'sess-network',
      request: base,
      context: context(),
      launch: codexLaunch,
      commandNetwork: resolveCommandNetworkPolicy(codexLaunch, {}),
      workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
      command: buildAgentCommand(codexLaunch, {}),
      baseUrl: 'http://127.0.0.1:7778',
    });

    expect(manifest.launch.commandNetwork).toEqual({
      mode: 'loopback-proxy',
      commandNetworkAccess: true,
      proxyEnabled: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      portScoped: false,
    });
    expect(JSON.stringify(manifest)).not.toContain('TM8_AGENT_TOKEN');
  });

  it('carries the persona, the resolved posture and the server-computed cwd', () => {
    const manifest = composeManifest({
      sessionId: 'sess-2',
      request: {
        ...base,
        parentSessionId: 'coord-session-1',
        promptExtra: '  focus on the seam  ',
      },
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
    expect(manifest.coordinator).toEqual({
      sessionId: 'coord-session-1',
      kind: 'work_session',
    });
    expect(manifest.launch.permissionMode).toBe('bypassPermissions');
    expect(manifest.launch.commandNetwork).toEqual({
      mode: 'provider-default',
      commandNetworkAccess: null,
      proxyEnabled: false,
      allowedHosts: [],
      portScoped: false,
    });
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
        version: 1,
        title: 'wire the prompt seam',
        description: '',
        priority: 'high',
        status: 'open',
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
