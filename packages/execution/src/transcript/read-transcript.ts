// @tm8/execution — agent transcript reader.
//
// TRANSPLANTED from maestro's
// `maestro-server/src/application/services/LogDigestService.ts` (the text
// extractors, the codex/claude dialect sniffing, the noise filtering and the
// stuck heuristic), with its maestro couplings cut:
//   - no class, no path cache, no session store. tm8 already knows which file
//     to read: `work_sessions.native_session_id` + `workdir_path` (claude), or
//     `resolveCodexRollout`'s ownership-proving scan (codex).
//   - maestro's `sess_*` ids and `<maestro_*>` envelopes become tm8's uuids and
//     `<tm8_*>` / `<trusted_control>` / `<untrusted_data>` envelopes.
//   - the DTO is `@tm8/contract`'s `SessionTranscriptPage`, so `available` /
//     `unavailableReason` carry the same honesty contract as the journal.
//
// WHY THIS EXISTS AT ALL, given the PTY ring is right there: `OutputBuffer`
// holds ANSI frames, is capped at 1 MiB, and dies with the process. It answers
// "what is on the screen". A coordinator needs "what did this agent SAY", which
// only the agent's own transcript answers — and it writes that for free.
//
// Deviations from maestro, both deliberate:
//   - Claude SIDECHAIN turns (`isSidechain: true`, i.e. sub-agent traffic) are
//     excluded from `entries`. Maestro interleaves them; measured on a real tm8
//     session running two Explore sub-agents, that buries the main thread's
//     prose under the sub-agents'. They are still counted in `stats`.
//   - Truncation is a plain `maxChars` cut with a `truncated` flag, NOT
//     maestro's clip-to-first-sentence. A sentence-clipped string reads as
//     complete while silently missing the rest.

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SessionTranscriptEntry,
  SessionTranscriptPage,
  SessionTranscriptStats,
  SessionTranscriptStuck,
} from '@tm8/contract';
import { resolveCodexRollout } from '../spawn/native-session.js';
import { collectFileChanges } from './file-changes.js';

/** Tail window, doubled up to MAX when a window parses to nothing — a single
 *  oversized tool-output line can be larger than the whole window. Maestro's
 *  100 KiB start proved too small once tool output grew; tm8 starts wider. */
const TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const DEFAULT_LAST = 20;
const DEFAULT_MAX_CHARS = 2_000;

const STUCK_TOOL_CALL_THRESHOLD = 5;
const STUCK_SILENCE_MS = 30_000;

/** A user turn containing any of these is tm8 machinery, not a human speaking. */
const NOISE_TAG_PATTERNS = [
  /<system-reminder>/,
  /<local-command>/,
  /<local-command-caveat>/,
];

/** Codex `event_msg` payload types that are bookkeeping, not speech. */
const CODEX_EVENT_NOISE_TYPES = new Set([
  'agent_reasoning',
  'token_count',
  'task_started',
  'task_complete',
  'turn_context',
  'user_message',
  'context_compacted',
  'thread_settings_applied',
  'patch_apply_end',
]);

const CODEX_MESSAGE_TEXT_TYPES = new Set(['output_text', 'input_text', 'text', 'summary_text']);

/** Codex records that are one tool invocation. Both spellings occur in a single
 *  rollout — measured: 71 `custom_tool_call` alongside 10 `function_call`. */
const CODEX_TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);

type Line = Record<string, unknown>;

const asRecord = (v: unknown): Line | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Line) : null;

// ── dialect sniffing ────────────────────────────────────────────────────────

function isCodexLine(line: unknown): boolean {
  const rec = asRecord(line);
  if (!rec) return false;
  const type = rec.type;
  if (
    type === 'response_item' ||
    type === 'session_meta' ||
    type === 'event_msg' ||
    type === 'turn_context' ||
    type === 'function_call' ||
    type === 'function_call_output'
  ) {
    return true;
  }
  return type === 'message' && (rec.role === 'assistant' || rec.role === 'user');
}

function isCodexLog(lines: unknown[]): boolean {
  return lines.some(isCodexLine);
}

