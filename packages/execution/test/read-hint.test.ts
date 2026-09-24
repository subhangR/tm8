// The lane read-hint hook (token-efficiency #3). Pins the hook's contract —
// hints only above the threshold on repository reads, dedupes, fails open,
// names graphify only when the graph exists — by running the real script the
// way Claude Code does (JSON on stdin), and pins how the spawn path installs
// it: one `--settings` object shared with the harness-surface plugin list.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  resolveLaunchConfig,
  withAgentResume,
  type ResolvedLaunchConfig,
} from '../src/spawn/manifest.js';
import { readHintHookPath } from '../src/spawn/harness-surface.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const HOOK = readHintHookPath();
const BIG = 'x'.repeat(6001);
const SMALL = 'x'.repeat(6000);

let dir: string;
let stateDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm8-read-hint-'));
  stateDir = join(dir, 'state');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bash(command: string, stdout: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: 's-1',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
    ...extra,
  };
}

/** Runs the hook as Claude Code does; returns the hint text or null. */
function run(input: unknown, env: Record<string, string> = {}): string | null {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, TM8_READ_HINT_STATE_DIR: stateDir, ...env },
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  expect(res.stderr).toBe('');
  if (res.stdout === '') return null;
  const out = JSON.parse(res.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  // Only ever additionalContext: no decision, no block, no rewritten output.
  expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}

describe('read-hint hook', () => {
  it('hints on a large repository read, cheaply', () => {
    const hint = run(bash('cd x && sed -n 1,900p packages/a.ts | head -n 900', BIG));
    expect(hint).toContain('6.0k chars');
    expect(hint).toContain('sed -n X,Yp');
    expect(hint!.length).toBeLessThanOrEqual(250);
  });

  it('stays silent at or below the threshold', () => {
    expect(run(bash('cat packages/a.ts', SMALL))).toBeNull();
  });

  it('stays silent on non-read commands, even large ones', () => {
    expect(run(bash('bun test | tail -200', BIG))).toBeNull();
    expect(run(bash('git diff origin/main', BIG))).toBeNull();
    expect(run({ ...bash('cat a', BIG), tool_name: 'Edit' })).toBeNull();
  });

  it('covers Read by file content size, and says offset/limit', () => {
    const read = {
      session_id: 's-1',
      cwd: dir,
      tool_name: 'Read',
      tool_input: { file_path: '/repo/big.ts' },
      tool_response: { type: 'text', file: { filePath: '/repo/big.ts', content: BIG } },
    };
    expect(run(read)).toContain('Read offset+limit');
    expect(run({ ...read, tool_input: { file_path: '/repo/img.png' }, tool_response: { type: 'image', file: {} } })).toBeNull();
  });

  it('dedupes per target and backs off after three hints per session', () => {
    expect(run(bash('cat a.ts', BIG))).not.toBeNull();
    expect(run(bash('cat a.ts', BIG))).toBeNull();
    expect(run(bash('grep -rn foo b/', BIG))).not.toBeNull();
    expect(run(bash('sed -n 1,500p c.ts', BIG))).not.toBeNull();
    expect(run(bash('sed -n 1,500p d.ts', BIG))).toBeNull();
    // A different session has its own budget.
    expect(run(bash('sed -n 1,500p d.ts', BIG, { session_id: 's-2' }))).not.toBeNull();
  });

  it('names graphify only when the graph exists in the lane cwd', async () => {
    expect(run(bash('cat a.ts', BIG))).not.toContain('graphify');
    await mkdir(join(dir, 'graphify-out'));
    await writeFile(join(dir, 'graphify-out', 'merged-graph.json'), '{}');
    const hint = run(bash('cat b.ts', BIG));
    expect(hint).toContain('graphify affected|explain|path');
    expect(hint).toContain('--graph graphify-out/merged-graph.json');
    expect(hint!.length).toBeLessThanOrEqual(250);
  });

  it('fails open: garbage input or unwritable state means silence, exit 0', async () => {
    expect(run('not json')).toBeNull();
    expect(run('')).toBeNull();
    expect(run({ tool_name: 'Bash' })).toBeNull();
    const blocker = join(dir, 'a-file');
    await writeFile(blocker, '');
    expect(run(bash('cat a.ts', BIG), { TM8_READ_HINT_STATE_DIR: join(blocker, 'state') })).toBeNull();
  });
});

