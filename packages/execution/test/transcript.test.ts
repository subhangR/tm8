// Agent transcript digest — the pure reader, both dialects.
//
// Each assertion pins one fact that a summary of the native formats would have
// gotten wrong, and that a wrong answer here turns into a coordinator reading a
// confident lie about what its worker is doing:
//   - claude's project directory maps EVERY non-alphanumeric char to `-`, not
//     just `/` (get this wrong and every scratch-session transcript 404s)
//   - codex ownership is proven from a USER turn only (a rollout that merely
//     mentions another session's id in tool output is NOT that session's)
//   - codex token usage is a RUNNING TOTAL (newest wins); claude's is PER TURN
//     (sums) — swap them and the numbers are off by the whole conversation
//   - a missing file is an explained empty, never a throw and never a zero

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeClaudeProjectDir, readSessionTranscript } from '../src/transcript/read-transcript.js';

const temps: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-transcript-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CWD = '/Users/x/.local/share/tm8-data/scratch/019fdc4f';

async function writeClaude(home: string, nativeId: string, lines: unknown[]): Promise<void> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${nativeId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

async function writeCodex(home: string, name: string, lines: unknown[]): Promise<void> {
  const dir = join(home, '.codex', 'sessions', '2026', '08', '07');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'));
}

async function writeCodexConfigDir(configDir: string, name: string, lines: unknown[]): Promise<void> {
  const dir = join(configDir, 'sessions', '2026', '08', '07');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const claudeUser = (at: string, text: string) => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const claudeText = (at: string, text: string) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
  },
});
const claudeTool = (at: string, name: string) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', name, input: {} }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
  },
});
// The record shape that DOMINATES a real claude transcript and that no fixture
// modelled before: a tool result comes back as a `type:'user'` record. It is
// machine output wearing the user's type tag, and counting it as a human turn
// is how a 2-turn conversation reports 32.
const claudeToolResult = (at: string, output: string) => ({
  type: 'user',
  timestamp: at,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: output }],
  },
});

describe('encodeClaudeProjectDir', () => {
  it('maps every non-alphanumeric character, not just the separator', () => {
    // `.local` is the case a `/ → -` rule gets wrong, and it is on the path of
    // every projectless tm8 session.
    expect(encodeClaudeProjectDir('/Users/x/.local/share/tm8')).toBe('-Users-x--local-share-tm8');
  });

  it('ignores a trailing slash so cwd normalization cannot fork the path', () => {
    expect(encodeClaudeProjectDir('/a/b/')).toBe(encodeClaudeProjectDir('/a/b'));
  });
});

describe('readSessionTranscript — honesty contract', () => {
  it('explains a missing native session id rather than returning an empty page', async () => {
    const home = await makeHome();
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('no_native_session_id');
    expect(page.entries).toEqual([]);
  });

  it('explains an unsupported agent tool', async () => {
    const home = await makeHome();
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'echo',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('unsupported_agent_tool');
    expect(page.agentTool).toBeNull();
  });

  it('explains a transcript that has not been written yet', async () => {
    const home = await makeHome();
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'never-written',
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('no_transcript_file');
    expect(page.searchedPaths).toEqual([
      join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD), 'never-written.jsonl'),
    ]);
  });

  it('separates a file it CANNOT read from a file that is not there', async () => {
    // The fourth reason, and the only one nothing exercised. It is not
    // decorative: a permissions or type error on the path must not be reported
    // as "the agent has not written anything yet", because those two want
    // opposite responses from whoever reads the page. Planted as a DIRECTORY
    // where the .jsonl belongs, which is EISDIR — a non-ENOENT errno reached
    // through the real filesystem rather than a stubbed throw.
    const home = await makeHome();
    await mkdir(join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD), 'occupied.jsonl'), {
      recursive: true,
    });
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'occupied',
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('unreadable');
    // An explained empty owes no numbers — a zeroed stats block would claim
    // the agent said nothing, which is a different statement from "I could
    // not read the file".
    expect(page.stats).toBeNull();
    expect(page.stuck).toBeNull();
    expect(page.entries).toEqual([]);
  });
});

