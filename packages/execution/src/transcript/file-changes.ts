/**
 * WHAT DID THIS SESSION CHANGE — without a worktree.
 *
 * Git cannot attribute edits in a shared tree (many writers, one index), but
 * the agent's own transcript records every Edit/Write tool call it made, with
 * the file path and the exact old/new text. This module parses the WHOLE
 * transcript (not the tail window `readSessionTranscript` uses — a session's
 * first edit is as much its work as its last) and aggregates per-file counts
 * plus capped hunk text for rendering.
 *
 * HONESTY BOUNDARIES, carried in the DTO rather than assumed by the reader:
 *   * `source: 'transcript'` — this is what the harness OBSERVED the agent
 *     write through its tools, not a git diff. Shell-made changes (`sed`, a
 *     script, `git checkout`) are invisible to tool-call parsing, and a later
 *     session may have rewritten the same lines.
 *   * Counts are EXACT even when hunk text is dropped by the cap — a count
 *     without its text is honest; text silently truncated mid-hunk is not.
 *   * A `Write` reports its full content as added lines and 0 removed: the
 *     prior file content is unknown to the transcript, and inventing a
 *     removal count would be a claim with nothing behind it.
 *   * Sidechain (sub-agent) edits are INCLUDED: a file changed by a session's
 *     sub-agent was changed by that session's run.
 *   * `lastTurn` marks the files the agent's MOST RECENT turn wrote, where a
 *     turn is the work following one real user prompt. It can be a false
 *     NEGATIVE — a shell-made change in that same turn is invisible here, as
 *     above — so it is evidence a file WAS touched and never evidence that it
 *     was not.
 *
 * Claude-code dialect only for now. Codex records patches as `apply_patch`
 * argument text in a different envelope; until that parser exists the caller
 * gets `null`, never a half-answer.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SessionFileChange, SessionFileChanges, SessionFileHunk } from '@tm8/contract';

/** Per-side hunk text cap. Counts stay exact when text is dropped. */
const HUNK_TEXT_CAP = 4_000;
const MAX_HUNKS_PER_FILE = 20;
const MAX_FILES = 200;

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