const LAUNCH: ResolvedLaunchConfig = {
  mode: 'worker',
  model: 'opus',
  agentTool: 'claude-code',
  permissionMode: 'acceptEdits',
  accessMode: 'acceptEdits',
  reasoningEffort: null,
  credentialSource: null,
  credentialSources: { anthropic: 'node', openai: 'node', github: 'node' },
};
const HOOKS = {
  PostToolUse: [
    { matcher: 'Bash|Read', hooks: [{ type: 'command', command: `node '${HOOK}'`, timeout: 5 }] },
  ],
};

function settingsOf(cmd: string): unknown {
  const m = /--settings '(.*?)'(?: |$)/.exec(cmd.replace(/'\\''/g, "'"));
  return m ? JSON.parse(m[1]) : null;
}

function context(capabilities: Record<string, unknown> = {}): SpawnContext {
  return {
    spaceId: 'space-1',
    project: null,
    teamMember: {
      id: 'tm-1', name: 'Draco', role: 'r', identity: 'i', memories: [], model: 'opus', agentTool: null,
      mode: 'worker', permissionMode: null, avatar: null, capabilities, commandPermissions: {},
    },
    tasks: [],
  };
}
const REQUEST: SpawnRequest = { spaceId: 'space-1', teamMemberId: 'tm-1' };

describe('read-hint spawn settings', () => {
  it('resolveLaunchConfig leaves read hints OFF by default — the hook ships dark', () => {
    expect(resolveLaunchConfig(REQUEST, context(), {}).readHints).toBe(false);
    // Not a Claude lane at all: off however loudly it is asked for.
    expect(
      resolveLaunchConfig(
        { ...REQUEST, agentTool: 'codex' },
        context({ launch: { readHints: true } }),
        { TM8_READ_HINTS: 'on' },
      ).readHints,
    ).toBe(false);
  });

  it('persona and the node-wide A/B switch turn them on, env first', () => {
    expect(resolveLaunchConfig(REQUEST, context({ launch: { readHints: true } }), {}).readHints).toBe(true);
    expect(resolveLaunchConfig(REQUEST, context(), { TM8_READ_HINTS: 'on' }).readHints).toBe(true);
    expect(
      resolveLaunchConfig(REQUEST, context({ launch: { readHints: true } }), { TM8_READ_HINTS: 'off' }).readHints,
    ).toBe(false);
  });

  it('pins the full lane argv: ONE --settings carrying plugins and the hook', () => {
    const cmd = buildAgentCommand({ ...LAUNCH, readHints: true }, {}, {
      claudeSessionId: 'uuid-1',
      installedClaudePlugins: ['sales@synced'],
    });
    expect(cmd.match(/--settings/g)).toHaveLength(1);
    expect(settingsOf(cmd)).toEqual({ enabledPlugins: { 'sales@synced': false }, hooks: HOOKS });
    expect(cmd).toBe(
      "claude --permission-mode acceptEdits --model 'opus' --session-id 'uuid-1' " +
        `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '` +
        JSON.stringify({ enabledPlugins: { 'sales@synced': false }, hooks: HOOKS }).replace(/'/g, `'\\''`) +
        "'",
    );
  });

  it('installs the hook under inherit too, and nothing when off', () => {
    const inherit = buildAgentCommand({ ...LAUNCH, harnessSurface: 'inherit', readHints: true }, {}, {
      installedClaudePlugins: ['sales@synced'],
    });
    expect(settingsOf(inherit)).toEqual({ hooks: HOOKS });
    expect(inherit).not.toContain('--strict-mcp-config');
    expect(buildAgentCommand({ ...LAUNCH, readHints: false })).not.toContain('--settings');
  });

  it('survives resume', () => {
    const base = buildAgentCommand({ ...LAUNCH, readHints: true });
    const resumed = withAgentResume(base, '<sys/>', LAUNCH, 'uuid-9', {});
    expect(resumed.startsWith(base)).toBe(true);
    expect(settingsOf(resumed)).toEqual({ hooks: HOOKS });
  });
});
