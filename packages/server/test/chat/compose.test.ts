import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ChatMode } from '@tm8/contract';
import type { Db } from '../../src/db/types.js';
import {
  chatAllowedTools,
  chatSystemPrompt,
  createChatLaunchConfigResolver,
} from '../../src/chat/compose.js';
import type { ChatLaunchConfigInput } from '../../src/chat/runtime.js';

const execFileAsync = promisify(execFile);
const ROOT = '019f0000-0000-7000-8000-000000000401';
const SPACE = '019f0000-0000-7000-8000-000000000402';
const TEAMMATE = '019f0000-0000-7000-8000-000000000403';

function launch(mode: ChatMode, rootMessageId = ROOT): ChatLaunchConfigInput {
  return {
    rootMessageId,
    requesterIdentityId: 'identity-a',
    requesterAuthKind: 'browser',
    teammateId: TEAMMATE,
    model: 'claude-opus-5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    chatMode: mode,
    spaceId: SPACE,
    cwd: '/server/fallback',
    mode: 'new',
  };
}

function fakeDb(workingDir?: string): Db {
  return {
    query: async () => workingDir ? [{ id: 'project-1', working_dir: workingDir, trust: 'trusted' }] : [],
    rpc: async () => ({
      id: 'runtime-session',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      runtime_member_id: 'runtime-member',
      runtime_thread_root_id: ROOT,
    }),
    tx: async () => { throw new Error('not used'); },
    end: async () => undefined,
  } as unknown as Db;
}

describe('chat launch composition', () => {
  it('builds exact provider allow-lists and fails headless ask permissions closed', () => {
    expect(chatAllowedTools('ask')).toContain('mcp__tm8__repo_read_file');
    expect(chatAllowedTools('ask')).not.toContain('mcp__tm8__repo_write');
    expect(chatAllowedTools('plan')).toContain('mcp__tm8__doc_create');
    expect(chatAllowedTools('build')).toContain('mcp__tm8__repo_edit');
    expect(chatAllowedTools('build')).not.toContain('mcp__tm8__repo_bash');
    expect(chatAllowedTools('orchestrate')).toContain('mcp__tm8__session_followup');
    expect(chatAllowedTools('orchestrate')).not.toContain('mcp__tm8__repo_read_file');
  });

  it('puts the stored mode and its authority in the system prompt', () => {
    expect(chatSystemPrompt(launch('ask'), true)).toContain('ASK is read-only');
    expect(chatSystemPrompt(launch('plan'), true)).toContain('Approve → dispatch');
    expect(chatSystemPrompt(launch('build'), true)).toContain('edits are real');
    expect(chatSystemPrompt(launch('orchestrate'), false)).toContain('no repository');
  });

  it('provisions one persistent isolated Git worktree per thread and passes it only through server-owned config', async () => {
    const source = await mkdtemp(join(tmpdir(), 'tm8-chat-source-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'source\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: source });

    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(source), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const first = await resolver(launch('build'));
    expect(first.cwd).toBe(join(dataDir, 'chat', 'worktrees', ROOT));
    expect(first.cwd).not.toBe(source);
    expect(await readFile(join(first.cwd!, 'README.md'), 'utf8')).toBe('source\n');
    expect(JSON.parse(await readFile(first.mcpConfigPath, 'utf8'))).toMatchObject({
      mcpServers: { tm8: { env: { TM8_CHAT_MODE: 'build', TM8_CHAT_PROJECT_ROOT: first.cwd } } },
    });

    const resumed = await resolver({ ...launch('build'), mode: 'resume-after-interrupt' });
    expect(resumed.cwd).toBe(first.cwd);
  });

  it('never falls back to a process directory when project resolution is ambiguous', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const resolved = await resolver(launch('ask'));
    expect(resolved.cwd).toBeUndefined();
    const config = JSON.parse(await readFile(resolved.mcpConfigPath, 'utf8')) as {
      mcpServers: { tm8: { env: Record<string, string> } };
    };
    expect(config.mcpServers.tm8.env.TM8_CHAT_PROJECT_ROOT).toBeUndefined();
    expect(resolved.systemPrompt).toContain('does not have exactly one linked project');
  });
});
