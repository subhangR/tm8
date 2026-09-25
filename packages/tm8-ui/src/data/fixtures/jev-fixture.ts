/**
 * The fixture `launch.suggest` — Ask Jev with scripted answers.
 *
 * It models the SERVER's contract, not Jev's internals: the four groups are
 * answered independently, each with its own status and cost; candidates are the
 * fixture space's own teammates, memories and skills, one row per entity id; a
 * repeated `requestId` returns the recorded answer without charging again; and
 * `run` is the running total for the whole `runId`.
 *
 * Deterministic like the rest of the fixture seam — no Date.now() and no
 * Math.random(). A score is a hash of the entity id, so the same space always
 * ranks the same way and a test can name what gets pre-ticked.
 *
 * SCENARIOS, one word each so a test (or the dev harness) can script them:
 *   · `ok`              — every group answers.
 *   · `group_failed`    — skills fails with `timeout`; the other three answer.
 *   · `no_key`          — every group fails with `no_key` (no TYPESAFE_API_KEY).
 *   · `not_implemented` — the node predates the handler and answers 501.
 *   · `tight_budget`    — every answer, with budgets small enough to BIND: rows
 *                         above the floor are left unticked `over-budget`,
 *                         defaults among them.
 *   · `index_off`       — every answer, with the context index OFF: references
 *                         carry 0 prompt bytes and no budget, and a skill's
 *                         bytes are its `<skills>` line.
 *
 * THE FILL mirrors the server's (design 01a0d348 §10 Q5): rank order, skip rows
 * under the floor, tick while the group's bytes fit its budget — an index group
 * (skills, references) paying its `<group>` frame too.
 */
import {
  CollabError,
  type EntitySuggestion,
  type EntitySummary,
  type JevCost,
  type JevGroupResult,
  type LaunchSuggestGroup,
  type LaunchSuggestInput,
  type LaunchSuggestResult,
  type ModelSuggestion,
  type RankedEntity,
  type RankedEntitySource,
  type RelevanceLevel,
  type TeammateSuggestion,
  SPAWN_SELECTION_REFERENCE_KINDS,
} from '@tm8/contract';
import { contextGroupFrameBytes } from '@tm8/prompt';
import type { JevPort } from '../../jev/port';

export type FixtureJevScenario = 'ok' | 'group_failed' | 'no_key' | 'not_implemented' | 'tight_budget' | 'index_off';

export interface FixtureJev {
  port: JevPort;
  setScenario(scenario: FixtureJevScenario): void;
  /** Hold every answer this long, so "Asking…" can be seen in a harness. Default 0. */
  setDelay(ms: number): void;
  /** Every input the port received, in order. */
  readonly requests: readonly LaunchSuggestInput[];
}

/** $42 per billion input tokens; output is free (design §6). */
const USD_PER_INPUT_TOKEN = 42 / 1e9;
const CHUNK = 60;
const CANDIDATE_LIMIT = 240;
const FLOOR = 1.5;
/** Node defaults (packages/prompt budgets): skills take what the prompt has left. */
const BUDGETS: Record<EntityGroup, number | null> = { memories: 12288, skills: null, references: 8192 };
/** `tight_budget`: small enough that the fixture space's rows overflow them. */
const TIGHT: Record<EntityGroup, number | null> = { memories: 1500, skills: 1400, references: 1200 };

type EntityGroup = 'memories' | 'skills' | 'references';

const ZERO: JevCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 0..3 in tenths, from the id alone. */
function scoreOf(id: string): number {
  return (hash(id) % 31) / 10;
}

function levelOf(score: number): RelevanceLevel {
  const rounded = Math.round(score);
  return rounded >= 3 ? 'critical' : rounded === 2 ? 'useful' : rounded === 1 ? 'background' : 'irrelevant';
}

function costFor(calls: number, candidates: number): JevCost {
  const inputTokens = 900 * calls + 40 * candidates;
  return {
    calls,
    inputTokens,
    outputTokens: 60 * calls,
    usd: Number((inputTokens * USD_PER_INPUT_TOKEN).toFixed(8)),
    latencyMs: 380 + 20 * calls,
  };
}

function add(a: JevCost, b: JevCost): JevCost {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: Number((a.usd + b.usd).toFixed(8)),
    latencyMs: Math.max(a.latencyMs, b.latencyMs),
  };
}

function ranked(
  row: EntitySummary,
  kind: RankedEntity['kind'],
  sources: RankedEntitySource[],
): RankedEntity {
  const score = scoreOf(row.id);
  return {
    entityId: row.id,
    kind,
    title: row.title || row.excerpt || row.id,
    sources,
    score,
    level: levelOf(score),
    suggested: score >= FLOOR,
    default: sources.some((source) => source !== 'space'),
    // A plausible entry size, stable per id: a meter has something to count.
    promptBytes: 200 + (hash(`bytes:${row.id}`) % 1200),
    header: { whenToUse: null, summary: row.excerpt || null, keywords: [], source: 'derived', version: 0 },
    ...(score >= FLOOR ? {} : { reason: 'below-floor' as const }),
  };
}

/**
 * The budget fill: in rank order, a row at or above the floor is ticked while
 * the group still fits its budget; one that doesn't fit is `over-budget` and
 * the fill moves on (a smaller row later may still fit). Mutates `items`.
 */
export function fillByBudget(
  group: EntityGroup,
  items: RankedEntity[],
  budget: number | null,
  floor: number,
  contextIndex: 'on' | 'off',
): void {
  let entries = 0;
  let count = 0;
  const frame = (n: number) => (group !== 'memories' && contextIndex === 'on' && n > 0 ? contextGroupFrameBytes(group, n) : 0);
  for (const item of items) {
    delete item.reason;
    if (item.score < floor) {
      item.suggested = false;
      item.reason = 'below-floor';
      continue;
    }
    if (budget !== null && entries + item.promptBytes + frame(count + 1) > budget) {
      item.suggested = false;
      item.reason = 'over-budget';
      continue;
    }
    item.suggested = true;
    entries += item.promptBytes;
    count += 1;
  }
}

