/**
 * The teammate roster every space starts with: ROLES, not models.
 *
 * Two callers, one definition: boot seeds spaces that predate a role
 * (launch-resources.ts), and `spaces.create` seeds a brand-new space so it is
 * launchable immediately rather than at the next restart.
 *
 * A teammate is a context piece — persona, memories, skills — and the model is
 * a setting on it, overridable per launch. The roster used to hold one teammate
 * per LAUNCH_MODEL_CATALOG row (24 of them), which named models rather than
 * jobs; those are retired below and no longer seeded.
 *
 * SEEDED ONCE, THEN HANDS OFF. A role counts as present when ANY teammate —
 * soft-deleted included — carries its name or its seeded persona, so a default
 * you delete stays deleted and one you rename is not re-minted beside it. Boot
 * never rewrites a seeded teammate's model or tool: the owner chose it. (The
 * previous pass did both — it re-created deleted rows and reset edited models
 * to the catalog's on every restart.)
 */
import { HOUSE_TEAMMATE_NAMES, LAUNCH_MODEL_CATALOG, type HouseTeammateKey } from '@tm8/contract';
import type { Querier } from '../db/types.js';

interface TeammateRow {
  id: string;
  version: number;
  name: string;
  identity: string | null;
  model: string | null;
  agent_tool: string | null;
  deleted: boolean;
}

export interface DefaultTeammateResult {
  created: number;
  updated: number;
  /** Per-model teammates soft-deleted by the one-time sweep. */
  retired: number;
  /** Seeded loops (D8). Separate from `created` — a loop is not a teammate. */
  loopsCreated?: number;
}

interface HouseTeammate {
  key: HouseTeammateKey;
  role: string;
  mode: 'worker' | 'coordinator' | 'dispatcher';
  model: string;
  agentTool: string;
  persona: string;
}

export async function ensureDefaultTeammates(
  q: Querier,
  spaceId: string,
): Promise<DefaultTeammateResult> {
  // Deleted rows are read on purpose: they are what makes "seed once" true.
  const rows = await q.query<TeammateRow>(
    `select entity_row.id::text id, entity_row.version, teammate.name,
            teammate.identity, teammate.model, teammate.agent_tool,
            entity_row.deleted_at is not null deleted
       from public.entities entity_row
       join public.team_members teammate on teammate.entity_id = entity_row.id
      where entity_row.space_id = $1`,
    [spaceId],
  );

  let created = 0;
  let updated = 0;

  // Repair the historical smoke seed so the current UI stops presenting an
  // unknown tool with an empty model picker after restart. A no-op in a space
  // that never had one.
  const smoke = rows.find((row) => row.name === 'Smoke Agent' && !row.deleted);
  if (smoke && (smoke.model === null || smoke.agent_tool === null)) {
    await updateTeammate(q, smoke, 'claude-sonnet-5', 'claude-code', spaceId);
    updated += 1;
  }

  for (const house of HOUSE_TEAMMATES) {
    const name = HOUSE_TEAMMATE_NAMES[house.key];
    if (rows.some((row) => row.name === name || row.identity === house.persona)) continue;
    await q.rpc('public.create_team_member', [
      spaceId,
      name,
      null,
      house.role,
      house.persona,
      house.model,
      house.agentTool,
      house.mode,
      null,
      JSON.stringify({}),
      JSON.stringify({}),
      null,
      null,
      null,
      `bootstrap:teammate:${spaceId}:${house.key}`,
    ]);
    created += 1;
  }

  const retired = await retireModelTeammates(q, spaceId);
  const loopsCreated = await ensureDreamerLoop(q, spaceId);

  return { created, updated, retired, loopsCreated };
}

/**
 * The per-model teammates the roster used to seed, by the names it gave them.
 * FROZEN: these are historical rows to retire, not a catalog to follow, so a
 * model added to LAUNCH_MODEL_CATALOG later must not appear here.
 */
export const RETIRED_MODEL_TEAMMATE_NAMES: readonly string[] = [
  'Opus 5 Teammate',
  'Opus 5 1M Teammate',
  'Opus 5.5 Teammate',
  'Opus 5.5 1M Teammate',
  'Fable 5 Teammate',
  'Fable 5 1M Teammate',
  'Fable 5.1 Teammate',
  'Fable 5.1 1M Teammate',
  'GPT 6 Astra Teammate',
  'GPT 5.6 Teammate',
  'GPT 5.6 Terra Teammate',
  'GPT 5.6 Luna Teammate',
  'Sonnet 5 Teammate',
  'Haiku 4.5 Teammate',
  'Kimi K2 Thinking Teammate',
  'Kimi K2 Thinking Turbo Teammate',
  'Kimi K2 Turbo Teammate',
  'Kimi K2 0905 Teammate',
  'GPT-OSS 120B Teammate',
  'GPT-OSS 20B Teammate',
  'Kimi K2 Instruct Groq Teammate',
  'Llama 3.3 70B Teammate',
  'Qwen3 32B Teammate',
  'DeepSeek R1 Distill 70B Teammate',
];

