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

  return { created, updated };
}

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