/** Where a fixture candidate "came from" — spread over all four so a checklist shows them. */
function sourcesFor(id: string): RankedEntitySource[] {
  const all: RankedEntitySource[][] = [['space'], ['teammate', 'space'], ['task'], ['inherited', 'space']];
  return all[hash(`src:${id}`) % all.length]!;
}

export function createJevFixture(read: () => readonly EntitySummary[]): FixtureJev {
  let scenario: FixtureJevScenario = 'ok';
  let delayMs = 0;
  const requests: LaunchSuggestInput[] = [];
  /** Idempotency: a repeated requestId returns the recorded answer, uncharged. */
  const answered = new Map<string, LaunchSuggestResult>();
  const runTotals = new Map<string, JevCost>();

  const live = (kind: string) => read().filter((row) => row.state.kind === kind && !row.deletedAt);

  const contextIndex = (): 'on' | 'off' => (scenario === 'index_off' ? 'off' : 'on');

  function entityGroup(group: EntityGroup, input: LaunchSuggestInput): JevGroupResult<EntitySuggestion> {
    if (!input.teamMemberId) return { status: 'skipped', reason: 'no_teammate', cost: ZERO };
    const kinds: readonly string[] = group === 'memories' ? ['memory'] : group === 'skills' ? ['skill'] : SPAWN_SELECTION_REFERENCE_KINDS;
    // The subject itself is not its own reference.
    const rows = read().filter((row) => kinds.includes(row.state.kind) && !row.deletedAt && row.id !== input.subjectId);
    if (rows.length === 0) return { status: 'skipped', reason: 'no_candidates', cost: ZERO };
    const considered = rows.slice(0, CANDIDATE_LIMIT);
    const index = contextIndex();
    const items = considered
      .map((row) => ranked(row, row.state.kind as RankedEntity['kind'], sourcesFor(row.id)))
      .sort((a, b) => b.score - a.score);
    if (index === 'off') {
      // `promptBytes` never counts bytes that do not reach the prompt.
      for (const item of items) {
        if (group === 'references') item.promptBytes = 0;
        if (group === 'skills') item.promptBytes = 40 + (hash(`line:${item.entityId}`) % 80);
      }
    }
    const budget = index === 'off' && group === 'references'
      ? null
      : (scenario === 'tight_budget' ? TIGHT : BUDGETS)[group];
    fillByBudget(group, items, budget, FLOOR, index);
    const calls = Math.ceil(considered.length / CHUNK);
    return {
      status: 'ok',
      value: { items, considered: considered.length, total: rows.length, budget, floor: FLOOR },
      cost: costFor(calls, considered.length),
    };
  }

  function teammatesGroup(): JevGroupResult<TeammateSuggestion> {
    const rows = live('team_member');
    if (rows.length === 0) return { status: 'skipped', reason: 'no_candidates', cost: ZERO };
    const items = rows
      .map((row) => ranked(row, 'team_member', ['space']))
      .sort((a, b) => b.score - a.score);
    for (const item of items) item.suggested = item.score >= 1;
    return {
      status: 'ok',
      value: { items, noFit: items.every((item) => item.score < 1), floor: 1 },
      cost: costFor(Math.ceil(items.length / CHUNK), items.length),
    };
  }

  function modelGroup(): JevGroupResult<ModelSuggestion> {
    return {
      status: 'ok',
      value: {
        tier: 'standard',
        model: 'claude-sonnet-5',
        agentTool: 'claude-code',
        effort: 'high',
        need: 1.2,
        workKind: 'feature',
        reasons: [
          'Reasoning depth reads moderate: a UI change with known seams.',
          'Blast radius is one package, so premium is not required.',
        ],
      },
      cost: costFor(1, 0),
    };
  }

  function answer(group: LaunchSuggestGroup, input: LaunchSuggestInput): JevGroupResult<unknown> {
    if (scenario === 'no_key') return { status: 'failed', reason: 'no_key', cost: ZERO };
    // A failed call is still costed: it was made.
    if (scenario === 'group_failed' && group === 'skills') {
      return { status: 'failed', reason: 'timeout', cost: { ...costFor(1, 0), latencyMs: 5000 } };
    }
    switch (group) {
      case 'model': return modelGroup();
      case 'teammates': return teammatesGroup();
      case 'memories':
      case 'skills':
      case 'references': return entityGroup(group, input);
    }
  }

  const port: JevPort = {
    async suggest(_spaceId, input) {
      requests.push(structuredClone(input));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (scenario === 'not_implemented') {
        throw new CollabError('not_implemented', 'launch.suggest is not implemented on this node');
      }
      const prior = answered.get(input.requestId);
      if (prior) return structuredClone(prior);
      const groups: LaunchSuggestResult['groups'] = {};
      let spent = ZERO;
      for (const group of input.groups) {
        const result = answer(group, input);
        spent = add(spent, result.cost);
        (groups as Record<string, unknown>)[group] = result;
      }
      const run = add(runTotals.get(input.runId) ?? ZERO, spent);
      runTotals.set(input.runId, run);
      const result: LaunchSuggestResult = { runId: input.runId, groups, contextIndex: contextIndex(), run };
      answered.set(input.requestId, result);
      return structuredClone(result);
    },
  };

  return {
    port,
    setScenario(next) { scenario = next; },
    setDelay(ms) { delayMs = ms; },
    requests,
  };
}