/** The role the old per-model seed wrote. A row whose owner changed it is theirs now. */
const RETIRED_MODEL_TEAMMATE_ROLE = 'Launch persona';

/**
 * Soft-delete the per-model teammates, except any with a live session.
 *
 * DEFERRED, NOT FORCED: a teammate with a spawning, running or idle session is
 * skipped, because spawn and resume both resolve the persona as a LIVE entity
 * and deleting it under a working agent would strand that agent. The next boot
 * tries again, so each one goes once its sessions have exited. A session names
 * its teammate by a `relates_to` edge (every `spawn_work_session` since 048).
 *
 * Soft-delete only — `entities.restore` brings one back, and the sessions,
 * messages and memories that point at it keep their history.
 */
async function retireModelTeammates(q: Querier, spaceId: string): Promise<number> {
  const retiring = await q.query<{ id: string }>(
    `select entity_row.id::text id
       from public.entities entity_row
       join public.team_members teammate on teammate.entity_id = entity_row.id
      where entity_row.space_id = $1
        and entity_row.deleted_at is null
        and teammate.role = $2
        and teammate.name = any($3::text[])
        and not exists (
          select 1
            from public.edges edge
            join public.entities session_row on session_row.id = edge.src_id
            join public.work_sessions session on session.entity_id = session_row.id
           where edge.dst_id = entity_row.id
             and edge.type = 'relates_to'
             and session_row.deleted_at is null
             and session.status in ('spawning', 'running', 'idle'))
      order by 1`,
    [spaceId, RETIRED_MODEL_TEAMMATE_ROLE, RETIRED_MODEL_TEAMMATE_NAMES],
  );
  for (const row of retiring) {
    await q.rpc('public.delete_entity', [row.id, null, `bootstrap:teammate-retire:${spaceId}:${row.id}`]);
  }
  return retiring.length;
}

/**
 * The Dreamer's daily loop (D8), seeded ENABLED.
 *
 * Enabled from day one is a deliberate ruling, not an oversight: a cleanup pass
 * that ships disabled is a cleanup pass nobody ever turns on, and the memory
 * graph degrades silently in exactly the spaces that were never tended. The
 * loop is an ordinary entity — a human can disable or retime it in the UI.
 *
 * Seeded once, by TITLE within the space — a deleted loop counts, so disabling
 * the sweep by deleting it survives the next restart. `next_run_at` is seeded a day out rather than null so the first firing is
 * scheduled rather than waiting for someone to save the loop once.
 */
async function ensureDreamerLoop(q: Querier, spaceId: string): Promise<number> {
  const existing = await q.query<{ id: string }>(
    `select e.id::text id
       from public.entities e
       join public.loops l on l.entity_id = e.id
      where e.space_id = $1 and l.title = $2
      limit 1`,
    [spaceId, DREAMER_LOOP_TITLE],
  );
  if (existing.length > 0) return 0;

  const dreamer = await q.query<{ id: string }>(
    `select e.id::text id
       from public.entities e
       join public.team_members t on t.entity_id = e.id
      where e.space_id = $1 and e.deleted_at is null
        and (t.name = $2 or t.identity = $3)
      limit 1`,
    [spaceId, HOUSE_TEAMMATE_NAMES.dreamer, DREAMER_PERSONA],
  );
  const dreamerId = dreamer[0]?.id;
  // No Dreamer means the teammate insert above was refused (a space whose owner
  // is not a member yet — the existing catch in the caller). Seeding a loop
  // that names nobody would route every firing through the dispatcher, which is
  // not what "the Dreamer's loop" means. Skip; the next boot pass repairs both.
  if (!dreamerId) return 0;

  await q.rpc('public.create_loop', [
    spaceId,
    DREAMER_LOOP_TITLE,
    null,
    'every 1d',
    dreamerId,
    null,
    DREAMER_LOOP_PROMPT,
    JSON.stringify({}),
    true,
    new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    null,
    null,
    `bootstrap:loop:${spaceId}:dreamer`,
  ]);
  return 1;
}

export const DISPATCHER_SEED_NAME = HOUSE_TEAMMATE_NAMES.dispatcher;
export const DREAMER_SEED_NAME = HOUSE_TEAMMATE_NAMES.dreamer;
export const DREAMER_LOOP_TITLE = 'Dreamer daily sweep';

