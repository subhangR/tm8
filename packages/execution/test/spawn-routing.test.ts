// Model routing at the spawn seam (@tm8/jev).
//
// The claims, in the order they matter:
//   1. UNWIRED IS A NO-OP. No advisor means no routing block, no behaviour
//      change, and the same model the precedence chain always produced. This
//      is the claim the whole rollout rests on, so it is asserted first and
//      asserted by comparing two real spawns rather than by inspection.
//   2. A verdict actually reaches the launch — the model, the harness and the
//      effort all land on the manifest, which is what the PTY then runs.
//   3. THE ROUTER IS NEVER LOAD-BEARING. An advisor that throws, hangs past
//      its own budget, or returns nonsense leaves the spawn fully successful
//      and unrouted. A routing service being down must not be able to stop
//      tm8 spawning agents — the same rule the lane-fact write lives under.
//   4. The decision is visible. `launch.routing` carries what would have run,
//      what will, and what the difference is projected to cost.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutingActivation, RoutingAdvice, RoutingAdvisorPort } from '@tm8/jev';
import { LEDGER_FILENAME, foldLedger, readLedger } from '@tm8/jev';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskIds: [TASK_ID],
};

function activation(over: Partial<RoutingActivation> = {}): RoutingActivation {
  return {
    at: '2026-09-21T12:00:00.000Z',
    mode: 'inline',
    policy: 'advise',
    jevModel: 'jev-1.13.0',
    latencyMs: 930,
    jevInputTokens: 1262,
    jevCostUsd: 0.000053,
    verdict: {
      tier: 'economy',
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
      need: 0.45,
      reasons: ['reasoning_depth 0.4', 'blast_radius 0.3'],
      attention: 0,
    },
    baselineModel: 'sonnet',
    appliedModel: 'claude-haiku-4-5-20251001',
    appliedAgentTool: 'claude-code',
    changed: true,
    overriddenByHuman: false,
    savings: {
      baselineModel: 'sonnet',
      chosenModel: 'claude-haiku-4-5-20251001',
      baselineUsd: 0.21,
      chosenUsd: 0.07,
      jevCostUsd: 0.000053,
      savedUsd: 0.139947,
      savedPct: 66.6,
      measured: false,
      assumption: 'counterfactual: the same token profile priced at both models',
    },
    summary: 'Jev routed sonnet -> claude-haiku-4-5-20251001 (economy, need 0.45) — cheaper.',
    ...over,
  };
}

/** An advisor with no network anywhere near it. */
function fixedAdvisor(advice: RoutingAdvice | null): RoutingAdvisorPort {
  return { advise: vi.fn(async () => advice) };
}