function getCodexMessage(line: unknown): { role: string; content: unknown } | null {
  const rec = asRecord(line);
  if (!rec) return null;
  if (rec.type === 'response_item') {
    const payload = asRecord(rec.payload);
    if (payload?.type === 'message' && typeof payload.role === 'string') {
      return { role: payload.role, content: payload.content };
    }
    return null;
  }
  if (rec.type === 'message' && typeof rec.role === 'string') {
    return { role: rec.role, content: rec.content };
  }
  return null;
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => asRecord(b))
    .filter((b): b is Line => b !== null && CODEX_MESSAGE_TEXT_TYPES.has(String(b.type ?? '')))
    .map((b) => String(b.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function extractCodexEventText(payload: unknown): string | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  if (CODEX_EVENT_NOISE_TYPES.has(String(rec.type ?? ''))) return null;
  const message = rec.message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
}

function isCodexToolCall(line: unknown): boolean {
  const rec = asRecord(line);
  if (!rec) return false;
  if (CODEX_TOOL_CALL_TYPES.has(String(rec.type ?? ''))) return true;
  const payload = asRecord(rec.payload);
  return rec.type === 'response_item' && CODEX_TOOL_CALL_TYPES.has(String(payload?.type ?? ''));
}

function codexToolName(line: unknown): string | null {
  const rec = asRecord(line);
  if (!rec) return null;
  const payload = asRecord(rec.payload) ?? rec;
  const name = payload.name;
  return typeof name === 'string' && name !== '' ? name : null;
}

// ── text hygiene ────────────────────────────────────────────────────────────

function parseTimestamp(line: unknown): number | null {
  const rec = asRecord(line);
  const raw = rec?.timestamp;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command>[\s\S]*?<\/local-command>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn tm8's injected XML envelopes into prose.
 *
 * The first user turn of EVERY tm8 session is a `<tm8_task_prompt>` wrapping a
 * `<trusted_control>` header and an escaped `<untrusted_data>` task body. Shown
 * raw it is thousands of characters of machinery that buries the one line a
 * reader wants — the task title. So the envelope is reduced to that line and
 * the rest of the turn is kept.
 *
 * Fails CLOSED on markup it only partly understands: a half-stripped envelope
 * is more confusing than an omitted entry.
 */
function humanizeUserPrompt(text: string): string | null {
  const taskBlock = text.match(/<tm8_task_prompt\b[^>]*>[\s\S]*?<\/tm8_task_prompt>/i)?.[0];
  let taskSummary = '';
  if (taskBlock) {
    const title = decodeXmlText(taskBlock.match(/Title:\s*([^\n<]*)/i)?.[1] ?? '');
    if (title) taskSummary = `Task: ${title}`;
  }

  let remaining = text
    .replace(/<tm8_task_prompt\b[^>]*>[\s\S]*?<\/tm8_task_prompt>/gi, '')
    .replace(/<tm8_system_prompt\b[^>]*>[\s\S]*?<\/tm8_system_prompt>/gi, '')
    .replace(/<trusted_control\b[^>]*>[\s\S]*?<\/trusted_control>/gi, '')
    .replace(/<untrusted_data\b[^>]*>[\s\S]*?<\/untrusted_data>/gi, '')
    .trim();

  if (/<(?:tm8_|trusted_control\b|untrusted_data\b|environment_context\b)/i.test(remaining)) {
    remaining = '';
  }

  const readable = [taskSummary, remaining].filter(Boolean).join('\n');
  return readable || null;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Drop an entry that merely repeats the one before it. Both CLIs re-emit the
 *  same assistant text across a streaming boundary. */
function pushEntry(entries: SessionTranscriptEntry[], entry: SessionTranscriptEntry): void {
  const prev = entries[entries.length - 1];
  if (prev && prev.source === entry.source && prev.text === entry.text) return;
  entries.push(entry);
}

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

// ── entry extraction ────────────────────────────────────────────────────────

function extractClaudeEntries(lines: unknown[], maxChars: number): SessionTranscriptEntry[] {
  const entries: SessionTranscriptEntry[] = [];
  for (const line of lines) {
    const rec = asRecord(line);
    if (!rec) continue;
    // Sub-agent traffic is a different conversation — see the header.
    if (rec.isSidechain === true) continue;
    const at = iso(parseTimestamp(rec));
    const message = asRecord(rec.message) ?? rec;

    if (rec.type === 'assistant') {
      const content = message.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        }
      }
      for (const raw of texts) {
        const cleaned = cleanText(raw);
        if (!cleaned) continue;
        const cut = truncate(cleaned, maxChars);
        pushEntry(entries, { at, source: 'assistant', text: cut.text, truncated: cut.truncated });
      }
    } else if (rec.type === 'user') {
      const content = message.content;
      let text: string;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Text blocks only. A `tool_result` block is machine output, not speech.
        text = content
          .map((b) => asRecord(b))
          .filter((b): b is Line => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => String(b.text))
          .join(' ');
      } else {
        continue;
      }
      const humanized = humanizeUserPrompt(text);
      if (!humanized) continue;
      if (NOISE_TAG_PATTERNS.some((p) => p.test(humanized))) continue;
      const cleaned = cleanText(humanized);
      if (cleaned.length < 3) continue;
      const cut = truncate(cleaned, maxChars);
      pushEntry(entries, { at, source: 'user', text: cut.text, truncated: cut.truncated });
    }
  }
  return entries;
}

