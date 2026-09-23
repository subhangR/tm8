// @tm8/execution — whole-conversation provider usage, read ONCE, at exit.
//
// WHY THIS IS NOT `collectStats` (read-transcript.ts). That reader serves a
// live page: it tails a bounded window of a file that reaches tens of
// megabytes, re-reads it every few seconds, and its contract
// (`SessionTranscriptStats.partial`) says so out loud. Persisting its numbers
// as a session's spend would be the exact dishonesty that field exists to
// prevent. This reader streams the WHOLE file, once, at the one moment the
// whole conversation is certainly on disk — the process that wrote it has just
// died — and hands back totals that are allowed to be called totals.
//
// TWO PROVENANCES, NEVER MERGED. Measured 2026-09-15 across 311 resolvable
// claude-code transcripts on this node:
//   - the harness writes one record per content block, and every record of a
//     streamed message repeats the same cumulative `usage`. 67,552 usage
//     records held 32,396 distinct `message.id`s with byte-identical usage on
//     every duplicate — summing per record over-counts by 2.09x. So the
//     transcript half is de-duplicated by message.id, last record wins.
//   - the harness ALSO writes its own `cost-state` record on orderly
//     shutdown (86/311 files), with per-model tokens and a USD figure. Against
//     the de-duplicated transcript sum it agreed exactly on 22/86, median
//     ratio 0.94, p10 0.58, and one resumed session read 2.25 because a
//     process restart resets the snapshot. Neither number is "the truth".
// Both halves are persisted with their provenance, and their disagreement is
// an instrument rather than a bug to hide. USD is copied from the harness
// when it says one and is NEVER computed here: tm8 has no rate table, models
// switch mid-session, and codex rollouts carry no cost at all.
//
// WHAT THIS DOES NOT CLAIM. An ending class. Interactive sessions do not END
// on context exhaustion — they compact and continue (19/19 files with a
// compaction marker kept running past it), and of 145 transcripts whose last
// assistant record is an API error, none names the context window: they are
// rate limits, an outdated CLI, and 529s. So this records the EVIDENCE
// (compactions, the largest pre-compaction prefix, the last turn's context
// size, the last stop_reason, a trailing API error) and leaves `ended_kind`
// to the exit classifier, which has the process evidence this file lacks.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { SessionTranscriptPage } from '@tm8/contract';
import {
  codexToolName,
  isCodexLine,
  isCodexToolCall,
  locateTranscript,
  type LocateTranscriptOptions,
} from './read-transcript.js';

/** Which dialect the persisted document was read from. Mirrors the 185 CHECK. */
export type WorkSessionUsageSource = 'claude_transcript' | 'codex_rollout';

/**
 * Token counts for one model, or for the whole conversation.
 *
 * SEMANTICS DIFFER BY DIALECT, which is why `usage_source` is stored beside
 * the document and why the two must never be summed across sessions without
 * grouping by it:
 *   - claude: `inputTokens` is the UNCACHED input only; the cache tiers are
 *     the rest of the prefix. `cacheCreation5m/1hTokens` are the itemised
 *     write tiers when the record carries `usage.cache_creation`, else null.
 *   - codex: `inputTokens` is the whole input as codex reports it (cached
 *     included); `cacheReadTokens` is its `cached_input_tokens`. The tier
 *     fields are always null — codex does not itemise.
 */
export interface UsageTally {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
  /** Distinct API messages this tally was summed over. */
  messages: number;
}

/** The harness's own accounting (`cost-state`), copied, never computed. */
export interface HarnessUsage {
  costSource: 'claude_cost_state';
  /** As the harness reported it. Null only when every snapshot lacked the field. */
  costUsd: number | null;
  /**
   * Distinct `startTime`s seen — one per process that wrote the file. A
   * resumed session is several processes and each restarts its snapshot, so
   * the totals below are the SUM of the last snapshot per process.
   */
  processes: number;
  hasUnknownModelCost: boolean;
  totals: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  byModel: Record<string, HarnessUsage['totals'] & { costUsd: number | null }>;
}

