/**
 * The teammate roster every space starts with.
 *
 * Two callers, one definition: boot repairs spaces that predate the catalog
 * (launch-resources.ts), and `spaces.create` seeds a brand-new space so it is
 * launchable immediately rather than at the next restart. A space with no
 * team_member rows offers nothing to launch, and the boot pass only ever sees
 * spaces that existed when the process started — so a space created at 10:00
 * stayed empty until someone restarted the node.
 *
 * Keyed by seed name and skipped when present, so running both passes over the
 * same space produces one roster, not two.
 */
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import type { Querier } from '../db/types.js';

interface TeammateRow {
  id: string;
  version: number;
  name: string;
  model: string | null;
  agent_tool: string | null;
}

export interface DefaultTeammateResult {
  created: number;
  updated: number;
  /** Seeded loops (D8). Separate from `created` — a loop is not a teammate. */
  loopsCreated?: number;
}

export async function ensureDefaultTeammates(
  q: Querier,
  spaceId: string,
): Promise<DefaultTeammateResult> {
  const rows = await q.query<TeammateRow>(
    `select entity_row.id::text id, entity_row.version, teammate.name,
            teammate.model, teammate.agent_tool
       from public.entities entity_row
       join public.team_members teammate on teammate.entity_id = entity_row.id
      where entity_row.space_id = $1 and entity_row.deleted_at is null`,
    [spaceId],
  );
  const byName = new Map(rows.map((row) => [row.name, row]));

  let created = 0;
  let updated = 0;

  // Repair the historical smoke seed so the current UI stops presenting an
  // unknown tool with an empty model picker after restart. A no-op in a space
  // that never had one.
  const smoke = byName.get('Smoke Agent');
  if (smoke && (smoke.model === null || smoke.agent_tool === null)) {
    await updateTeammate(q, smoke, 'claude-sonnet-5', 'claude-code', spaceId);
    updated += 1;
  }

  for (const entry of LAUNCH_MODEL_CATALOG) {
    const existing = byName.get(entry.seedName);
    if (!existing) {
      await q.rpc('public.create_team_member', [
        spaceId,
        entry.seedName,
        null,
        'Launch persona',
        `${entry.label} via ${entry.agentTool}`,
        entry.model,
        entry.agentTool,
        'worker',
        null,
        JSON.stringify({}),
        JSON.stringify({}),
        null,
        null,
        null,
        `bootstrap:teammate:${spaceId}:${entry.model}`,
      ]);
      created += 1;
    } else if (existing.model !== entry.model || existing.agent_tool !== entry.agentTool) {
      await updateTeammate(q, existing, entry.model, entry.agentTool, spaceId);
      updated += 1;
    }
  }

  // The Dreamer (D7/D8) — a worker teammate, not a fifth mode. Everything it
  // does is an ordinary graph write an ordinary worker can make; what makes it
  // the Dreamer is its persona and its loop, which is the whole point of D7:
  // "not a new mechanism".
  if (!byName.has(DREAMER_SEED_NAME)) {
    await q.rpc('public.create_team_member', [
      spaceId,
      DREAMER_SEED_NAME,
      null,
      'Dreamer',
      DREAMER_PERSONA,
      DREAMER_MODEL,
      DREAMER_AGENT_TOOL,
      'worker',
      null,
      JSON.stringify({}),
      JSON.stringify({}),
      null,
      null,
      null,
      `bootstrap:teammate:${spaceId}:dreamer`,
    ]);
    created += 1;
  }

  // The Dispatcher (D8). Seeded here because boot is the ONLY path that can:
  // teammate creation is owner-governed and agents get `forbidden`, so a
  // dispatcher that does not exist by the time someone calls
  // `execution.dispatch` can never be brought into being by the thing that
  // needs it. Keyed by seed name like every row above, so re-running boot over
  // a space that already has one is a no-op rather than a second dispatcher.
  if (!byName.has(DISPATCHER_SEED_NAME)) {
    await q.rpc('public.create_team_member', [
      spaceId,
      DISPATCHER_SEED_NAME,
      null,
      'Dispatcher',
      DISPATCHER_PERSONA,
      DISPATCHER_MODEL,
      DISPATCHER_AGENT_TOOL,
      'dispatcher',
      null,
      JSON.stringify({}),
      JSON.stringify({}),
      null,
      null,
      null,
      `bootstrap:teammate:${spaceId}:dispatcher`,
    ]);
    created += 1;
  }

  const loopsCreated = await ensureDreamerLoop(q, spaceId);

  return { created, updated, loopsCreated };
}

/**
 * The Dreamer's daily loop (D8), seeded ENABLED.
 *
 * Enabled from day one is a deliberate ruling, not an oversight: a cleanup pass
 * that ships disabled is a cleanup pass nobody ever turns on, and the memory
 * graph degrades silently in exactly the spaces that were never tended. The
 * loop is an ordinary entity — a human can disable or retime it in the UI.
 *
 * Idempotent by TITLE within the space, matching the seed-name keying above.
 * `next_run_at` is seeded a day out rather than null so the first firing is
 * scheduled rather than waiting for someone to save the loop once.
 */
async function ensureDreamerLoop(q: Querier, spaceId: string): Promise<number> {
  const existing = await q.query<{ id: string }>(
    `select e.id::text id
       from public.entities e
       join public.loops l on l.entity_id = e.id
      where e.space_id = $1 and e.deleted_at is null and l.title = $2
      limit 1`,
    [spaceId, DREAMER_LOOP_TITLE],
  );
  if (existing.length > 0) return 0;

  const dreamer = await q.query<{ id: string }>(
    `select e.id::text id
       from public.entities e
       join public.team_members t on t.entity_id = e.id
      where e.space_id = $1 and e.deleted_at is null and t.name = $2
      limit 1`,
    [spaceId, DREAMER_SEED_NAME],
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

export const DISPATCHER_SEED_NAME = 'Dispatcher';
export const DREAMER_SEED_NAME = 'Dreamer';
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

/**
 * Model and tool are the launch catalog's default rather than a cheap model.
 * Routing is a judgement call over the whole roster and the memory graph — the
 * one job where being wrong is expensive and invisible, because a badly routed
 * task looks exactly like a correctly routed one until it fails.
 */
const DISPATCHER_MODEL = LAUNCH_MODEL_CATALOG[0]?.model ?? 'claude-opus-5';
const DISPATCHER_AGENT_TOOL = LAUNCH_MODEL_CATALOG[0]?.agentTool ?? 'claude';

const DISPATCHER_PERSONA =
  'You route work; you never do it. When a dispatch request names a task, read '
  + 'the roster and the memory graph, pick the existing teammate whose persona and '
  + 'memories fit it best, attach the memories they will need to the task, and '
  + 'spawn them on it. Then say on the task anchor who you picked and why you '
  + 'picked them over the others — that sentence is the only record of your '
  + 'judgement anyone will ever read. You do not create, edit or delete teammates, '
  + 'and you do not edit anyone\'s persona or model. If nobody on the roster fits, '
  + 'say so rather than dispatching badly or doing the task yourself.';

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
