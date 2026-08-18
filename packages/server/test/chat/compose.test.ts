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
  chatModeLine,
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
  const MODES: readonly ChatMode[] = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'];

  it('gives every mode the same native surface and prefers it over duplicate MCP tools', () => {
    for (const mode of MODES) {
      // Every mode now sees the SAME built-ins, Bash included. Bash is visible
      // but still never pre-approved in this slice — the runtime posture change
      // (dontAsk → bypassPermissions) is a separate slice.
      expect([mode, chatProviderToolPolicy(mode).availableTools]).toEqual([mode, [
        'Read', 'Glob', 'Grep', 'Bash',
        'WebFetch', 'WebSearch', 'Edit', 'Write', 'TodoWrite',
      ]]);
      expect(chatAllowedTools(mode)).not.toContain('Bash');
      expect(chatAllowedTools(mode)).not.toContain('Write(/**)');
      // Claude's built-ins own repo and web; the duplicate MCP tools stay
      // registered as provider-neutral fallbacks but are not pre-approved.
      // (repo_bash is gone entirely — native Bash covers shell.)
      for (const duplicate of [
        'mcp__tm8__repo_read_file', 'mcp__tm8__repo_edit', 'mcp__tm8__web_search',
      ]) {
        expect([mode, duplicate, chatAllowedTools(mode).includes(duplicate)])
          .toEqual([mode, duplicate, false]);
      }
      for (const expected of [
        'Read(/**)', 'WebFetch', 'WebSearch', 'Edit(/**)', 'TodoWrite',
        'mcp__tm8__tm8_read', 'mcp__tm8__tm8_act', 'mcp__tm8__tm8_delegate',
        'mcp__tm8__doc_create', 'mcp__tm8__memory_write', 'mcp__tm8__git_diff',
        'mcp__tm8__session_followup', 'mcp__tm8__repo_multi_edit',
        // The inline presentation tools are now pre-approved in EVERY mode,
        // not just Explain.
        'mcp__tm8__explain_diagram',
      ]) {
        expect([mode, expected, chatAllowedTools(mode).includes(expected)])
          .toEqual([mode, expected, true]);
      }
    }
  });

  it('withholds only the repository half when no trusted project is linked', () => {
    for (const mode of MODES) {
      expect([mode, chatProviderToolPolicy(mode, false).availableTools])
        .toEqual([mode, ['WebFetch', 'WebSearch', 'TodoWrite']]);
      expect(chatProviderToolPolicy(mode, false).allowedTools).not.toContain('Read(/**)');
      expect(chatProviderToolPolicy(mode, false).allowedTools).not.toContain('Edit(/**)');
    }
  });

  it('is mode-INDEPENDENT: one prompt for every mode, carrying the guide to all', () => {
    // The launched prompt no longer depends on the thread's mode — a per-turn
    // [mode: X] line selects which guidance applies, which is what lets a mode
    // switch cost no relaunch.
    const base = chatSystemPrompt(launch('ask'), true);
    for (const mode of MODES) {
      expect([mode, chatSystemPrompt(launch(mode), true)]).toEqual([mode, base]);
    }
    // The shared rules and the per-turn mode mechanism.
    expect(base).toContain('every mode carries the full tool surface');
    expect(base).toContain('[mode: <name>]');
    expect(base).toContain('Having a tool is not a reason to use it');
    // Every mode's guidance is present, in every prompt.
    expect(base).toContain('ASK answers the question');
    expect(base).toContain('explain_diagram for Mermaid');
    expect(base).toContain('basis="persisted"');
    expect(base).toContain('Approve → dispatch');
    expect(base).toContain('edits are real writes');
    expect(base).toContain('ORCHESTRATE coordinates');
    expect(base).toContain('CRAFT sketches a blueprint');
    expect(base).toContain('Materialize nothing until approval lands in this thread');
    expect(base).toContain('One guarded patch per turn');
    // No variant denies a capability the mode now has.
    expect(/it may not|it has no|Do not mutate anything/.test(base)).toBe(false);
  });

  it('names the per-turn mode with chatModeLine', () => {
    expect(chatModeLine('plan')).toBe('[mode: plan]');
    expect(chatModeLine('ask')).toBe('[mode: ask]');
    expect(chatModeLine('craft')).toBe('[mode: craft]');
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
    expect(resolved.availableTools).toEqual(['WebFetch', 'WebSearch', 'TodoWrite']);
    expect(resolved.allowedTools).not.toContain('Read(/**)');
  });

  it('runs project-less instead of failing the turn when the linked project is not a Git checkout', async () => {
    // The prod shape this came from: a trusted project whose working_dir is a
    // plain workspace directory holding several checkouts. `git rev-parse
    // --show-toplevel` exits non-zero there, and that used to reject out of
    // launch resolution and kill every turn in the Space with a raw
    // "Command failed: git -C … rev-parse --show-toplevel".
    const source = await mkdtemp(join(tmpdir(), 'tm8-chat-source-'));
    await writeFile(join(source, 'README.md'), 'not a repo\n', 'utf8');
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(source), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const resolved = await resolver(launch('build'));
    expect(resolved.cwd).toBeUndefined();
    const config = JSON.parse(await readFile(resolved.mcpConfigPath, 'utf8')) as {
      mcpServers: { tm8: { env: Record<string, string> } };
    };
    expect(config.mcpServers.tm8.env.TM8_CHAT_PROJECT_ROOT).toBeUndefined();
    expect(resolved.availableTools).toEqual(['WebFetch', 'WebSearch', 'TodoWrite']);
    expect(resolved.systemPrompt).toContain('is a Git checkout');
  });

  it('runs project-less when the linked project working_dir does not exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(join(dataDir, 'gone')), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const resolved = await resolver(launch('ask'));
    expect(resolved.cwd).toBeUndefined();
    expect(resolved.availableTools).toEqual(['WebFetch', 'WebSearch', 'TodoWrite']);
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