export interface WorkSessionUsage {
  /** Shape version of this document. Bump on any incompatible change. */
  schemaVersion: 1;
  agentTool: 'claude-code' | 'codex';
  transcriptPath: string;
  transcriptBytes: number;
  /** Always false here — the whole file was read. Named so a reader holding
   *  this beside `SessionTranscriptStats.partial` knows which one they have. */
  partial: false;
  malformedLines: number;
  transcript: {
    /** Distinct API messages — claude: by message.id; codex: assistant messages. */
    messages: number;
    /** Records that carried usage BEFORE de-duplication; `/ messages` is the over-count factor. */
    usageRecords: number;
    /** Main-thread assistant messages. Sidechain (sub-agent) traffic is counted in tokens, not here. */
    turns: number;
    sidechainMessages: number;
    /** Main-thread user records that are a prompt rather than a tool result or a compaction summary. */
    userPrompts: number;
    toolCalls: number;
    /** Descending by count. Names as the agent wrote them. */
    tools: { name: string; count: number }[];
    /** Distinct model ids, first-seen order. `<synthetic>` is not a model. */
    models: string[];
    totals: UsageTally;
    /** Claude only; codex does not attribute tokens to a model. */
    byModel: Record<string, UsageTally>;
    /** Prefix (input + cache read + cache write) of the first main-thread message. */
    firstTurnContextTokens: number | null;
    /** Same, for the last main-thread message — how full the window was at the end. */
    lastTurnContextTokens: number | null;
    /** Largest prefix any single message carried. */
    maxContextTokens: number | null;
    /** Codex `model_context_window`; claude transcripts do not state it. */
    contextWindow: number | null;
    /**
     * Compaction events. Claude: records with `isCompactSummary: true`; codex:
     * `context_compacted` events. Measured against claude's own
     * `system/compact_boundary` records on 19 files: the two counts agreed on
     * every one, and the boundary record's metadata is kept beside it.
     */
    compactions: number;
    compactBoundaries: { auto: number; manual: number; maxPreTokens: number | null } | null;
    /** The last main-thread assistant message's stop_reason (claude). */
    lastStopReason: string | null;
    /** Set when the FINAL main-thread assistant record is a harness API-error message. */
    lastApiError: string | null;
    firstAt: string | null;
    lastAt: string | null;
  };
  harness: HarnessUsage | null;
}

export type ReadSessionUsageResult =
  | { available: true; source: WorkSessionUsageSource; usage: WorkSessionUsage }
  | {
      available: false;
      reason: NonNullable<SessionTranscriptPage['unavailableReason']>;
      searchedPaths: string[];
    };

type Line = Record<string, unknown>;

const asRecord = (v: unknown): Line | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Line) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const n0 = (v: unknown): number => num(v) ?? 0;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A trailing API error is kept as evidence, not as a transcript: one line of it. */
const API_ERROR_MAX_CHARS = 240;

function emptyTally(): UsageTally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    messages: 0,
  };
}

/** Add one claude `message.usage` block into a tally. */
function addClaudeUsage(tally: UsageTally, usage: Line): void {
  tally.inputTokens += n0(usage.input_tokens);
  tally.outputTokens += n0(usage.output_tokens);
  tally.cacheReadTokens += n0(usage.cache_read_input_tokens);
  tally.cacheCreationTokens += n0(usage.cache_creation_input_tokens);
  tally.messages += 1;
  // The write tiers are itemised on newer records only. A null tier stays
  // null until a record actually says a number, so a document with the tier
  // fields at 0 means "measured as zero" and null means "never itemised".
  const tiers = asRecord(usage.cache_creation);
  if (tiers) {
    const t5 = num(tiers.ephemeral_5m_input_tokens);
    const t1 = num(tiers.ephemeral_1h_input_tokens);
    if (t5 !== null) tally.cacheCreation5mTokens = (tally.cacheCreation5mTokens ?? 0) + t5;
    if (t1 !== null) tally.cacheCreation1hTokens = (tally.cacheCreation1hTokens ?? 0) + t1;
  }
}

