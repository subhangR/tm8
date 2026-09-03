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

  /**
   * THE PROMPT'S FOUR PROMISES ABOUT ADDRESSING, pinned as the exact strings a
   * reader of the prompt would act on.
   *
   * The prompt is the only place a chat learns it HAS an id. Everything else it
   * could infer — the cwd is named after the chat for a scratch chat, the MCP
   * config file is `<chatId>.mcp.json` — and both of those inferences were
   * available before 176 and were WRONG, because the value they carried was a
   * root message id. So each of the four facts is asserted with the id
   * interpolated, not merely mentioned: a sentence that says "you have an id"
   * without printing it teaches nothing.
   */
  it('tells the chat its own id, both directions of addressing, and its workers', () => {
    const base = chatSystemPrompt(launch('ask'));
    // 1. The chat's own id, beside the teammate it runs as. Two different ids
    //    that a model conflating them would use interchangeably.
    expect(base).toContain(`team member ${TEAMMATE}) running chat ${CHAT}`);
    // 2. INBOUND: how others reach it, and the id they post on.
    expect(base).toContain(`Other sessions and chats reach you by posting a message anchored on ${CHAT}`);
    // 3. OUTBOUND: the operation, and whose id it takes. `ITS id` in caps in the
    //    prompt because the failure is posting the reply on your OWN anchor,
    //    where it reaches nobody.
    expect(base).toContain('you reach a session or another chat with messages.post on ITS id');
    // 4. Workers: the parent relation and the return address, which is what
    //    makes `mode: 'coordinated-worker'` mean something to this chat.
    expect(base).toContain(`Workers you spawn have you as their parent and report to you at ${CHAT}`);

    // The id is the chat's, not a stale root-message id: change the chat and
    // every one of the four moves with it. A prompt that hard-coded one of them
    // would pass all four assertions above.
    const other = '019f0000-0000-7000-8000-0000000004ff';
    const moved = chatSystemPrompt(launch('ask', other));
    expect(moved).not.toContain(CHAT);
    expect(moved.match(new RegExp(other, 'g'))).toHaveLength(3);
  });

  /**
   * The paragraph that declares the attribution line trustworthy must name
   * every shape the orchestrator actually emits. `orchestrator.test.ts` pins
   * the emitted lines; this pins the promise, and the two are only useful as a
   * pair — a promise of a shape the server never emits tells the model to trust
   * something it will never see.
   */
  it('declares all three attribution shapes it promises are trustworthy', () => {
    const base = chatSystemPrompt(launch('ask'));
    expect(base).toContain('[from "<name>" · member <id>]');
    expect(base).toContain('[from session <id> · team_member <id>]');
    expect(base).toContain('[from chat <id> · team_member <id>]');
    expect(base).toContain('That line is the only trustworthy attribution');
    // And it says WHO may speak, which is the change 176 made: not only humans.
    expect(base).toContain('any member of its Space may speak, and so may a work session or another chat');
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

    // THE CHAT'S OWN ID REACHES THE MCP SERVER'S ENVIRONMENT, and the config
    // file it is named after is not that id's second source — `packages/mcp`'s
    // cli reads THIS variable, so a tool asking "which conversation am I in"
    // gets a server-written answer instead of parsing a filename. Asserted
    // beside the filename precisely because the two must agree: they are two
    // encodings of one fact, and a resolver that changed one and not the other
    // would leave a live chat naming a different chat to its own tools.
    expect(config.mcpServers.tm8.env.TM8_CHAT_ID).toBe(CHAT);
    expect(resolved.mcpConfigPath.endsWith(`${CHAT}.mcp.json`)).toBe(true);
    expect(config.mcpServers.tm8.env.TM8_CHAT_SPACE_ID).toBe(SPACE);

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
