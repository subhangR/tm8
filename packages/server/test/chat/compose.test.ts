import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const CHAT = '019f0000-0000-7000-8000-000000000401';
const SPACE = '019f0000-0000-7000-8000-000000000402';
const TEAMMATE = '019f0000-0000-7000-8000-000000000403';

function launch(mode: ChatMode, chatId = CHAT): ChatLaunchConfigInput {
  return {
    chatId,
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

/**
 * The resolver no longer queries anything; `query` remains only so a
 * reintroduced project lookup has something to hit (and be caught by) rather
 * than throwing an unrelated TypeError.
 */
function fakeDb(): Db {
  return {
    query: async () => [],
    rpc: async () => ({
      id: 'runtime-session',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      runtime_member_id: 'runtime-member',
      runtime_chat_id: CHAT,
    }),
    tx: async () => { throw new Error('not used'); },
    end: async () => undefined,
  } as unknown as Db;
}

describe('chat launch composition', () => {
  const MODES: readonly ChatMode[] = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'];

  it('gives every mode the same native surface and prefers it over duplicate MCP tools', () => {
    for (const mode of MODES) {
      // Every mode sees the SAME built-ins, Bash included. THIS ARRAY IS THE
      // ONLY REAL GATE, which is why it is pinned exactly rather than probed
      // with `.toContain`: `--tools` decides which tools exist at all, and
      // nothing downstream re-narrows it.
      expect([mode, chatProviderToolPolicy(mode).availableTools]).toEqual([mode, [
        'Read', 'Glob', 'Grep', 'Bash',
        'WebFetch', 'WebSearch', 'Edit', 'Write', 'TodoWrite', 'Skill',
      ]]);
      // `allowedTools` IS NOT A PERMISSION BOUNDARY HERE, and the comment this
      // replaces said it was. It read: "Bash is visible but still never
      // pre-approved in this slice — the runtime posture change (dontAsk →
      // bypassPermissions) is a separate slice." That slice already landed.
      // `ClaudeHeadlessAdapter.ts` passes `--permission-mode bypassPermissions`
      // unconditionally, and under that mode `--allowed-tools` is not consulted
      // — the adapter says so itself four lines above the flag ("no interactive
      // approvals, Bash unrestricted, workspace trusted").
      //
      // So the two assertions below pin the SHAPE OF THE LIST WE EMIT, not a
      // restriction on what chat may run. Keeping them is still worth it — an
      // unexpected entry means the composer changed — but read as a safety
      // property they are a green light over a door with no lock, which is
      // exactly how the old comment read them. Review finding F4 on #479.
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

  it('has no project-less tool surface left to fall into', () => {
    // REPLACES 'withholds only the repository half when no trusted project is
    // linked'. That test pinned a second, smaller tool set reached whenever the
    // old inference failed — and on the production node the inference failed
    // for EVERY thread ever started, so the four-tool surface it describes was
    // not a fallback, it was the only surface chat ever had. The human now
    // names the directory, so there is exactly one surface and no branch that
    // can silently select a lesser one.
    //
    // `chatProviderToolPolicy` takes one argument now; the deleted second
    // parameter is why this is a rewrite rather than a deletion. A test that
    // merely stopped asserting the old behaviour would not notice a `hasProject`
    // branch being reintroduced.
    expect(chatProviderToolPolicy.length).toBe(1);
    for (const mode of MODES) {
      const policy = chatProviderToolPolicy(mode);
      expect([mode, policy.availableTools.includes('Read')]).toEqual([mode, true]);
      expect([mode, policy.availableTools.includes('Bash')]).toEqual([mode, true]);
      expect([mode, policy.allowedTools.includes('Read(/**)')]).toEqual([mode, true]);
      expect([mode, policy.allowedTools.includes('Edit(/**)')]).toEqual([mode, true]);
    }
  });

  it('is mode-INDEPENDENT: one prompt for every mode, carrying the guide to all', () => {
    // The launched prompt no longer depends on the thread's mode — a per-turn
    // [mode: X] line selects which guidance applies, which is what lets a mode
    // switch cost no relaunch.
    const base = chatSystemPrompt(launch('ask'));
    for (const mode of MODES) {
      expect([mode, chatSystemPrompt(launch(mode))]).toEqual([mode, base]);
    }
    // The prompt NAMES the directory now instead of describing how it was
    // guessed. The old text ("does not have exactly one trusted linked
    // project…") described an inference the human never made and could not see.
    expect(base).toContain('/server/fallback');
    expect(base).toContain('chosen by the human when this thread started');
    expect(base).toContain('may or may not be a Git repository');
    expect(base).not.toContain('project_unavailable');
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

  it('works in the directory the thread was bound to, and provisions nothing', async () => {
    // REPLACES four tests at once: the clone-provisioning test and the three
    // "runs project-less when ..." tests. All four described the same vanished
    // machinery - infer the Space's one trusted project, test it for a git
    // root, clone it, and degrade quietly when any step failed. The human names
    // the directory now, so there is nothing to infer, nothing to clone, and no
    // degraded path to characterise.
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const bound = await mkdtemp(join(tmpdir(), 'tm8-chat-bound-'));
    await writeFile(join(bound, 'README.md'), 'bound\n', 'utf8');
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const resolved = await resolver({ ...launch('build'), cwd: bound });

    // NO cwd OVERRIDE. The launch config deliberately returns none: the bound
    // path already reached the orchestrator as `turn.cwd`, and returning one
    // here is exactly how the clone used to redirect the runtime AWAY from the
    // directory the thread was bound to. `launch.cwd ?? turn.cwd` therefore
    // resolves to the binding.
    expect(resolved.cwd).toBeUndefined();

    // The confinement root is the bound directory, ALWAYS. This used to be
    // omitted whenever no clone existed, which is why every MCP repo tool on
    // the production node answered `project_unavailable`.
    const config = JSON.parse(await readFile(resolved.mcpConfigPath, 'utf8')) as {
      mcpServers: { tm8: { env: Record<string, string> } };
    };
    expect(config.mcpServers.tm8.env.TM8_CHAT_PROJECT_ROOT).toBe(bound);

    // Full surface in a plain, non-git directory - the case that produced four
    // tools and no filesystem before.
    expect(resolved.availableTools).toContain('Read');
    expect(resolved.availableTools).toContain('Bash');
    expect(resolved.allowedTools).toContain('Edit(/**)');
    expect(resolved.systemPrompt).toContain(bound);

    // Nothing was created beside the config: no clone, no branch, no checkout
    // area. `<dataDir>/chat/checkouts` never existed on the production node and
    // must not start existing now.
    await expect(stat(join(dataDir, 'chat', 'checkouts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(bound, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not read the project tables at all when resolving a launch', async () => {
    // The inference is gone, not merely bypassed. If a future change reaches
    // for "the Space's project" again during launch resolution it will run a
    // query here, and this fails - which is the only way to keep a deleted
    // behaviour deleted.
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const queries: string[] = [];
    const db = {
      ...fakeDb(),
      query: async (_claims: unknown, sql: string) => { queries.push(sql); return []; },
    } as unknown as Db;
    const resolver = createChatLaunchConfigResolver({
      db, dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    await resolver(launch('ask'));
    expect(queries).toEqual([]);
  });

  it('keeps the same bound directory across a post-interrupt resume', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-data-'));
    const bound = await mkdtemp(join(tmpdir(), 'tm8-chat-bound-'));
    const resolver = createChatLaunchConfigResolver({
      db: fakeDb(), dataDir, baseUrl: 'http://127.0.0.1:4610', mcpCliPath: '/tmp/tm8-mcp.js',
    });
    const first = await resolver({ ...launch('build'), cwd: bound });
    const resumed = await resolver({ ...launch('build'), cwd: bound, mode: 'resume-after-interrupt' });
    // Both decline to override, so both resolve to the binding. The credential
    // inside is re-minted on each start; the directory is not re-decided.
    expect([first.cwd, resumed.cwd]).toEqual([undefined, undefined]);
    const config = JSON.parse(await readFile(resumed.mcpConfigPath, 'utf8')) as {
      mcpServers: { tm8: { env: Record<string, string> } };
    };
    expect(config.mcpServers.tm8.env.TM8_CHAT_PROJECT_ROOT).toBe(bound);
  });
});