const DREAMER_MODEL = LAUNCH_MODEL_CATALOG[0]?.model ?? 'claude-opus-5';
const DREAMER_AGENT_TOOL = LAUNCH_MODEL_CATALOG[0]?.agentTool ?? 'claude';

/** The instruction each firing carries. Short: the persona is the real brief. */
const DREAMER_LOOP_PROMPT =
  'Daily memory sweep. Walk this space\'s teammates and the memories they '
  + 'remember, mark what is stale or contradicted, and consolidate overlapping '
  + 'clusters. Report what you changed on this task.';

/**
 * D7, stated as prohibitions first because the destructive reading of "clean up
 * the memory graph" is the dangerous one.
 *
 * The substrate already resists it: `supersedes` and `disputes` are append-only
 * (056), so a deletion RAISES rather than succeeding quietly. This persona is
 * written to work WITH that rather than to discover it as an error — an agent
 * that believes it should be deleting will spend its run fighting a trigger.
 */
const DREAMER_PERSONA =
  'You tend this space\'s memory graph so that what gets injected into future '
  + 'sessions stays true. You work in two moves, MARK and CONSOLIDATE, and you '
  + 'never delete anything.\n\n'
  + 'MARK. Walk the teammates and the memories they `remembers`. When a memory '
  + 'contradicts newer evidence, references an entity that no longer exists, or '
  + 'describes a behaviour that has since changed, record that. A `disputes` '
  + 'edge must come FROM an evidence-bearing entity — a memory or a message, '
  + 'never a teammate — so author the evidence first and dispute from it; the '
  + 'edge requires quote, expected, observed and pinnedVersion, and the pin is '
  + 'the version you actually read. This is the cheap mark: use it freely.\n\n'
  + 'CONSOLIDATE. When several memories say overlapping things, author ONE '
  + 'merged memory that states the claim properly with its mechanism and scope, '
  + 'point `supersedes` edges (props.reason is required — say what the merge '
  + 'fixed) from it to each memory it replaces, and move the holders\' '
  + '`remembers` edges onto the consolidated memory so the working set actually '
  + 'shrinks. A consolidation that leaves the old edges in place has added a '
  + 'memory instead of replacing several.\n\n'
  + 'NEVER hard-delete a memory or an edge: `supersedes` and `disputes` are '
  + 'append-only and a deletion will be refused by the database, correctly. A '
  + 'wrong memory is superseded, not erased — the record of having believed it '
  + 'is itself worth keeping. NEVER edit any teammate\'s identity, persona, '
  + 'model or configuration; you tend memories, not people. Editing a memory\'s '
  + 'text is for typos only, and it bumps the version, which un-pins every '
  + 'verification pointing at it — so if the meaning changed, supersede instead.\n\n'
  + 'Every run, send `tm8 message send --to <task-id> \"<body>\"` on your task '
  + 'with what you marked, what you consolidated and what you deliberately left '
  + 'alone. A sweep nobody can see did not happen.';

const DISPATCHER_PERSONA =
  'You route work; you never do it. When a dispatch request names a task, read '
  + 'the roster and the memory graph, pick the existing teammate whose persona and '
  + 'memories fit it best, attach the memories they will need to the task, and '
  + 'spawn them on it. Then say on the task anchor who you picked and why you '
  + 'picked them over the others — that sentence is the only record of your '
  + 'judgement anyone will ever read. You do not create, edit or delete teammates, '
  + 'and you do not edit anyone\'s persona or model. If nobody on the roster fits, '
  + 'say so rather than dispatching badly or doing the task yourself.';

/**
 * The strongest model the node offers, pinned by id rather than by catalog
 * position: the design and judgement roles — routing, coordinating, reviewing,
 * shaping teammates and graphs — are the jobs where a weaker pick is expensive
 * and invisible, because a bad call looks exactly like a good one until it
 * fails. Owner ruling on the Default Teammates task: "max is opus 5.5".
 */
const TOP_MODEL = 'claude-opus-5-5[1m]';

const WORKER_PERSONA =
  'You do the work on the task you are given, end to end. Read the task and its '
  + 'attached memories first, make the change, and verify it the way the task '
  + 'asks — a green typecheck, the focused tests, the build. Commit and push '
  + 'early, open the pull request and link it to the task. Then say on the task '
  + 'what you changed, what you verified and what you did not. If you are '
  + 'blocked, say so on the task rather than guessing past it.';

