// The ledger is the answer to "show me the saving", so its arithmetic is the
// part most worth being paranoid about. The failure it is written against:
// a session that has both a projection and a realised figure being counted
// twice, which would roughly double every number an operator reads.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLedger,
  entryFromActivation,
  foldLedger,
  readLedger,
  type RoutingActivation,
} from '../src/index.js';

function activation(over: Partial<RoutingActivation> = {}): RoutingActivation {
  return {
    at: '2026-09-21T12:00:00.000Z',
    mode: 'inline',
    policy: 'advise',
    jevModel: 'jev-1.13.0',
    latencyMs: 900,
    jevInputTokens: 1200,
    jevCostUsd: 0.00005,
    verdict: {
      tier: 'economy',
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
      need: 0.4,
      reasons: [],
      attention: 0,
    },
    baselineModel: 'claude-sonnet-5',
    appliedModel: 'claude-haiku-4-5-20251001',
    appliedAgentTool: 'claude-code',
    changed: true,
    overriddenByHuman: false,
    savings: {
      baselineTier: 'standard',
      chosenTier: 'economy',
      baselineUsd: 0.3,
      chosenUsd: 0.1,
      savedUsd: 0.2,
      savedPct: 66.7,
      jevCostUsd: 0.00005,
      netSavedUsd: 0.19995,
      measured: false,
      assumption: 'counterfactual',
    },
    summary: 'routed down a tier',
    ...over,
  };
}

describe('routing ledger', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-jev-ledger-'));
    path = join(dir, 'nested', 'routing-ledger.jsonl');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through a file it creates itself', async () => {
    expect(await readLedger(path)).toEqual([]);
    expect(
      await appendLedger(path, entryFromActivation({ activation: activation(), sessionId: 's1' })),
    ).toBe(true);
    const rows = await readLedger(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: 'projected',
      sessionId: 's1',
      baselineModel: 'claude-sonnet-5',
      chosenModel: 'claude-haiku-4-5-20251001',
      savedUsd: 0.2,
    });
  });

  it('counts a settled session once, at its realised figure', async () => {
    const a = activation();
    await appendLedger(path, entryFromActivation({ activation: a, sessionId: 's1' }));
    await appendLedger(
      path,
      entryFromActivation({
        activation: a,
        sessionId: 's1',
        stage: 'realised',
        savings: { ...a.savings!, baselineUsd: 0.5, chosenUsd: 0.18, savedUsd: 0.32 },
      }),
    );
    const fold = foldLedger(await readLedger(path));

    expect(fold.rows).toHaveLength(1);
    expect(fold.totals.decisions).toBe(1);
    // 0.32, not 0.52 — the projection was superseded, not added to.
    expect(fold.totals.grossSavedUsd).toBeCloseTo(0.32, 6);
    expect(fold.realised).toBe(1);
    expect(fold.projected).toBe(0);
  });

  it('keeps a realised row even when a later projection arrives', async () => {
    const a = activation();
    await appendLedger(path, entryFromActivation({ activation: a, sessionId: 's1', stage: 'realised' }));
    await appendLedger(path, entryFromActivation({ activation: a, sessionId: 's1' }));
    expect(foldLedger(await readLedger(path)).rows[0]?.stage).toBe('realised');
  });

  it('totals a mixed ledger and reports the return on the router itself', async () => {
    const cheaper = activation();
    const dearer = activation({
      baselineModel: 'claude-sonnet-5',
      appliedModel: 'claude-opus-5',
      savings: { ...cheaper.savings!, baselineUsd: 0.3, chosenUsd: 0.9, savedUsd: -0.6 },
    });
    const agreed = activation({
      appliedModel: 'claude-sonnet-5',
      changed: false,
      savings: { ...cheaper.savings!, baselineUsd: 0.3, chosenUsd: 0.3, savedUsd: 0 },
    });
    await appendLedger(path, entryFromActivation({ activation: cheaper, sessionId: 's1' }));
    await appendLedger(path, entryFromActivation({ activation: dearer, sessionId: 's2' }));
    await appendLedger(path, entryFromActivation({ activation: agreed, sessionId: 's3' }));

    const { totals } = foldLedger(await readLedger(path));
    expect(totals).toMatchObject({ decisions: 3, routedCheaper: 1, routedDearer: 1, routedSame: 1 });
    // A deliberate upgrade shows as a NEGATIVE saving. The production floor
    // spends more on purpose and the ledger must not hide that.
    expect(totals.grossSavedUsd).toBeCloseTo(-0.4, 6);
    expect(totals.jevSpendUsd).toBeCloseTo(0.00015, 6);
  });

  it('skips a half-written final line rather than refusing the report', async () => {
    const good = JSON.stringify(entryFromActivation({ activation: activation(), sessionId: 's1' }));
    await writeFile(path.replace('/nested/', '/'), `${good}\n{"sessionId":"s2","st`, 'utf8');
    const rows = await readLedger(path.replace('/nested/', '/'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('s1');
  });

  it('reports failure instead of throwing when the path is unwritable', async () => {
    // A ledger write must never be able to fail a spawn or an exit path. A
    // regular file standing where a directory is needed is the cheapest way
    // to make the write genuinely impossible.
    await writeFile(join(dir, 'file.txt'), 'not a directory', 'utf8');
    expect(
      await appendLedger(
        join(dir, 'file.txt', 'nope.jsonl'),
        entryFromActivation({ activation: activation(), sessionId: 's1' }),
      ),
    ).toBe(false);
  });
});