describe('readSessionTranscript — claude', () => {
  it('reads prose turns, counts tools, and sums per-turn usage', async () => {
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      claudeUser('2026-08-07T10:00:00.000Z', 'do the thing'),
      claudeTool('2026-08-07T10:00:01.000Z', 'Read'),
      claudeText('2026-08-07T10:00:02.000Z', 'done'),
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
      now: Date.parse('2026-08-07T10:00:03.000Z'),
    });

    expect(page.available).toBe(true);
    expect(page.agentTool).toBe('claude-code');
    expect(page.entries.map((e) => [e.source, e.text])).toEqual([
      ['user', 'do the thing'],
      ['assistant', 'done'],
    ]);
    expect(page.stats.toolCalls).toBe(1);
    expect(page.stats.tools).toEqual([{ name: 'Read', count: 1 }]);
    // Two assistant turns × the per-turn usage above.
    expect(page.stats.outputTokens).toBe(10);
    expect(page.stats.cacheReadTokens).toBe(200);
    expect(page.lastActivityAt).toBe('2026-08-07T10:00:02.000Z');
  });

  it('counts SPEECH turns, not JSONL records — a tool_result is not a human turn', async () => {
    // Measured on a real 4.4 MB transcript before this pin existed: 32 user /
    // 52 assistant reported over a window whose true content was 2 human turns
    // and 12 prose replies, because every tool result is a `type:'user'` record
    // and every tool call is a `type:'assistant'` record with no text block.
    // The stats block renders directly above the entry list, so a record count
    // is a number that contradicts the list printed underneath it.
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      claudeUser('2026-08-07T10:00:00.000Z', 'do the thing'),
      claudeTool('2026-08-07T10:00:01.000Z', 'Read'),
      claudeToolResult('2026-08-07T10:00:02.000Z', 'file contents here'),
      claudeTool('2026-08-07T10:00:03.000Z', 'Bash'),
      claudeToolResult('2026-08-07T10:00:04.000Z', 'command output here'),
      claudeText('2026-08-07T10:00:05.000Z', 'here is what I found'),
      claudeTool('2026-08-07T10:00:06.000Z', 'Edit'),
      claudeToolResult('2026-08-07T10:00:07.000Z', 'edit applied'),
      claudeText('2026-08-07T10:00:08.000Z', 'done'),
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
    });

    // 9 records: 4 are `type:'user'` by tag but only 1 is speech, and 5 are
    // `type:'assistant'` by tag but only 2 carry prose.
    expect(page.stats.userMessages).toBe(1);
    expect(page.stats.assistantMessages).toBe(2);
    // The invariant that makes the stats block honest: the counts sum to the
    // number of entries the same window produced.
    expect(page.stats.userMessages + page.stats.assistantMessages).toBe(page.entries.length);
    expect(page.stats.toolCalls).toBe(3);
  });

  it('excludes sub-agent sidechain turns from the entries', async () => {
    // A single Agent call can emit dozens of sidechain turns and bury the main
    // thread the coordinator actually asked to see.
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      claudeText('2026-08-07T10:00:00.000Z', 'main thread'),
      { ...claudeText('2026-08-07T10:00:01.000Z', 'sub-agent chatter'), isSidechain: true },
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
    });
    expect(page.entries.map((e) => e.text)).toEqual(['main thread']);
  });

  it('does not report a model for claude-fabricated <synthetic> turns', async () => {
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      {
        type: 'assistant',
        timestamp: '2026-08-07T10:00:00.000Z',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] },
      },
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
    });
    expect(page.stats.models).toEqual([]);
  });

  it('truncates a long turn and says so instead of silently clipping', async () => {
    const home = await makeHome();
    await writeClaude(home, 'n1', [claudeText('2026-08-07T10:00:00.000Z', 'a'.repeat(500))]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
      maxChars: 50,
    });
    expect(page.entries[0]?.truncated).toBe(true);
    expect(page.entries[0]?.text.length).toBeLessThanOrEqual(50);
  });

  it('returns the NEWEST `last` turns', async () => {
    const home = await makeHome();
    await writeClaude(
      home,
      'n1',
      Array.from({ length: 10 }, (_, i) =>
        claudeText(`2026-08-07T10:00:0${i}.000Z`, `turn ${i}`),
      ),
    );
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
      last: 3,
    });
    expect(page.entries.map((e) => e.text)).toEqual(['turn 7', 'turn 8', 'turn 9']);
  });

  it('counts an unparseable line instead of failing the whole read', async () => {
    const home = await makeHome();
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'n1.jsonl'),
      [JSON.stringify(claudeText('2026-08-07T10:00:00.000Z', 'ok')), '{ this is not json'].join('\n'),
    );
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(true);
    expect(page.malformed).toBe(1);
    expect(page.entries.map((e) => e.text)).toEqual(['ok']);
  });

  it('flags a worker that has emitted only tool calls for too long', async () => {
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      claudeText('2026-08-07T10:00:00.000Z', 'starting'),
      ...Array.from({ length: 8 }, (_, i) => claudeTool(`2026-08-07T10:00:0${i + 1}.000Z`, 'Bash')),
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
      // Silence is measured against NOW, not the newest record — a worker that
      // stopped writing entirely is exactly the case this exists for.
      now: Date.parse('2026-08-07T10:05:00.000Z'),
    });
    expect(page.stuck?.toolCallsSinceText).toBe(8);
    expect(page.stuck?.silentMs).toBe(300_000);
  });

  it('does not flag a busy worker that is still talking', async () => {
    const home = await makeHome();
    await writeClaude(home, 'n1', [
      ...Array.from({ length: 8 }, (_, i) => claudeTool(`2026-08-07T10:00:0${i}.000Z`, 'Bash')),
      claudeText('2026-08-07T10:00:09.000Z', 'here is what I found'),
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'claude-code',
      nativeSessionId: 'n1',
      cwd: CWD,
      home,
      now: Date.parse('2026-08-07T10:05:00.000Z'),
    });
    expect(page.stuck).toBeNull();
  });
});