function capText(text: string): string | null {
  return text.length > HUNK_TEXT_CAP ? null : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface Accumulator {
  change: SessionFileChange;
  /** The turn number that last wrote this file; compared to the final one at EOF. */
  lastEpoch: number;
}

function addHunk(
  byPath: Map<string, Accumulator>,
  order: string[],
  path: string,
  hunk: SessionFileHunk,
  epoch: number,
): void {
  let acc = byPath.get(path);
  if (acc === undefined) {
    acc = {
      change: { path, edits: 0, linesAdded: 0, linesRemoved: 0, hunks: [], hunksTruncated: false, lastTurn: false },
      lastEpoch: epoch,
    };
    byPath.set(path, acc);
    order.push(path);
  }
  acc.lastEpoch = epoch;
  acc.change.edits += 1;
  acc.change.linesAdded += hunk.linesAdded;
  acc.change.linesRemoved += hunk.linesRemoved;
  if (acc.change.hunks.length < MAX_HUNKS_PER_FILE) acc.change.hunks.push(hunk);
  else acc.change.hunksTruncated = true;
}

/** One tool_use block → zero or more hunks on its file. */
function hunksOf(name: string, input: Record<string, unknown>): { path: string; hunk: SessionFileHunk }[] {
  const path = typeof input.file_path === 'string' ? input.file_path : null;
  if (path === null) return [];

  if (name === 'Edit') {
    const oldText = typeof input.old_string === 'string' ? input.old_string : '';
    const newText = typeof input.new_string === 'string' ? input.new_string : '';
    return [{
      path,
      hunk: {
        tool: 'edit',
        linesAdded: lineCount(newText),
        linesRemoved: lineCount(oldText),
        oldText: capText(oldText),
        newText: capText(newText),
      },
    }];
  }
  if (name === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    return [{
      path,
      hunk: {
        tool: 'write',
        linesAdded: lineCount(content),
        // The prior content is unknown to the transcript; 0 is the only
        // removal count that is not invented.
        linesRemoved: 0,
        oldText: null,
        newText: capText(content),
      },
    }];
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.flatMap((e) => {
      const edit = asRecord(e);
      if (edit === null) return [];
      const oldText = typeof edit.old_string === 'string' ? edit.old_string : '';
      const newText = typeof edit.new_string === 'string' ? edit.new_string : '';
      return [{
        path,
        hunk: {
          tool: 'multiedit' as const,
          linesAdded: lineCount(newText),
          linesRemoved: lineCount(oldText),
          oldText: capText(oldText),
          newText: capText(newText),
        },
      }];
    });
  }
  if (name === 'NotebookEdit') {
    const source = typeof input.new_source === 'string' ? input.new_source : '';
    return [{
      path,
      hunk: {
        tool: 'notebook',
        linesAdded: lineCount(source),
        linesRemoved: 0,
        oldText: null,
        newText: capText(source),
      },
    }];
  }
  return [];
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Stream the whole claude-code transcript at `path` and aggregate observed
 * file changes. Throws on I/O errors — the CALLER owns the unavailable
 * translation, exactly like `readSessionTranscript`'s tail read.
 */
export async function collectFileChanges(path: string): Promise<SessionFileChanges> {
  const byPath = new Map<string, Accumulator>();
  const order: string[] = [];
  let filesTruncated = false;

  /*
   * TURN NUMBERING. `epoch` starts at 1 and advances on every real user
   * prompt, so the work before anyone has replied is turn 1 — an autonomous
   * run nobody prompted twice is one whole turn, and every file it touched is
   * correctly its last turn's.
   *
   * A PROMPT IS NARROWER THAN A `user` RECORD, and the exclusions are the
   * substance of this, not tidying:
   *   · a tool RESULT arrives as a `type:'user'` record in claude's dialect,
   *     so counting user records would start a new turn between an agent's
   *     own tool call and its answer — every edit would land in a turn of its
   *     own and `lastTurn` would mean "the final edit", not "the final turn";
   *   · the harness re-injects a COMPACTION SUMMARY as a user turn. Counting
   *     it would open a fresh turn the agent never worked in, and a panel
   *     reading `lastTurn` would report that the agent changed nothing —
   *     wrong precisely when a long session is most worth reviewing;
   *   · a SIDECHAIN prompt is a sub-agent's, not the operator's. Its edits
   *     belong to the turn that spawned it, which is where they already land.
   * This is the same definition `transcript/session-usage` counts prompts by.
   */
  let epoch = 1;

  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // The cheap pre-filter now has to admit prompt lines too, which carry no
      // `tool_use`. It OVER-admits (any line mentioning "user" is parsed) and
      // that is the safe direction: under-admitting would drop a turn boundary
      // and silently widen `lastTurn` to cover work from earlier turns.
      if (line.trim() === '' || (!line.includes('tool_use') && !line.includes('user'))) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // The transcript reader counts malformed lines; here a line that does
        // not parse simply cannot name a file change.
        continue;
      }
      const record = asRecord(parsed);
      const message = asRecord(record?.message);
      const content = message?.content;

      if (record?.type === 'user') {
        if (record.isSidechain === true || record.isCompactSummary === true || record.isMeta === true) continue;
        const isToolResult = Array.isArray(content)
          && content.some((b) => asRecord(b)?.type === 'tool_result');
        if (!isToolResult) epoch += 1;
        continue;
      }

      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = asRecord(block);
        if (b?.type !== 'tool_use') continue;
        const name = typeof b.name === 'string' ? b.name : '';
        if (!FILE_TOOLS.has(name)) continue;
        const input = asRecord(b.input);
        if (input === null) continue;
        for (const { path: filePath, hunk } of hunksOf(name, input)) {
          if (!byPath.has(filePath) && byPath.size >= MAX_FILES) {
            filesTruncated = true;
            continue;
          }
          addHunk(byPath, order, filePath, hunk, epoch);
        }
      }
    }
  } finally {
    rl.close();
  }

  /*
   * `lastTurn` is resolved HERE, against the epoch the scan ended on, not
   * while scanning. Mid-scan there is no way to know which turn is the last
   * one — a file flagged when it was written would keep the flag through
   * every turn that followed it.
   */
  const files = order.map((p) => {
    const acc = byPath.get(p)!;
    acc.change.lastTurn = acc.lastEpoch === epoch;
    return acc.change;
  });
  return {
    files,
    totalAdded: files.reduce((n, f) => n + f.linesAdded, 0),
    totalRemoved: files.reduce((n, f) => n + f.linesRemoved, 0),
    filesTruncated,
    source: 'transcript',
    turns: epoch,
  };
}
