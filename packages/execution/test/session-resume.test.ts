// Session resume — the pure parts: the resume command builder and the Codex
// rollout-identity extraction. Both are ports of maestro's proven behavior,
// and each assertion below pins one of the facts that made maestro's resume
// correct (no task re-send, no --last, ownership only from a user message).

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  withAgentResume,
  type ResolvedLaunchConfig,
} from '../src/spawn/manifest.js';
import {
  extractCodexRolloutIdentity,
  resolveCodexNativeSessionId,
} from '../src/spawn/native-session.js';
import { SpawnError } from '../src/spawn/types.js';

const CLAUDE_LAUNCH: ResolvedLaunchConfig = {
  mode: 'worker',
  model: 'claude-opus-5',
  agentTool: 'claude-code',
  permissionMode: 'acceptEdits',
  accessMode: 'acceptEdits',
  reasoningEffort: null,
};

const CODEX_LAUNCH: ResolvedLaunchConfig = {
  ...CLAUDE_LAUNCH,
  model: 'gpt-5.6-sol',
  agentTool: 'codex',
};

const ENV = {} as NodeJS.ProcessEnv;

describe('claude pre-mint (--session-id at spawn)', () => {
  it('appends --session-id when a pre-minted id is supplied', () => {
    const cmd = buildAgentCommand(CLAUDE_LAUNCH, ENV, { claudeSessionId: 'uuid-1234' });
    expect(cmd).toContain("--session-id 'uuid-1234'");
  });

  it('emits no --session-id without one, and never for codex', () => {
    expect(buildAgentCommand(CLAUDE_LAUNCH, ENV)).not.toContain('--session-id');
    expect(buildAgentCommand(CODEX_LAUNCH, ENV, { claudeSessionId: 'uuid-1234' })).not.toContain(
      '--session-id',
    );
  });
});

describe('withAgentResume', () => {
  it('claude: base config + system prompt + --resume <id>, and NO positional task', () => {
    const base = buildAgentCommand(CLAUDE_LAUNCH, ENV);
    const cmd = withAgentResume(base, '<sys/>', CLAUDE_LAUNCH, 'uuid-1234', ENV);
    expect(cmd.startsWith(base)).toBe(true);
    expect(cmd).toContain("--append-system-prompt '<sys/>'");
    expect(cmd.endsWith("--resume 'uuid-1234'")).toBe(true);
    // The restored conversation already holds the task turn; re-sending it
    // duplicates the assignment. Nothing after the flags.
    expect(cmd).not.toContain('--continue');
  });

  it('codex: `resume` subcommand before the flags, rollout id positional LAST, never --last', () => {
    const base = buildAgentCommand(CODEX_LAUNCH, ENV);
    const cmd = withAgentResume(base, '<sys/>', CODEX_LAUNCH, 'rollout-9', ENV);
    expect(cmd.startsWith('codex resume ')).toBe(true);
    expect(cmd).toContain('developer_instructions');
    expect(cmd.endsWith("'rollout-9'")).toBe(true);
    expect(cmd).not.toContain('--last');
  });

  it('refuses an operator wrapper and tools with no resume contract', () => {
    expect(() =>
      withAgentResume('wrapped', '<sys/>', CLAUDE_LAUNCH, 'id', {
        TM8_AGENT_CMD: '/opt/mine/agent',
      } as NodeJS.ProcessEnv),
    ).toThrowError(SpawnError);
    expect(() =>
      withAgentResume('gemini', '<sys/>', { ...CLAUDE_LAUNCH, agentTool: 'gemini' }, 'id', ENV),
    ).toThrowError(SpawnError);
  });
});

// --- codex rollout identity ---------------------------------------------------

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const MARKER = `<tm8_session_id>${SESSION}</tm8_session_id>`;

const meta = (id: string, cwd: string, timestamp: string): string =>
  JSON.stringify({ timestamp, type: 'session_meta', payload: { id, cwd, timestamp } });
const userTurn = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
const toolOutput = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', output: text },
  });

describe('extractCodexRolloutIdentity', () => {
  it('pairs session_meta with a marker-bearing USER message', () => {
    const head = [meta('rollout-1', '/w', '2026-07-31T09:00:00Z'), userTurn(`task…\n${MARKER}`)].join('\n');
    expect(extractCodexRolloutIdentity(head, SESSION)).toEqual({
      nativeSessionId: 'rollout-1',
      cwd: '/w',
      timestamp: '2026-07-31T09:00:00Z',
    });
  });

  it('never accepts ownership from tool output — the measured false-positive class', () => {
    const head = [meta('rollout-2', '/w', '2026-07-31T09:00:00Z'), toolOutput(`spawned ${MARKER}`)].join('\n');
    expect(extractCodexRolloutIdentity(head, SESSION)).toBeNull();
  });

  it('survives a truncated final line and unknown record shapes', () => {
    const head =
      ['{"noise":true}', meta('rollout-3', '/w', 't'), userTurn(MARKER)].join('\n') +
      '\n{"type":"resp';
    expect(extractCodexRolloutIdentity(head, SESSION)?.nativeSessionId).toBe('rollout-3');
  });

  it('returns null when meta or ownership is missing', () => {
    expect(extractCodexRolloutIdentity(userTurn(MARKER), SESSION)).toBeNull();
    expect(extractCodexRolloutIdentity(meta('rollout-4', '/w', 't'), SESSION)).toBeNull();
  });
});

describe('resolveCodexNativeSessionId', () => {
  let home: string;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('walks ~/.codex/sessions, proves ownership, and prefers cwd match then newest', async () => {
    home = await mkdtemp(join(tmpdir(), 'tm8-resume-'));
    const day = join(home, '.codex', 'sessions', '2026', '07', '31');
    await mkdir(day, { recursive: true });
    // An unrelated rollout that MENTIONS the session id in tool output only.
    await writeFile(
      join(day, 'other.jsonl'),
      [meta('rollout-other', '/w', '2026-07-31T12:00:00Z'), toolOutput(MARKER)].join('\n'),
    );
    // Two owning rollouts (a session resumed once writes a continuation): the
    // newer one, in the right cwd, must win.
    await writeFile(
      join(day, 'first.jsonl'),
      [meta('rollout-old', '/w', '2026-07-31T09:00:00Z'), userTurn(MARKER)].join('\n'),
    );
    await writeFile(
      join(day, 'second.jsonl'),
      [meta('rollout-new', '/w', '2026-07-31T11:00:00Z'), userTurn(MARKER)].join('\n'),
    );

    await expect(
      resolveCodexNativeSessionId({ home, tm8SessionId: SESSION, cwd: '/w' }),
    ).resolves.toBe('rollout-new');
  });

  it('fails closed: no sessions dir, or no provable owner, is null', async () => {
    home = await mkdtemp(join(tmpdir(), 'tm8-resume-'));
    await expect(
      resolveCodexNativeSessionId({ home, tm8SessionId: SESSION, cwd: '/w' }),
    ).resolves.toBeNull();
  });
});