function extractCodexEntries(lines: unknown[], maxChars: number): SessionTranscriptEntry[] {
  const entries: SessionTranscriptEntry[] = [];
  for (const line of lines) {
    const at = iso(parseTimestamp(line));
    const rec = asRecord(line);
    if (!rec) continue;

    if (rec.type === 'event_msg') {
      const eventText = extractCodexEventText(rec.payload);
      if (!eventText) continue;
      const cleaned = cleanText(eventText);
      if (!cleaned) continue;
      const cut = truncate(cleaned, maxChars);
      pushEntry(entries, { at, source: 'assistant', text: cut.text, truncated: cut.truncated });
      continue;
    }

    const message = getCodexMessage(rec);
    if (!message) continue;
    const text = extractCodexMessageText(message.content);
    if (!text) continue;

    if (message.role === 'assistant') {
      const cleaned = cleanText(text);
      if (!cleaned) continue;
      const cut = truncate(cleaned, maxChars);
      pushEntry(entries, { at, source: 'assistant', text: cut.text, truncated: cut.truncated });
    } else if (message.role === 'user') {
      const humanized = humanizeUserPrompt(text);
      if (!humanized || humanized.length < 3) continue;
      if (NOISE_TAG_PATTERNS.some((p) => p.test(humanized))) continue;
      const cut = truncate(cleanText(humanized), maxChars);
      if (!cut.text) continue;
      pushEntry(entries, { at, source: 'user', text: cut.text, truncated: cut.truncated });
    }
  }
  return entries;
}

// ── stats ───────────────────────────────────────────────────────────────────

/**
 * `entries` is the FULL extraction for the window, before the caller's `last`
 * slice — it is what defines a "turn" here.
 *
 * `userMessages` and `assistantMessages` count SPEECH, not JSONL records, and
 * they mean the same thing in both dialects. A record count cannot be used: in
 * claude's dialect a tool RESULT arrives as a `type:'user'` record and a tool
 * CALL as a `type:'assistant'` record with no text block, so counting records
 * reported 32 user / 52 assistant on a real transcript whose window held 2
 * human turns and 12 prose replies — and those numbers render directly above
 * the entry list they claim to describe. Codex's own tool traffic is
 * `function_call` / `function_call_output`, which are not messages, so a record
 * count also made one field mean two different quantities across the two
 * dialects this reader exists to normalise.
 *
 * Deriving them from `entries` makes the invariant structural rather than
 * remembered: userMessages + assistantMessages === entries.length for the
 * window, always, in both dialects.
 */
