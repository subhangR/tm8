// @tm8/jev — the routing ledger: an append-only record of what every decision
// chose, what it cost to decide, and what the alternative was worth.
//
// WHY A FILE AND NOT A TABLE. "Show me the saving" needs somewhere to read it
// from, and the two obvious homes were both wrong. The manifest is an immutable
// launch record — a session's realised cost arrives hours later and must not
// rewrite what was launched. A new Postgres table means a migration, which is
// the one thing this feature was designed not to need: a node that never routes
// must be byte-identical to tm8 today, and a migration is not nothing.
//
// So: one JSONL file per node, beside `manifests/` under the same data root and
// the same confidentiality boundary. Appends are atomic at this size, a partial
// line is skipped rather than fatal, and losing the file loses a report, not a
// session.
//
// TWO ROWS PER SESSION, BY DESIGN. `projected` is written at the decision, from
// a counterfactual. `realised` is written when the session ends and its true
// token profile is known. The later row supersedes, and `foldLedger` keeps the
// last row per session — which is why a crashed session still shows its
// projection rather than disappearing from the ledger entirely.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RoutingActivation } from './advisor.js';
import type { SavingsEstimate, SavingsLedgerRow, SavingsTotals } from './savings.js';
import { totalSavings } from './savings.js';

export const LEDGER_FILENAME = 'routing-ledger.jsonl';

export type LedgerStage = 'projected' | 'realised';

export interface RoutingLedgerEntry {
  readonly at: string;
  readonly stage: LedgerStage;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly entity: 'work_session' | 'chat';
  readonly policy: RoutingActivation['policy'];
  readonly tier: string;
  readonly baselineModel: string;
  readonly chosenModel: string;
  readonly agentTool: string;
  readonly changed: boolean;
  readonly overriddenByHuman: boolean;
  readonly jevCostUsd: number;
  readonly jevLatencyMs: number;
  readonly baselineUsd: number | null;
  readonly chosenUsd: number | null;
  readonly savedUsd: number | null;
  /**
   * Whether the CHOSEN side of this row came from real token counts.
   *
   * Never true for the difference: the baseline is a model that did not run,
   * so its cost is always a counterfactual. Carried per-row rather than
   * inferred from `stage` because a realised row whose settle step could not
   * price the session is still a realised row, and a reader must be able to
   * tell the two apart without trusting the stage label.
   */
  readonly measured: boolean;
  readonly summary: string;
}

export function entryFromActivation(input: {
  activation: RoutingActivation;
  sessionId: string;
  taskId?: string | null;
  entity?: 'work_session' | 'chat';
  stage?: LedgerStage;
  savings?: SavingsEstimate | null;
}): RoutingLedgerEntry {
  const a = input.activation;
  const s = input.savings === undefined ? a.savings : input.savings;
  return {
    at: new Date().toISOString(),
    stage: input.stage ?? 'projected',
    sessionId: input.sessionId,
    taskId: input.taskId ?? null,
    entity: input.entity ?? 'work_session',
    policy: a.policy,
    tier: a.verdict.tier,
    baselineModel: a.baselineModel,
    chosenModel: a.appliedModel,
    agentTool: a.appliedAgentTool,
    changed: a.changed,
    overriddenByHuman: a.overriddenByHuman,
    jevCostUsd: a.jevCostUsd,
    jevLatencyMs: a.latencyMs,
    measured: s?.measured ?? false,
    baselineUsd: s?.baselineUsd ?? null,
    chosenUsd: s?.chosenUsd ?? null,
    savedUsd: s?.savedUsd ?? null,
    summary: a.summary,
  };
}

/**
 * Append one row. Never throws — a ledger write is bookkeeping and must not be
 * able to fail a spawn or an exit path, both of which call this.
 */
export async function appendLedger(
  path: string,
  entry: RoutingLedgerEntry,
  logger?: { warn?: (m: string, meta?: Record<string, unknown>) => void },
): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    logger?.warn?.('jev: could not append to the routing ledger', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Read every well-formed row. A truncated tail line is skipped, not fatal. */
export async function readLedger(path: string): Promise<RoutingLedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: RoutingLedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as RoutingLedgerEntry;
      if (parsed && typeof parsed.sessionId === 'string') out.push(parsed);
    } catch {
      // A half-written final line is the expected case: the process died
      // mid-append. Dropping it is right; refusing the whole report is not.
    }
  }
  return out;
}

export interface LedgerFold {
  readonly totals: SavingsTotals;
  /** Last row per session — realised where we have it, projected where we do not. */
  readonly rows: RoutingLedgerEntry[];
  readonly realised: number;
  readonly projected: number;
}

/**
 * Collapse the ledger to one row per session and total it.
 *
 * A session with both rows counts ONCE, at its realised figure. Counting both
 * would double the saving, which is the single easiest way for a number like
 * this to become a lie.
 */
export function foldLedger(entries: readonly RoutingLedgerEntry[]): LedgerFold {
  const bySession = new Map<string, RoutingLedgerEntry>();
  for (const e of entries) {
    const held = bySession.get(e.sessionId);
    // `realised` always wins; otherwise the later row does.
    if (!held || e.stage === 'realised' || held.stage !== 'realised') bySession.set(e.sessionId, e);
  }
  const rows = [...bySession.values()];
  const ledgerRows: SavingsLedgerRow[] = rows.map((r) => ({
    ...(r.taskId ? { taskId: r.taskId } : {}),
    sessionId: r.sessionId,
    baselineModel: r.baselineModel,
    chosenModel: r.chosenModel,
    savedUsd: r.savedUsd ?? 0,
    jevCostUsd: r.jevCostUsd,
  }));
  return {
    totals: totalSavings(ledgerRows),
    rows,
    realised: rows.filter((r) => r.stage === 'realised').length,
    projected: rows.filter((r) => r.stage === 'projected').length,
  };
}
