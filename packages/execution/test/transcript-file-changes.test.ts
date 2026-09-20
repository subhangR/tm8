/**
 * The transcript-derived file-change accounting — the "what did this session
 * change, without a worktree" answer. Driven against a real claude-dialect
 * jsonl written to disk, because the whole feature is a FILE scan.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectFileChanges } from '../src/transcript/file-changes.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tm8-file-changes-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function turn(blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
}
function toolUse(name: string, input: Record<string, unknown>): unknown {
  return { type: 'tool_use', id: 't1', name, input };
}

async function transcript(lines: string[]): Promise<string> {
  const path = join(dir, 'session.jsonl');
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

describe('collectFileChanges', () => {
  it('aggregates Edit and Write per file with exact line counts', async () => {
    const path = await transcript([
      turn([toolUse('Edit', { file_path: '/a/one.ts', old_string: 'x\ny', new_string: 'x\ny\nz' })]),
      turn([{ type: 'text', text: 'thinking' }]),
      turn([toolUse('Write', { file_path: '/a/two.md', content: 'l1\nl2\nl3' })]),
      turn([toolUse('Edit', { file_path: '/a/one.ts', old_string: 'z', new_string: '' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.source).toBe('transcript');
    expect(out.files.map((f) => f.path)).toEqual(['/a/one.ts', '/a/two.md']);
    const one = out.files[0]!;
    expect(one).toMatchObject({ edits: 2, linesAdded: 3, linesRemoved: 3 });
    expect(one.hunks[0]).toMatchObject({ tool: 'edit', linesAdded: 3, linesRemoved: 2, oldText: 'x\ny' });
    const two = out.files[1]!;
    // A Write's prior content is unknown: 0 removed, never an invented count.
    expect(two).toMatchObject({ edits: 1, linesAdded: 3, linesRemoved: 0 });
    expect(out.totalAdded).toBe(6);
    expect(out.totalRemoved).toBe(3);
  });

  it('MultiEdit fans out into one hunk per edit on the same file', async () => {
    const path = await transcript([
      turn([toolUse('MultiEdit', {
        file_path: '/m.ts',
        edits: [
          { old_string: 'a', new_string: 'b\nc' },
          { old_string: 'd\ne\nf', new_string: 'g' },
        ],
      })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.files[0]).toMatchObject({ path: '/m.ts', edits: 2, linesAdded: 3, linesRemoved: 4 });
  });

  it('caps hunk TEXT but keeps counts exact', async () => {
    const big = 'line\n'.repeat(2_000).trim(); // ~10k chars, 2000 lines
    const path = await transcript([
      turn([toolUse('Edit', { file_path: '/big.ts', old_string: big, new_string: 'small' })]),
    ]);
    const out = await collectFileChanges(path);
    const hunk = out.files[0]!.hunks[0]!;
    expect(hunk.oldText).toBeNull();
    expect(hunk.newText).toBe('small');
    expect(hunk.linesRemoved).toBe(2_000);
    expect(out.files[0]!.linesRemoved).toBe(2_000);
  });

  it('ignores non-file tools, malformed lines, and prose', async () => {
    const path = await transcript([
      turn([toolUse('Bash', { command: 'rm -rf /' })]),
      'this line is not json but mentions tool_use',
      turn([{ type: 'text', text: 'tool_use in prose' }]),
      turn([toolUse('Read', { file_path: '/x' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.files).toEqual([]);
    expect(out.totalAdded).toBe(0);
  });

  it('throws on a missing file — the caller owns the unavailable translation', async () => {
    await expect(collectFileChanges(join(dir, 'nope.jsonl'))).rejects.toThrow();
  });
});

/**
 * TURN SCOPING — `lastTurn` and `turns`.
 *
 * A turn is the work following one real user prompt, and "real" is doing the
 * work in that sentence: in claude's dialect a tool RESULT is also a
 * `type:'user'` record, and the harness re-injects a compaction summary as
 * one. Counting either as a prompt breaks the flag in the direction that is
 * hardest to notice — it reports that the agent changed nothing.
 */
describe('collectFileChanges turn scoping', () => {
  function prompt(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }
  function toolResult(): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
  }

  it('flags only the files the most recent turn wrote', async () => {
    const path = await transcript([
      prompt('first ask'),
      turn([toolUse('Write', { file_path: '/a/early.ts', content: 'a\nb' })]),
      prompt('second ask'),
      turn([toolUse('Write', { file_path: '/a/late.ts', content: 'c' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.turns).toBe(3); // turn 1 before any prompt, then two prompts
    const byPath = new Map(out.files.map((f) => [f.path, f]));
    expect(byPath.get('/a/early.ts')!.lastTurn).toBe(false);
    expect(byPath.get('/a/late.ts')!.lastTurn).toBe(true);
  });

  it('keeps counts SESSION-wide while the flag stays turn-scoped', async () => {
    const path = await transcript([
      prompt('one'),
      turn([toolUse('Write', { file_path: '/a/f.ts', content: 'x\ny' })]),
      prompt('two'),
      turn([toolUse('Edit', { file_path: '/a/f.ts', old_string: 'x', new_string: 'X' })]),
    ]);
    const out = await collectFileChanges(path);
    const f = out.files[0]!;
    expect(f.edits).toBe(2);       // both turns counted
    expect(f.lastTurn).toBe(true); // and the latest one was the last turn
  });

  it('does NOT treat a tool result as a turn boundary', async () => {
    // A tool result between an edit and the reply would otherwise open a new
    // turn, making `lastTurn` mean "the final edit" rather than "the turn".
    const path = await transcript([
      prompt('go'),
      turn([toolUse('Write', { file_path: '/a/one.ts', content: 'a' })]),
      toolResult(),
      turn([toolUse('Write', { file_path: '/a/two.ts', content: 'b' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.turns).toBe(2);
    expect(out.files.every((f) => f.lastTurn)).toBe(true);
  });

  it('does NOT treat a compaction summary or a meta record as a prompt', async () => {
    // The trap: a compacted session would report a fresh turn the agent never
    // worked in, so every file would read as untouched by the last turn.
    const path = await transcript([
      prompt('go'),
      turn([toolUse('Write', { file_path: '/a/one.ts', content: 'a' })]),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'meta' }] } }),
    ]);
    const out = await collectFileChanges(path);
    expect(out.turns).toBe(2);
    expect(out.files[0]!.lastTurn).toBe(true);
  });

  it('does NOT treat a sidechain prompt as a boundary of the main session', async () => {
    const path = await transcript([
      prompt('go'),
      turn([toolUse('Write', { file_path: '/a/one.ts', content: 'a' })]),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'sub-agent ask' }] } }),
      turn([toolUse('Write', { file_path: '/a/two.ts', content: 'b' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.turns).toBe(2);
    expect(out.files.every((f) => f.lastTurn)).toBe(true);
  });

  it('calls an unprompted session ONE turn, so its work is its last turn', async () => {
    const path = await transcript([
      turn([toolUse('Write', { file_path: '/a/auto.ts', content: 'a' })]),
    ]);
    const out = await collectFileChanges(path);
    expect(out.turns).toBe(1);
    expect(out.files[0]!.lastTurn).toBe(true);
  });
});