function collectStats(
  lines: unknown[],
  entries: SessionTranscriptEntry[],
  codex: boolean,
  partial: boolean,
): SessionTranscriptStats {
  const tools = new Map<string, number>();
  const models: string[] = [];
  const userMessages = entries.filter((e) => e.source === 'user').length;
  const assistantMessages = entries.length - userMessages;
  let toolCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheCreationTokens: number | null = null;

  const addTool = (name: string | null): void => {
    toolCalls += 1;
    if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
  };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const add = (acc: number | null, v: number | null): number | null =>
    v === null ? acc : (acc ?? 0) + v;

  for (const line of lines) {
    const rec = asRecord(line);
    if (!rec) continue;

    if (codex) {
      if (isCodexToolCall(rec)) addTool(codexToolName(rec));
      const payload = asRecord(rec.payload);
      // Codex reports usage as a RUNNING TOTAL per token_count event, so the
      // newest wins — summing them would multiply-count the whole conversation.
      if (rec.type === 'event_msg' && payload?.type === 'token_count') {
        const info = asRecord(payload.info);
        const total = asRecord(info?.total_token_usage) ?? info;
        inputTokens = num(total?.input_tokens) ?? inputTokens;
        outputTokens = num(total?.output_tokens) ?? outputTokens;
        cacheReadTokens = num(total?.cached_input_tokens) ?? cacheReadTokens;
      }
      const turn = asRecord(rec.payload);
      if (rec.type === 'turn_context' && typeof turn?.model === 'string') {
        if (!models.includes(turn.model)) models.push(turn.model);
      }
      continue;
    }

    // Claude
    const message = asRecord(rec.message);
    if (rec.type === 'assistant') {
      // `<synthetic>` is claude's marker for a locally-fabricated assistant turn
      // (interrupts, "no response requested"), not a model anyone chose.
      // Measured on a live transcript: it lands in `models` beside the real id
      // and reads to a coordinator as if the session had switched models.
      const model = message?.model;
      if (typeof model === 'string' && model !== '<synthetic>' && !models.includes(model)) {
        models.push(model);
      }
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.type === 'tool_use') addTool(typeof b.name === 'string' ? b.name : null);
        }
      }
      // Claude reports usage PER TURN, so these sum.
      const usage = asRecord(message?.usage);
      if (usage) {
        inputTokens = add(inputTokens, num(usage.input_tokens));
        outputTokens = add(outputTokens, num(usage.output_tokens));
        cacheReadTokens = add(cacheReadTokens, num(usage.cache_read_input_tokens));
        cacheCreationTokens = add(cacheCreationTokens, num(usage.cache_creation_input_tokens));
      }
    }
  }

  return {
    partial,
    userMessages,
    assistantMessages,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    tools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    models,
  };
}

// ── stuck heuristic ─────────────────────────────────────────────────────────

/**
 * Scan BACKWARDS counting tool calls until the last assistant prose.
 *
 * Silence is measured against `now`, not against the newest record, so a worker
 * that has stopped writing entirely is still detected — that is the case the
 * heuristic exists for, and comparing two record timestamps would score it zero.
 */
function detectStuck(lines: unknown[], codex: boolean, now: number): SessionTranscriptStuck | null {
  let toolCallsSinceText = 0;
  let lastTextAt = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const rec = asRecord(line);
    if (!rec) continue;

    if (codex) {
      if (rec.type === 'event_msg') {
        if (extractCodexEventText(rec.payload)) {
          lastTextAt = parseTimestamp(rec) ?? 0;
          break;
        }
        continue;
      }
      const message = getCodexMessage(rec);
      if (message?.role === 'assistant' && cleanText(extractCodexMessageText(message.content))) {
        lastTextAt = parseTimestamp(rec) ?? 0;
        break;
      }
      if (isCodexToolCall(rec)) toolCallsSinceText += 1;
      continue;
    }

    if (rec.type !== 'assistant' || rec.isSidechain === true) continue;
    const content = asRecord(rec.message)?.content ?? rec.content;
    if (!Array.isArray(content)) continue;
    const blocks = content.map((b) => asRecord(b));
    if (blocks.some((b) => b?.type === 'text' && String(b.text ?? '').trim() !== '')) {
      lastTextAt = parseTimestamp(rec) ?? 0;
      break;
    }
    if (blocks.some((b) => b?.type === 'tool_use')) toolCallsSinceText += 1;
  }

  if (toolCallsSinceText <= STUCK_TOOL_CALL_THRESHOLD) return null;

  // No prose anywhere in the window: silence is unmeasurable, so report 0 and
  // let the tool-call count speak rather than inventing a duration.
  const silentMs = lastTextAt > 0 ? now - lastTextAt : 0;
  if (lastTextAt > 0 && silentMs < STUCK_SILENCE_MS) return null;
  return { silentMs, toolCallsSinceText };
}