describe('readSessionTranscript — codex', () => {
  const meta = (id: string) => ({
    type: 'session_meta',
    timestamp: '2026-08-07T10:00:00.000Z',
    payload: { id, cwd: CWD },
  });
  const userTurn = (at: string, text: string) => ({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  const assistantTurn = (at: string, text: string) => ({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

  it('locates the rollout from the session marker with no native id in the DB', async () => {
    const home = await makeHome();
    await writeCodex(home, 'rollout-a.jsonl', [
      meta('native-a'),
      userTurn('2026-08-07T10:00:01.000Z', 'task <tm8_session_id>s1</tm8_session_id>'),
      assistantTurn('2026-08-07T10:00:02.000Z', 'on it'),
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'codex',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(true);
    expect(page.agentTool).toBe('codex');
    expect(page.entries.map((e) => e.text)).toContain('on it');
  });

  it('reads a rollout from the CODEX_HOME recorded at spawn', async () => {
    const home = await makeHome();
    const configDir = join(home, 'credentials', 'id_member', 'openai');
    await writeCodexConfigDir(configDir, 'rollout-member.jsonl', [
      meta('native-member'),
      userTurn('2026-08-07T10:00:01.000Z', 'task <tm8_session_id>s1</tm8_session_id>'),
      assistantTurn('2026-08-07T10:00:02.000Z', 'member codex transcript'),
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1', agentTool: 'codex', nativeSessionId: null, cwd: CWD, home,
      agentConfigDir: configDir,
    });
    expect(page.available).toBe(true);
    expect(page.entries.map((entry) => entry.text)).toContain('member codex transcript');
  });

  it('refuses a rollout that only MENTIONS the id in tool output', async () => {
    // The exact false positive maestro measured: a coordinator's tool output
    // quotes another session's id, and a whole-file substring match hands back
    // a stranger's conversation.
    const home = await makeHome();
    await writeCodex(home, 'rollout-b.jsonl', [
      meta('native-b'),
      userTurn('2026-08-07T10:00:01.000Z', 'unrelated work'),
      {
        type: 'response_item',
        timestamp: '2026-08-07T10:00:02.000Z',
        payload: { type: 'function_call_output', output: '<tm8_session_id>s1</tm8_session_id>' },
      },
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'codex',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toBe('no_transcript_file');
  });

  it('takes the NEWEST token_count as the total instead of summing', async () => {
    const home = await makeHome();
    await writeCodex(home, 'rollout-c.jsonl', [
      meta('native-c'),
      userTurn('2026-08-07T10:00:01.000Z', 'go <tm8_session_id>s1</tm8_session_id>'),
      {
        type: 'event_msg',
        timestamp: '2026-08-07T10:00:02.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-08-07T10:00:03.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 300, output_tokens: 40 } },
        },
      },
    ]);

    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'codex',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.stats.inputTokens).toBe(300);
    expect(page.stats.outputTokens).toBe(40);
  });

  it('counts SPEECH turns on the same rule as claude, so the field means one thing', async () => {
    // The reader's whole job is to normalise two dialects to one shape. If
    // `userMessages` meant "human turns" here and "human turns plus every tool
    // result" on the claude path, a coordinator comparing two workers would be
    // comparing two different quantities with the same name.
    const home = await makeHome();
    await writeCodex(home, 'rollout-e.jsonl', [
      meta('native-e'),
      // Ownership marker only — an envelope is not speech either, in either
      // dialect, so this record must not be counted as a human turn.
      userTurn('2026-08-07T10:00:01.000Z', '<tm8_session_id>s1</tm8_session_id>'),
      userTurn('2026-08-07T10:00:02.000Z', 'go do the thing'),
      {
        type: 'response_item',
        timestamp: '2026-08-07T10:00:02.000Z',
        payload: { type: 'function_call', name: 'shell', arguments: '{}' },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-07T10:00:03.000Z',
        payload: { type: 'function_call_output', output: 'command output here' },
      },
      assistantTurn('2026-08-07T10:00:04.000Z', 'done'),
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'codex',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.stats.userMessages).toBe(1);
    expect(page.stats.assistantMessages).toBe(1);
    expect(page.stats.userMessages + page.stats.assistantMessages).toBe(page.entries.length);
  });

  it('counts exec tool calls', async () => {
    const home = await makeHome();
    await writeCodex(home, 'rollout-d.jsonl', [
      meta('native-d'),
      userTurn('2026-08-07T10:00:01.000Z', 'go <tm8_session_id>s1</tm8_session_id>'),
      {
        type: 'response_item',
        timestamp: '2026-08-07T10:00:02.000Z',
        payload: { type: 'function_call', name: 'shell', arguments: '{}' },
      },
    ]);
    const page = await readSessionTranscript({
      sessionId: 's1',
      agentTool: 'codex',
      nativeSessionId: null,
      cwd: CWD,
      home,
    });
    expect(page.stats.toolCalls).toBe(1);
    expect(page.stats.tools).toEqual([{ name: 'shell', count: 1 }]);
  });
});
