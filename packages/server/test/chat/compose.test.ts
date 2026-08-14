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
  chatProviderToolPolicy,
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

function fakeDb(workingDir?: string, trust = 'trusted'): Db {
  return {
    query: async () => workingDir ? [{ id: 'project-1', working_dir: workingDir, trust }] : [],
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
  it('prefers Claude native repo/web tools and keeps TM8-specific MCP tools', () => {
    expect(chatProviderToolPolicy('ask').availableTools).toEqual([
      'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
    ]);
    expect(chatAllowedTools('ask')).toContain('Read(/**)');
    expect(chatAllowedTools('ask')).not.toContain('Glob');
    expect(chatAllowedTools('ask')).not.toContain('Grep');
    expect(chatAllowedTools('ask')).not.toContain('mcp__tm8__repo_read_file');
    expect(chatAllowedTools('ask')).not.toContain('mcp__tm8__repo_write');
    expect(chatAllowedTools('plan')).toContain('mcp__tm8__doc_create');
    expect(chatProviderToolPolicy('plan').availableTools).toContain('TodoWrite');
    expect(chatProviderToolPolicy('build').availableTools).toContain('Edit');
    expect(chatAllowedTools('build')).toContain('Edit(/**)');
    expect(chatAllowedTools('build')).not.toContain('Write(/**)');
    expect(chatAllowedTools('build')).not.toContain('Bash');
    expect(chatAllowedTools('build')).not.toContain('mcp__tm8__repo_edit');
    expect(chatAllowedTools('build')).not.toContain('mcp__tm8__repo_bash');
    expect(chatAllowedTools('orchestrate')).toContain('mcp__tm8__session_followup');
    expect(chatAllowedTools('orchestrate')).not.toContain('mcp__tm8__repo_read_file');
    expect(chatProviderToolPolicy('orchestrate').availableTools).toEqual([]);
  });

  it('puts the stored mode and its authority in the system prompt', () => {
    expect(chatSystemPrompt(launch('ask'), true)).toContain('ASK is read-only');
    expect(chatSystemPrompt(launch('plan'), true)).toContain('Approve → dispatch');
    expect(chatSystemPrompt(launch('build'), true)).toContain('edits are real');
    expect(chatSystemPrompt(launch('orchestrate'), false)).toContain('no repository');
  });

  it('provisions one persistent isolated Git clone per thread without mutating or running hooks in the source', async () => {
    const source = await mkdtemp(join(tmpdir(), 'tm8-chat-source-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const hookMarker = join(dataDir, 'source-hook-ran');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'source\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: source });
    await execFileAsync('git', [
      'remote', 'add', 'origin', 'https://token:secret@github.com/subhangR/tm8.git',
    ], { cwd: source });
    await writeFile(
      join(source, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nprintf unsafe > '${hookMarker}'\n`,
      { encoding: 'utf8', mode: 0o755 },
    );

    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(source), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const first = await resolver(launch('build'));
    expect(first.cwd).toBe(join(dataDir, 'chat', 'checkouts', ROOT));
    expect(first.cwd).not.toBe(source);
    expect(await readFile(join(first.cwd!, 'README.md'), 'utf8')).toBe('source\n');
    expect((await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: first.cwd })).stdout.trim())
      .toBe('https://github.com/subhangR/tm8.git');
    await expect(readFile(hookMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(execFileAsync('git', ['show-ref', '--verify', `refs/heads/tm8/chat/${ROOT}`], { cwd: source })).rejects.toBeDefined();
    expect(JSON.parse(await readFile(first.mcpConfigPath, 'utf8'))).toMatchObject({
      mcpServers: { tm8: { env: {
        TM8_CHAT_MODE: 'build', TM8_CHAT_PROJECT_ROOT: first.cwd, TM8_CHAT_SPACE_ID: SPACE,
        TM8_CHAT_HIDDEN_TOOLS: expect.stringContaining('repo_read_file'),
      } } },
    });
    expect(first.availableTools).toContain('Edit');
    expect(first.allowedTools).toContain('Edit(/**)');

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
    expect(resolved.systemPrompt).toContain('does not have exactly one trusted linked project');
    expect(resolved.availableTools).toEqual(['WebFetch', 'WebSearch']);
    expect(resolved.allowedTools).not.toContain('Read(/**)');
  });

  it('refuses repository provisioning for an untrusted linked project', async () => {
    const source = await mkdtemp(join(tmpdir(), 'tm8-chat-source-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(source, 'untrusted'), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const resolved = await resolver(launch('ask'));
    expect(resolved.cwd).toBeUndefined();
    expect(resolved.systemPrompt).toContain('trusted linked project');
  });
});