// ── file access ─────────────────────────────────────────────────────────────

interface TailResult {
  lines: unknown[];
  malformed: number;
  partial: boolean;
}

/**
 * Parse the tail of a JSONL file, widening the window while it yields nothing.
 *
 * A transcript can reach tens of megabytes and a SINGLE tool-output line can be
 * larger than the starting window, so a fixed window can legitimately parse to
 * zero records on a healthy file. Doubling up to MAX_TAIL_BYTES is maestro's
 * fix for exactly that.
 */
async function readTail(path: string): Promise<TailResult> {
  const { size } = await stat(path);
  let windowBytes = Math.min(TAIL_BYTES, size || TAIL_BYTES);

  for (;;) {
    const offset = Math.max(0, size - windowBytes);
    const handle = await open(path, 'r');
    let content: string;
    try {
      const buffer = Buffer.alloc(Math.min(windowBytes, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      content = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }

    const raw = content.split('\n').filter((l) => l.trim() !== '');
    // A seeked read almost certainly starts mid-record.
    const candidates = offset > 0 ? raw.slice(1) : raw;

    const lines: unknown[] = [];
    let malformed = 0;
    for (const line of candidates) {
      try {
        lines.push(JSON.parse(line));
      } catch {
        malformed += 1;
      }
    }

    const exhausted = windowBytes >= MAX_TAIL_BYTES || windowBytes >= size;
    if (lines.length > 0 || exhausted) {
      return { lines, malformed, partial: offset > 0 };
    }
    windowBytes = Math.min(size, windowBytes * 2, MAX_TAIL_BYTES);
  }
}

/**
 * Claude's project-directory name: EVERY non-alphanumeric character of the
 * absolute cwd becomes `-`.
 *
 * Reverse-engineered, so it is stated with its evidence: measured 2026-08-07
 * against this machine's `~/.claude/projects`, it resolved 65 of 65 tm8 scratch
 * sessions that had a transcript (the 6 that missed were codex sessions with no
 * claude directory at all). If claude-code ever changes the rule this returns a
 * path that does not exist, which surfaces as `no_transcript_file` — an
 * explained empty, not a crash. Re-measure with the same method before trusting
 * a bug report that says transcripts vanished.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd
    .replace(/\/+$/, '')
    .split('')
    .map((c) => (/[a-zA-Z0-9]/.test(c) ? c : '-'))
    .join('');
}

// ── entry point ─────────────────────────────────────────────────────────────

export interface ReadTranscriptOptions {
  sessionId: string;
  /** `work_sessions.agent_tool`. Anything else is `unsupported_agent_tool`. */
  agentTool: string | null;
  /** `work_sessions.native_session_id`. Required for claude, unused for codex. */
  nativeSessionId: string | null;
  /** The session's resolved cwd — its project workdir or its scratch dir. */
  cwd: string | null;
  home: string;
  /** Exact provider config dir used by the child: CLAUDE_CONFIG_DIR/CODEX_HOME. */
  agentConfigDir?: string | null;
  /** Bounded historical candidates (known identity homes plus the node home). */
  fallbackAgentConfigDirs?: string[];
  last?: number;
  maxChars?: number;
  now?: number;
  /**
   * Also scan the WHOLE file for Edit/Write tool calls and attach
   * `fileChanges` (claude-code dialect only; codex attaches null). Off by
   * default: the full-file scan costs more than the tail window.
   */
  includeFileChanges?: boolean;
}

/**
 * Read one session's agent transcript and fold it into a `SessionTranscriptPage`.
 *
 * THE PATH NEVER COMES FROM THE REQUEST — every input is a column of the
 * session's own row, which the caller has already authorized by reading the
 * entity. Nothing here re-derives authorization, and nothing here accepts a
 * caller-supplied path.
 *
 * Every failure is an explained empty rather than a throw: a session with no
 * readable transcript is a normal, common state (it predates native-id capture,
 * it ran a tool with no transcript, it died before its first turn), and this
 * surface must render that honestly rather than as a zero or a 500.
 */
export async function readSessionTranscript(
  opts: ReadTranscriptOptions,
): Promise<SessionTranscriptPage> {
  const last = opts.last ?? DEFAULT_LAST;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const now = opts.now ?? Date.now();

  const unavailable = (
    reason: NonNullable<SessionTranscriptPage['unavailableReason']>,
    agentTool: SessionTranscriptPage['agentTool'] = null,
    searchedPaths: string[] = [],
  ): SessionTranscriptPage => ({
    sessionId: opts.sessionId,
    available: false,
    unavailableReason: reason,
    searchedPaths,
    agentTool,
    entries: [],
    stats: null,
    stuck: null,
    lastActivityAt: null,
    malformed: 0,
  });

  let path: string;
  let agentTool: 'claude-code' | 'codex';
  const providerDefault =
    opts.agentTool === 'claude-code' ? join(opts.home, '.claude') : join(opts.home, '.codex');
  const configDirs = [...new Set([
    ...(opts.agentConfigDir ? [opts.agentConfigDir] : []),
    ...(opts.fallbackAgentConfigDirs ?? []),
    providerDefault,
  ])];
  const searchedPaths: string[] = [];

  if (opts.agentTool === 'claude-code') {
    agentTool = 'claude-code';
    if (!opts.nativeSessionId) return unavailable('no_native_session_id', agentTool);
    if (!opts.cwd) return unavailable('no_transcript_file', agentTool);
    const candidates = configDirs.map((dir) =>
      join(dir, 'projects', encodeClaudeProjectDir(opts.cwd!), `${opts.nativeSessionId}.jsonl`));
    searchedPaths.push(...candidates);
    path = candidates[0]!;
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        path = candidate;
        break;
      } catch { /* try the next bounded candidate */ }
    }
  } else if (opts.agentTool === 'codex') {
    agentTool = 'codex';
    // Codex mints its own rollout id, so the file is found by the ownership
    // marker rather than by name — the same scan resume already relies on.
    let rollout = null;
    for (const configDir of configDirs) {
      searchedPaths.push(join(configDir, 'sessions'));
      rollout = await resolveCodexRollout({
        home: opts.home,
        configDir,
        tm8SessionId: opts.sessionId,
        cwd: opts.cwd,
      });
      if (rollout) break;
    }
    if (!rollout) return unavailable('no_transcript_file', agentTool, searchedPaths);
    path = rollout.path;
  } else {
    return unavailable('unsupported_agent_tool');
  }

  let tail: TailResult;
  try {
    tail = await readTail(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return unavailable(
      code === 'ENOENT' ? 'no_transcript_file' : 'unreadable', agentTool, searchedPaths,
    );
  }

  // Sniff the dialect from the CONTENT, never from the recorded agent_tool: a
  // resumed session can have been relaunched under a different tool, and the
  // file on disk is the authority on its own format.
  const codex = isCodexLog(tail.lines);
  const all = codex
    ? extractCodexEntries(tail.lines, maxChars)
    : extractClaudeEntries(tail.lines, maxChars);

  const lastActivity = tail.lines.reduce<number | null>((newest, line) => {
    const ts = parseTimestamp(line);
    return ts !== null && (newest === null || ts > newest) ? ts : newest;
  }, null);

  const page: SessionTranscriptPage = {
    sessionId: opts.sessionId,
    available: true,
    unavailableReason: null,
    searchedPaths: [],
    agentTool,
    entries: last > 0 ? all.slice(-last) : all,
    stats: collectStats(tail.lines, all, codex, tail.partial),
    stuck: detectStuck(tail.lines, codex, now),
    lastActivityAt: iso(lastActivity),
    malformed: tail.malformed,
  };

  if (opts.includeFileChanges) {
    // Codex records patches in a different envelope; null is the honest
    // answer until that parser exists — never a half-parsed accounting.
    if (codex) {
      page.fileChanges = null;
    } else {
      try {
        page.fileChanges = await collectFileChanges(path);
      } catch {
        // The tail read above succeeded, so the file existed moments ago; a
        // racing cleanup loses the accounting, not the transcript page.
        page.fileChanges = null;
      }
    }
  }

  return page;
}
