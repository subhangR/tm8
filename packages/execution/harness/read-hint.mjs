#!/usr/bin/env node
// tm8 lane PostToolUse hook: nudge large repository reads toward ranges and
// the code graph. Installed through the lane's `--settings` (see
// `laneHookSettings` in src/spawn/harness-surface.ts), never for humans.
//
// Why: repository reads through Bash (sed/cat/grep) are ~15% of the
// re-read-weighted context of a lane, because every tool result is re-sent on
// every later request (doc 01a0d2e9, improvement #3). This hook does NOT cap
// or change the output; it only appends a short `additionalContext` hint.
//
// Contract, in order of importance:
//   - never blocks and never changes the tool result: always exit 0, and the
//     only stdout is an optional `hookSpecificOutput.additionalContext`;
//   - fails open: any error, unreadable input or unwritable state = silence;
//   - fast: no network, no model call, one small state file per session;
//   - cheap: the hint is <= ~250 chars (it is re-sent every turn too), fires
//     at most once per read target and at most MAX_HINTS times per session.
//
// Plain .mjs importing only node built-ins, so it runs unbuilt: the spawn path
// resolves it from `src/` under vitest and from `dist/` on the built server.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Output size, in chars, above which a read earns a hint. Measured over 2,615
 * lane Bash reads (sed/cat/head/tail/grep/rg/awk, 77 transcripts, 5 days):
 * p50 1.0k, p90 6.1k, p95 8.9k. Reads above 6k are 10% of calls but 48% of
 * all read chars, so a hint there targets the reads that dominate the cost
 * without nagging the ordinary ones.
 */
export const THRESHOLD_CHARS = 6000;

/** Hints per session. ~3.5 reads per session exceed the threshold today. */
export const MAX_HINTS = 3;

const READ_COMMANDS = new Set([
  'sed', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'nl', 'less', 'more', 'bat',
]);

const GRAPH = 'graphify-out/merged-graph.json';

/**
 * The repository read in a Bash command, or null. A read is a pipeline whose
 * FIRST stage is a read command, so `sed -n 1,400p f | head` counts while
 * `bun test | tail` (tail reading a test run, not the repo) does not.
 * Returns the command name and a dedupe target: its last non-flag argument.
 */
export function classifyBash(command) {
  if (typeof command !== 'string') return null;
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const stage = segment.split('|')[0].trim().replace(/^[({]\s*/, '');
    const words = stage.split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words.length === 0) continue;
    const name = basename(words[0]);
    if (!READ_COMMANDS.has(name)) continue;
    const args = words.slice(1).filter((w) => !w.startsWith('-') && !/^[<>0-9&]/.test(w));
    return { name, target: `${name}:${args.at(-1) ?? ''}` };
  }
  return null;
}

/** Chars the tool result put into context. */
export function resultChars(toolName, response) {
  if (typeof response === 'string') return response.length;
  if (typeof response !== 'object' || response === null) return 0;
  if (toolName === 'Read') {
    const content = response.file?.content;
    return response.type === 'text' && typeof content === 'string' ? content.length : 0;
  }
  const out = typeof response.stdout === 'string' ? response.stdout.length : 0;
  const err = typeof response.stderr === 'string' ? response.stderr.length : 0;
  return out + err;
}

/** The hint text, <= ~250 chars. Names graphify only when the graph exists. */
export function hintText(toolName, chars, graphExists) {
  const k = `${(chars / 1000).toFixed(1)}k`;
  const range = toolName === 'Read' ? 'Read offset+limit' : 'sed -n X,Yp';
  const graph = graphExists
    ? `; for structure ask the graph first: graphify affected|explain|path "<x>" --graph ${GRAPH}`
    : '';
  return `tm8: that read was ${k} chars and is re-sent every later turn. Next time read only the lines you need (${range})${graph}.`;
}

function statePath(sessionId, stateDir) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
  return join(stateDir, `${safe}.json`);
}

/**
 * Decide whether to hint for one hook input. Returns the hint text or null.
 * State (hinted targets) is persisted BEFORE the hint is returned; if it
 * cannot be written the hook stays silent rather than risk hinting every turn.
 */
export function decide(input, { stateDir = join(tmpdir(), 'tm8-read-hints') } = {}) {
  if (typeof input !== 'object' || input === null) return null;
  const toolName = input.tool_name;
  let target;
  if (toolName === 'Bash') {
    const read = classifyBash(input.tool_input?.command);
    if (!read) return null;
    target = read.target;
  } else if (toolName === 'Read') {
    const file = input.tool_input?.file_path;
    if (typeof file !== 'string') return null;
    target = `Read:${file}`;
  } else {
    return null;
  }

  const chars = resultChars(toolName, input.tool_response);
  if (chars <= THRESHOLD_CHARS) return null;

  const path = statePath(input.session_id, stateDir);
  let state = { targets: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(parsed?.targets)) state = { targets: parsed.targets.filter((t) => typeof t === 'string') };
  } catch {
    // No state yet (first hint of the session) or unreadable: start empty.
  }
  if (state.targets.length >= MAX_HINTS || state.targets.includes(target)) return null;

  state.targets.push(target);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify(state));

  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  return hintText(toolName, chars, existsSync(join(cwd, GRAPH)));
}

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const hint = decide(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      stateDir: process.env.TM8_READ_HINT_STATE_DIR || join(tmpdir(), 'tm8-read-hints'),
    });
    if (hint) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } }),
      );
    }
  } catch {
    // Fail open: say nothing, change nothing.
  }
  process.exitCode = 0;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