const prefixOf = (usage: Line): number =>
  n0(usage.input_tokens) + n0(usage.cache_read_input_tokens) + n0(usage.cache_creation_input_tokens);

/** What one claude API message resolved to, after its last record. */
interface ClaudeMessage {
  usage: Line;
  model: string | null;
  sidechain: boolean;
  stopReason: string | null;
}

/**
 * Read one session's transcript end to end and fold it into a
 * {@link WorkSessionUsage}. Never throws: a missing or unreadable file is an
 * explained `available: false`, exactly as the page reader answers, because a
 * session with no transcript is a normal state and this runs on exit paths
 * that must not fail for it.
 */
export async function readSessionUsage(opts: LocateTranscriptOptions): Promise<ReadSessionUsageResult> {
  const located = await locateTranscript(opts);
  if (!located.found) {
    return { available: false, reason: located.reason, searchedPaths: located.searchedPaths };
  }

  let transcriptBytes: number;
  try {
    transcriptBytes = (await stat(located.path)).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return {
      available: false,
      reason: code === 'ENOENT' ? 'no_transcript_file' : 'unreadable',
      searchedPaths: located.searchedPaths,
    };
  }

  // --- accumulators, both dialects ---------------------------------------
  let malformed = 0;
  let codex = false;
  const tools = new Map<string, number>();
  let toolCalls = 0;
  const models: string[] = [];
  const addModel = (model: unknown): void => {
    // `<synthetic>` is claude's marker for a locally fabricated turn, not a
    // model anyone chose — see collectStats for the measurement.
    if (typeof model === 'string' && model !== '<synthetic>' && !models.includes(model)) models.push(model);
  };
  const addTool = (name: string | null): void => {
    toolCalls += 1;
    if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
  };
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const noteTime = (rec: Line): void => {
    const at = str(rec.timestamp);
    if (!at) return;
    if (firstAt === null) firstAt = at;
    lastAt = at;
  };

  // --- claude -------------------------------------------------------------
  // Insertion order is first-appearance order, which is the conversation's
  // order; `set` on a repeated id updates the value without moving it.
  const claudeMessages = new Map<string, ClaudeMessage>();
  let usageRecords = 0;
  let userPrompts = 0;
  let compactSummaries = 0;
  let compactAuto = 0;
  let compactManual = 0;
  let compactMaxPre: number | null = null;
  let lastMainAssistantApiError: string | null = null;
  // cost-state, grouped by the process that wrote it. Later snapshots of one
  // process are cumulative, so the last one per group is the one that counts.
  const costSnapshots = new Map<string, Line>();

  // --- codex --------------------------------------------------------------
  let codexTotal: Line | null = null;
  let codexLastTurn: Line | null = null;
  let codexContextWindow: number | null = null;
  let codexTurns = 0;
  let codexAssistantMessages = 0;
  let codexUserMessages = 0;
  let codexCompactions = 0;
  let codexMaxLastTurn: number | null = null;

  try {
    const input = createReadStream(located.path, { encoding: 'utf8' });
    // crlfDelay: a record is one line; a bare `\r` inside one must not split it.
    const rl = createInterface({ input, crlfDelay: Infinity });
    let index = 0;
    for await (const line of rl) {
      index += 1;
      if (line.length < 2) continue;
      let rec: Line | null;
      try {
        rec = asRecord(JSON.parse(line));
      } catch {
        malformed += 1;
        continue;
      }
      if (!rec) continue;
      noteTime(rec);

      if (isCodexLine(rec)) {
        codex = true;
        if (isCodexToolCall(rec)) addTool(codexToolName(rec));
        const payload = asRecord(rec.payload);
        if (rec.type === 'event_msg' && payload?.type === 'token_count') {
          // A RUNNING TOTAL per event: newest wins, never summed.
          const info = asRecord(payload.info);
          const total = asRecord(info?.total_token_usage) ?? info;
          if (total) codexTotal = total;
          const last = asRecord(info?.last_token_usage);
          if (last) {
            codexLastTurn = last;
            const t = num(last.total_tokens);
            if (t !== null) codexMaxLastTurn = Math.max(codexMaxLastTurn ?? 0, t);
          }
          codexContextWindow = num(info?.model_context_window) ?? codexContextWindow;
        } else if (rec.type === 'event_msg' && payload?.type === 'context_compacted') {
          codexCompactions += 1;
        } else if (rec.type === 'turn_context') {
          codexTurns += 1;
          addModel(payload?.model);
        } else if (rec.type === 'response_item' && payload?.type === 'message') {
          if (payload.role === 'assistant') codexAssistantMessages += 1;
          else if (payload.role === 'user') codexUserMessages += 1;
        }
        continue;
      }

      // --- claude dialect ---
      if (rec.type === 'cost-state') {
        const key = String(num(rec.startTime) ?? 'unknown');
        costSnapshots.set(key, rec);
        continue;
      }
      if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
        const meta = asRecord(rec.compactMetadata);
        if (meta?.trigger === 'manual') compactManual += 1;
        else compactAuto += 1;
        const pre = num(meta?.preTokens);
        if (pre !== null) compactMaxPre = Math.max(compactMaxPre ?? 0, pre);
        continue;
      }
      if (rec.isCompactSummary === true) compactSummaries += 1;

      const message = asRecord(rec.message);
      const sidechain = rec.isSidechain === true;
      if (rec.type === 'user') {
        // A prompt is a main-thread user record that is neither a tool result
        // nor the compaction summary the harness re-injects as a "user" turn.
        if (sidechain || rec.isCompactSummary === true || rec.isMeta === true) continue;
        const content = message?.content;
        const isToolResult = Array.isArray(content)
          && content.some((b) => asRecord(b)?.type === 'tool_result');
        if (!isToolResult) userPrompts += 1;
        continue;
      }
      if (rec.type !== 'assistant') continue;

      addModel(message?.model);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.type === 'tool_use') addTool(typeof b.name === 'string' ? b.name : null);
        }
      }
      const usage = asRecord(message?.usage);
      const id = str(message?.id) ?? `record:${index}`;
      if (usage) {
        usageRecords += 1;
        claudeMessages.set(id, {
          usage,
          model: str(message?.model),
          sidechain,
          stopReason: str(message?.stop_reason),
        });
      }
      if (!sidechain) {
        // The harness writes its own failures as assistant records flagged
        // `isApiErrorMessage`. Kept only if it is the FINAL such record, as
        // ending-state evidence; an error mid-run that the session recovered
        // from is not how it ended.
        if (rec.isApiErrorMessage === true) {
          const text = Array.isArray(content)
            ? content.map((b) => str(asRecord(b)?.text) ?? '').join(' ').trim()
            : '';
          lastMainAssistantApiError = text.slice(0, API_ERROR_MAX_CHARS) || 'API error (no text)';
        } else {
          lastMainAssistantApiError = null;
        }
      }
    }
  } catch {
    // The stream itself failed after the file was stat'd — a read error, a
    // file swapped out from under us. Explained empty, never a throw.
    return { available: false, reason: 'unreadable', searchedPaths: located.searchedPaths };
  }

  const toolList = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (codex) {
    // Codex attributes nothing to a model and itemises no cache tier; the
    // tally is the newest running total, verbatim in codex's own semantics.
    const totals = emptyTally();
    if (codexTotal) {
      totals.inputTokens = n0(codexTotal.input_tokens);
      totals.outputTokens = n0(codexTotal.output_tokens);
      totals.cacheReadTokens = n0(codexTotal.cached_input_tokens);
      totals.cacheCreationTokens = n0(codexTotal.cache_write_input_tokens);
    }
    totals.messages = codexAssistantMessages;
    return {
      available: true,
      source: 'codex_rollout',
      usage: {
        schemaVersion: 1,
        agentTool: 'codex',
        transcriptPath: located.path,
        transcriptBytes,
        partial: false,
        malformedLines: malformed,
        transcript: {
          messages: codexAssistantMessages,
          usageRecords: codexAssistantMessages,
          turns: codexTurns,
          sidechainMessages: 0,
          userPrompts: codexUserMessages,
          toolCalls,
          tools: toolList,
          models,
          totals,
          byModel: {},
          firstTurnContextTokens: null,
          lastTurnContextTokens: codexLastTurn ? num(codexLastTurn.total_tokens) : null,
          maxContextTokens: codexMaxLastTurn,
          contextWindow: codexContextWindow,
          compactions: codexCompactions,
          compactBoundaries: null,
          lastStopReason: null,
          lastApiError: null,
          firstAt,
          lastAt,
        },
        harness: null,
      },
    };
  }

  // --- claude: sum once per message, split by model -----------------------
  const totals = emptyTally();
  const byModel: Record<string, UsageTally> = {};
  let sidechainMessages = 0;
  let firstTurnContextTokens: number | null = null;
  let lastTurnContextTokens: number | null = null;
  let maxContextTokens: number | null = null;
  let lastStopReason: string | null = null;
  let turns = 0;
  for (const m of claudeMessages.values()) {
    addClaudeUsage(totals, m.usage);
    const model = m.model ?? '<unknown>';
    addClaudeUsage((byModel[model] ??= emptyTally()), m.usage);
    const prefix = prefixOf(m.usage);
    maxContextTokens = Math.max(maxContextTokens ?? 0, prefix);
    if (m.sidechain) {
      sidechainMessages += 1;
      continue;
    }
    turns += 1;
    if (firstTurnContextTokens === null) firstTurnContextTokens = prefix;
    lastTurnContextTokens = prefix;
    if (m.stopReason) lastStopReason = m.stopReason;
  }
  // --- claude: the harness's own accounting --------------------------------
  let harness: HarnessUsage | null = null;
  if (costSnapshots.size > 0) {
    const h: HarnessUsage = {
      costSource: 'claude_cost_state',
      costUsd: null,
      processes: costSnapshots.size,
      hasUnknownModelCost: false,
      totals: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      byModel: {},
    };
    for (const snap of costSnapshots.values()) {
      const cost = num(snap.totalCostUSD);
      if (cost !== null) h.costUsd = (h.costUsd ?? 0) + cost;
      if (snap.hasUnknownModelCost === true) h.hasUnknownModelCost = true;
      const perModel = asRecord(snap.modelUsage);
      if (!perModel) continue;
      for (const [model, raw] of Object.entries(perModel)) {
        const u = asRecord(raw);
        if (!u) continue;
        const slot = (h.byModel[model] ??= {
          inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null,
        });
        const add = (key: keyof HarnessUsage['totals'], from: string): void => {
          const v = n0(u[from]);
          slot[key] += v;
          h.totals[key] += v;
        };
        add('inputTokens', 'inputTokens');
        add('outputTokens', 'outputTokens');
        add('thinkingTokens', 'thinkingTokens');
        add('cacheReadTokens', 'cacheReadInputTokens');
        add('cacheCreationTokens', 'cacheCreationInputTokens');
        const modelCost = num(u.costUSD);
        if (modelCost !== null) slot.costUsd = (slot.costUsd ?? 0) + modelCost;
      }
    }
    harness = h;
  }

  return {
    available: true,
    source: 'claude_transcript',
    usage: {
      schemaVersion: 1,
      agentTool: 'claude-code',
      transcriptPath: located.path,
      transcriptBytes,
      partial: false,
      malformedLines: malformed,
      transcript: {
        messages: claudeMessages.size,
        usageRecords,
        turns,
        sidechainMessages,
        userPrompts,
        toolCalls,
        tools: toolList,
        models,
        totals,
        byModel,
        firstTurnContextTokens,
        lastTurnContextTokens,
        maxContextTokens,
        contextWindow: null,
        compactions: compactSummaries,
        compactBoundaries:
          compactAuto + compactManual > 0
            ? { auto: compactAuto, manual: compactManual, maxPreTokens: compactMaxPre }
            : null,
        lastStopReason,
        lastApiError: lastMainAssistantApiError,
        firstAt,
        lastAt,
      },
      harness,
    },
  };
}