describe('SpawnService model routing', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;

  function serviceWith(routingAdvisor?: RoutingAdvisorPort): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      ...(routingAdvisor ? { routingAdvisor } : {}),
    });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-route-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-route-project-'));
    graph = new FakeGraph({ workingDir: projectDir, model: 'sonnet' });
    pty = new PtyHostService();
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('is a no-op when no advisor is wired', async () => {
    await serviceWith().spawn(AUTH, REQUEST);
    const manifest = graph.manifests[0]?.manifest;
    expect(manifest?.launch.model).toBe('sonnet');
    expect(manifest?.launch.routing).toBeNull();
  });

  it('falls back to the chain tm8 always had when the router has no opinion', async () => {
    // `null` is not an edge case, it is the shape of EVERY Jev failure: the
    // client swallows timeouts, 401s, 429s and unparseable bodies and returns
    // `null` rather than throwing, so this is what a Jev outage actually looks
    // like from here. Verified against the live API on 2026-09-22 — a refused
    // endpoint, a dead DNS name, a bad key, a 1ms budget and a non-Jev JSON
    // body all produced `null` and none threw.
    //
    // The assertion is not "it did not crash". It is that the launch is
    // INDISTINGUISHABLE from the unrouted one: same model, same null routing
    // block on the manifest. Old logic is not bypassed when Jev is silent; it
    // is the fallback, and it still decides.
    const unrouted = serviceWith();
    await unrouted.spawn(AUTH, REQUEST);
    const baseline = graph.manifests[0]?.manifest.launch;

    graph.manifests.length = 0;
    graph.created.length = 0;

    const advisor = fixedAdvisor(null);
    await serviceWith(advisor).spawn(AUTH, REQUEST);
    const routed = graph.manifests[0]?.manifest.launch;

    expect(advisor.advise).toHaveBeenCalledTimes(1);
    expect(routed?.model).toBe(baseline?.model);
    expect(routed?.model).toBe('sonnet');
    expect(routed?.routing).toBeNull();
  });

  it('applies the verdict to the model, harness and effort the PTY will run', async () => {
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    await serviceWith(advisor).spawn(AUTH, REQUEST);

    const launch = graph.manifests[0]?.manifest.launch;
    expect(launch?.model).toBe('claude-haiku-4-5-20251001');
    expect(launch?.reasoningEffort).toBe('medium');
    // The row the graph keeps must name the same model as the manifest.
    expect(graph.created[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('hands the advisor the task facts the seam already carried', async () => {
    const advisor = fixedAdvisor(null);
    await serviceWith(advisor).spawn(AUTH, REQUEST);

    expect(advisor.advise).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID, title: 'fixture task 1', priority: 'high' }),
      // Nobody named a model on this request, so the persona's is the baseline
      // and routing applies under every policy but `off`.
      { requestedModel: null, memberModel: 'sonnet', requestedAgentTool: null },
      'inline',
    );
  });

  it('routes a cross-provider verdict all the way to the harness', async () => {
    const codex = activation({
      verdict: {
        tier: 'premium',
        model: 'gpt-6-astra',
        agentTool: 'codex',
        effort: 'high',
        need: 2.4,
        reasons: ['harness_fit codex'],
        attention: 0,
      },
      appliedModel: 'gpt-6-astra',
      appliedAgentTool: 'codex',
    });
    const advisor = fixedAdvisor({
      verdict: codex.verdict,
      activation: codex,
      model: 'gpt-6-astra',
      agentTool: 'codex',
      effort: 'high',
    });
    await serviceWith(advisor).spawn(AUTH, REQUEST);

    const launch = graph.manifests[0]?.manifest.launch;
    expect(launch?.model).toBe('gpt-6-astra');
    expect(launch?.tool).toBe('codex');
  });

  it('spawns unrouted when the advisor throws', async () => {
    const advisor: RoutingAdvisorPort = {
      advise: vi.fn(async () => {
        throw new Error('routing service down');
      }),
    };
    const result = await serviceWith(advisor).spawn(AUTH, REQUEST);

    expect(result.sessionId).toBeTruthy();
    expect(graph.transitions.map((t) => t.status)).toEqual(['running']);
    const manifest = graph.manifests[0]?.manifest;
    expect(manifest?.launch.model).toBe('sonnet');
    expect(manifest?.launch.routing).toBeNull();
  });

  it('records the decision, its counterfactual and its own cost on the manifest', async () => {
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    await serviceWith(advisor).spawn(AUTH, REQUEST);

    const routing = graph.manifests[0]?.manifest.launch.routing;
    expect(routing).toMatchObject({
      baselineModel: 'sonnet',
      appliedModel: 'claude-haiku-4-5-20251001',
      changed: true,
      jevModel: 'jev-1.13.0',
    });
    // A saving quoted without the cost of producing it is the oldest way to
    // lie with a number, so both are on the record.
    expect(routing?.savings?.savedUsd).toBeCloseTo(0.139947, 6);
    expect(routing?.jevCostUsd).toBeGreaterThan(0);
    // And it is honest about being a projection, not a measurement.
    expect(routing?.savings?.measured).toBe(false);
  });

  it('writes a projected ledger row the moment it routes', async () => {
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    const result = await serviceWith(advisor).spawn(AUTH, REQUEST);

    const rows = await readLedger(join(dataDir, LEDGER_FILENAME));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: 'projected',
      sessionId: result.sessionId,
      taskId: TASK_ID,
      baselineModel: 'sonnet',
      chosenModel: 'claude-haiku-4-5-20251001',
    });
  });

  it('settles that row against the tokens the session really burned', async () => {
    // Driven through the private settle step rather than a real PTY exit: the
    // exit path's own job (locate a transcript on disk, parse both dialects)
    // is covered by the session-usage suite, and what is under test here is
    // the step after it — re-price the SAME decision on real counts and make
    // sure the projection does not survive alongside it.
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    const service = serviceWith(advisor);
    const { sessionId } = await service.spawn(AUTH, REQUEST);

    await (
      service as unknown as {
        settleRoutingLedger(id: string, usage: unknown): Promise<void>;
      }
    ).settleRoutingLedger(sessionId, {
      transcript: {
        totals: {
          inputTokens: 40_000,
          outputTokens: 12_000,
          cacheReadTokens: 900_000,
          cacheCreationTokens: 60_000,
        },
      },
    });

    const fold = foldLedger(await readLedger(join(dataDir, LEDGER_FILENAME)));
    // Two rows on disk, ONE session in the report. A projection that outlived
    // its own measurement would roughly double every figure an operator reads.
    expect(fold.rows).toHaveLength(1);
    expect(fold.totals.decisions).toBe(1);
    expect(fold.rows[0]?.stage).toBe('realised');
    // Priced on a million real tokens, the saving is nothing like the guess.
    expect(fold.rows[0]?.savedUsd).not.toBeCloseTo(0.139947, 6);
    expect(fold.rows[0]?.savedUsd).toBeGreaterThan(0);
    // Still a counterfactual on the baseline side, and still says so.
    expect(fold.rows[0]?.measured).toBe(false);
  });

  it('says out loud that it ran, even when it changed nothing', async () => {
    const agreed = activation({
      appliedModel: 'sonnet',
      changed: false,
      summary: 'Jev agrees with sonnet (standard, need 1.20).',
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      logger,
      routingAdvisor: fixedAdvisor({
        verdict: agreed.verdict,
        activation: agreed,
        model: 'sonnet',
        agentTool: 'claude-code',
        effort: null,
      }),
    });
    await service.spawn(AUTH, REQUEST);

    // Demoting agreement to debug is how a router quietly stops working.
    const line = logger.info.mock.calls.find((c) => String(c[0]).includes('Jev agrees'));
    expect(line).toBeDefined();
    expect(line?.[1]).toMatchObject({ changed: false, taskId: TASK_ID });
  });
  // --- resume: the decision must survive it ---------------------------------
  //
  // Resume recomposes the manifest from scratch and REWRITES the file. Every
  // other launch fact survives that because it lives in the graph; `routing`
  // and `contextEngineering` live in the manifest file and nowhere else, and
  // `composeManifest` defaults both to null. So a resume erased them — and
  // took the realised ledger row with them, because `settleRoutingLedger`
  // reads the block back out of that same file when the session ends.
  //
  // The cost was not a missing audit line. Every resumed session would have
  // kept its PROJECTED saving for good, and `foldLedger` would have folded a
  // counterfactual in the place where a measurement existed.

  it('re-reads the spawn-time decisions a resume is about to overwrite', async () => {
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    const service = serviceWith(advisor);
    const { sessionId } = await service.spawn(AUTH, REQUEST);

    const carried = await (
      service as unknown as {
        recordedDecisions(id: string): Promise<{ routing?: unknown }>;
      }
    ).recordedDecisions(sessionId);

    expect(carried.routing).toMatchObject({
      baselineModel: 'sonnet',
      appliedModel: 'claude-haiku-4-5-20251001',
      changed: true,
    });
  });

  it('fails open when there is no manifest to re-read', async () => {
    // A session spawned before this feature existed, or a manifest a person
    // deleted. Neither may cost anyone a resume: no blocks is exactly what a
    // launch before routing recorded, and that launch resumed fine.
    const service = serviceWith();
    const carried = await (
      service as unknown as {
        recordedDecisions(id: string): Promise<Record<string, unknown>>;
      }
    ).recordedDecisions('99999999-9999-4999-8999-999999999999');
    expect(carried).toEqual({});
  });

  it('cannot settle a session whose manifest lost its routing block', async () => {
    // The defect, reproduced at its consequence rather than its cause: strip
    // the block the way the old resume did, then end the session normally.
    const advisor = fixedAdvisor({
      verdict: activation().verdict,
      activation: activation(),
      model: 'claude-haiku-4-5-20251001',
      agentTool: 'claude-code',
      effort: 'medium',
    });
    const service = serviceWith(advisor);
    const { sessionId, manifestPath } = await service.spawn(AUTH, REQUEST);

    const stripped = JSON.parse(await readFile(manifestPath, 'utf8'));
    stripped.launch.routing = null;
    stripped.launch.contextEngineering = null;
    await writeFile(manifestPath, JSON.stringify(stripped), 'utf8');

    await (
      service as unknown as {
        settleRoutingLedger(id: string, usage: unknown): Promise<void>;
      }
    ).settleRoutingLedger(sessionId, {
      transcript: {
        totals: {
          inputTokens: 40_000,
          outputTokens: 12_000,
          cacheReadTokens: 900_000,
          cacheCreationTokens: 60_000,
        },
      },
    });

    // Still the projection, forever. This is what carrying the block forward
    // prevents, and why the carry-forward is not merely tidy bookkeeping.
    const fold = foldLedger(await readLedger(join(dataDir, LEDGER_FILENAME)));
    expect(fold.rows).toHaveLength(1);
    expect(fold.rows[0]?.stage).toBe('projected');
    expect(fold.realised).toBe(0);
  });
});