const COORDINATOR_PERSONA =
  'You coordinate; you rarely write the code yourself. Break the goal into '
  + 'tasks small enough for one worker each, spawn workers on them, and keep '
  + 'the tasks, not your own head, as the record of who is doing what. Read '
  + 'what the workers report, send back what is wrong, and decide what nobody '
  + 'else can: scope, order, and when something is done. Post a short status '
  + 'on your anchor at every milestone and a close-out when the goal is met.';

const REVIEWER_PERSONA =
  'You review changes for correctness before they merge. Read the diff against '
  + 'its base and the task it claims to finish, then look for what would break: '
  + 'wrong behaviour, missed callers, tests that pass without testing the line '
  + 'that matters. Report each finding with the file and line, the input that '
  + 'fails and what happens; say plainly when you found nothing. You do not '
  + 'rewrite the change yourself unless you are asked to.';

const HELPER_PERSONA =
  'You help people use tm8. Answer questions about how the product works — '
  + 'spaces, tasks, teammates, sessions, memories, skills, chats and the `tm8` '
  + 'command line — from what this node actually offers: ask `tm8 help` for '
  + 'the current grammar rather than recalling it, and show the exact command '
  + 'when one answers the question. When something is not possible, say so '
  + 'and name the closest thing that is.';

const TEAMMATE_MANAGER_PERSONA =
  'You shape the roster; you do not change it yourself. When someone needs a '
  + 'teammate, draft it: a name, the persona in full, the model and why, and '
  + 'the memories and skills it should start with. Post the draft for a human '
  + 'to approve — creating, editing and deleting teammates is the owner\'s '
  + 'call, and the graph will refuse it from you. Review the existing roster '
  + 'the same way: propose merges, retirements and persona fixes, with reasons.';

const GRAPH_ARCHITECT_PERSONA =
  'You design with the graph as your material. In a Craft chat you draw the '
  + 'blueprint for what someone wants built: the tasks, the teammates who own '
  + 'them, the memories and skills they need, and the edges between them. Keep '
  + 'the blueprint honest — every node something that can really exist, every '
  + 'edge a relation tm8 really has. Teammate specs are proposals for a human '
  + 'to confirm; nothing is materialized until the blueprint is approved.';

/** The seeded roster, in seeding order. Names come from HOUSE_TEAMMATE_NAMES. */
const HOUSE_TEAMMATES: readonly HouseTeammate[] = [
  { key: 'worker', role: 'Worker', mode: 'worker', model: TOP_MODEL, agentTool: 'claude-code', persona: WORKER_PERSONA },
  { key: 'coordinator', role: 'Coordinator', mode: 'coordinator', model: TOP_MODEL, agentTool: 'claude-code', persona: COORDINATOR_PERSONA },
  { key: 'reviewer', role: 'Reviewer', mode: 'worker', model: TOP_MODEL, agentTool: 'claude-code', persona: REVIEWER_PERSONA },
  { key: 'helper', role: 'Helper', mode: 'worker', model: 'claude-sonnet-5', agentTool: 'claude-code', persona: HELPER_PERSONA },
  { key: 'teammateManager', role: 'Teammate Manager', mode: 'worker', model: TOP_MODEL, agentTool: 'claude-code', persona: TEAMMATE_MANAGER_PERSONA },
  { key: 'graphArchitect', role: 'Graph Architect', mode: 'worker', model: TOP_MODEL, agentTool: 'claude-code', persona: GRAPH_ARCHITECT_PERSONA },
  // The Dreamer (D7/D8) — a worker teammate, not a fifth mode. What makes it
  // the Dreamer is its persona and its loop: "not a new mechanism".
  { key: 'dreamer', role: 'Dreamer', mode: 'worker', model: DREAMER_MODEL, agentTool: DREAMER_AGENT_TOOL, persona: DREAMER_PERSONA },
  // The Dispatcher (D8). Seeded here because boot is the ONLY path that can:
  // teammate creation is owner-governed and agents get `forbidden`, so a
  // dispatcher that does not exist by the time someone calls
  // `execution.dispatch` can never be brought into being by the thing that
  // needs it.
  { key: 'dispatcher', role: 'Dispatcher', mode: 'dispatcher', model: TOP_MODEL, agentTool: 'claude-code', persona: DISPATCHER_PERSONA },
];

async function updateTeammate(
  q: Querier,
  teammate: TeammateRow,
  model: string,
  agentTool: string,
  spaceId: string,
): Promise<void> {
  await q.rpc('public.update_team_member', [
    teammate.id,
    teammate.version,
    null,
    null,
    null,
    null,
    model,
    agentTool,
    null,
    null,
    null,
    null,
    null,
    null,
    `bootstrap:teammate-update:${spaceId}:${teammate.id}:v${teammate.version}:${model}`,
  ]);
}
