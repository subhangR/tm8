/**
 * `launch.defaults` — what a launch loads per selection group when nothing is
 * selected (integrated design 01a0d348 §5.1, I9). The launch sheet and the
 * Run popup pre-tick these, so an untick is a visible removal and an
 * untouched group is simply not sent.
 *
 * NO QUERY OF ITS OWN. Every group comes from spawn's own loaders
 * (`facade/spawn-defaults.ts`, the ones `loadSpawnContext` audits
 * `not-selected` against), in the caller's transaction, so what the sheet
 * pre-ticks and what spawn loads cannot drift. Titles and header text come
 * from the one header resolver.
 *
 * LENIENT (Subhang's rule, 2026-09-25): a missing, malformed, deleted or
 * unreadable teammate or subject yields empty groups and a `warnings` line,
 * never a refusal. Only authorization refuses: a caller who is not a member of
 * the space gets `forbidden`.
 *
 * THE METER'S NUMBERS, WITHOUT ASK JEV (design 01a0d348 §10 Q5). Each item's
 * `promptBytes` is measured by `jev/measure.ts` on the same text and with the
 * same `via` / `link` rules `jev/candidates.ts` uses, and each group's budget
 * and floor, and the `<context_index>` switch, come from `groupRules` over the
 * profile the launch would pin — so a default costs the same bytes here as in
 * `launch.suggest`. The profile is resolved AFTER the read, with the teammate
 * only once it is known to exist; one that does not resolve is the node
 * defaults and a warning, never a refusal.
 */
import {
  SPAWN_SELECTION_GROUP_LIMIT,
  type LaunchDefaultItem,
  type LaunchDefaultsGroup,
  type LaunchDefaultsResult,
  type SelectionHeader,
} from '@tm8/contract';
import type { ContextVia } from '@tm8/execution';

import type { DbClaims } from '../db/types.js';
import { claimsFor, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { loadMemoryDefaults, loadReferenceDefaults, loadSkillDefaults } from '../facade/spawn-defaults.js';
import { loadMemoriesById, renderMemoryText } from '../facade/spawn-memories.js';
import { resolveHeaders } from '../headers/resolve.js';
import { fail } from '../http/errors.js';
import { resolveSubjectTask } from '../jev/candidates.js';
import { groupRules, type JevHandlerOptions } from '../jev/handlers.js';
import { memoryPromptBytes, referencePromptBytes, skillPromptBytes, type MeasureContext } from '../jev/measure.js';
import { resolveInteractionProfileForLaunch } from '../profiles/w2-profile-resolver.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches no entity: the loaders then answer only from the task side. */
const NO_TEAMMATE = '00000000-0000-0000-0000-000000000000';

const AGENT_TOOLS = new Set(['claude-code', 'codex']);

/** A default as read, before the profile decides what it costs. */
type Draft = Omit<LaunchDefaultItem, 'title' | 'headerText' | 'headerSource' | 'promptBytes'> & {
  fallbackTitle: string;
  /** Its bytes, once the launch's `<context_index>` switch and harness are known. */
  measure: (header: SelectionHeader | undefined, measure: MeasureContext) => number;
};

/** Where the profile comes from and which `TM8_CONTEXT_INDEX` outranks it: `launch.suggest`'s options, so tests pin both alike. */
export type LaunchDefaultsOptions = Pick<JevHandlerOptions, 'resolveProfile' | 'env'>;

export function registerLaunchDefaultsHandler(registry: HandlerRegistry, deps: FacadeDeps, options: LaunchDefaultsOptions = {}): void {
  const resolveProfile = options.resolveProfile
    ?? (async (claims: DbClaims, input: { spaceId: string; teamMemberId: string | null; interactionProfileId: string | null }) =>
      (await resolveInteractionProfileForLaunch(deps.db, claims, input)).snapshot);
  const env = options.env ?? process.env;

  registry.register('launch.defaults', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx);
    const rawTeammate = ctx.query.get('teamMemberId')?.trim() ?? '';
    const rawSubject = ctx.query.get('subjectId')?.trim() ?? '';
    const rawProfile = ctx.query.get('interactionProfileId')?.trim() ?? '';
    const rawTool = ctx.query.get('agentTool')?.trim() ?? '';

    const read = await deps.db.tx(claims, async (q) => {
      const member = (await q.query<{ ok: boolean }>(
        'select internal.is_space_member($1::uuid) as ok', [spaceId],
      ))[0]?.ok === true;
      if (!member) throw fail('forbidden', 'you are not a member of this space');

      const warnings: string[] = [];

      let teamMemberId = NO_TEAMMATE;
      let teammateTool: string | null = null;
      if (!rawTeammate) {
        warnings.push('No teamMemberId was given, so the teammate’s memories and skills are not included.');
      } else if (!UUID_RE.test(rawTeammate)) {
        warnings.push(`teamMemberId ${rawTeammate} is not an id, so the teammate’s memories and skills are not included.`);
      } else {
        const found = await q.query<{ id: string; agent_tool: string | null }>(
          `select e.id, tm.agent_tool from public.entities e join public.team_members tm on tm.entity_id = e.id
            where e.id = $1 and e.space_id = $2 and e.deleted_at is null`,
          [rawTeammate, spaceId],
        );
        if (found.length > 0) {
          teamMemberId = rawTeammate;
          teammateTool = found[0]!.agent_tool;
        }
        else warnings.push(`Teammate ${rawTeammate} is not a live teammate you can read in this space, so its memories and skills are not included.`);
      }

      let taskId: string | null = null;
      if (rawSubject) {
        const resolved = UUID_RE.test(rawSubject) ? await resolveSubjectTask(q, spaceId, rawSubject) : undefined;
        if (!resolved) {
          warnings.push(`Subject ${rawSubject} is not a live entity you can read in this space, so no task defaults are included.`);
        } else {
          taskId = resolved.taskId;
          if (!taskId) warnings.push('The subject has no open task yet (spawn will create one), so no task defaults are included.');
        }
      }
      const taskIds = taskId ? [taskId] : [];

      // The WHOLE statement with its marks, as spawn injects it (as `loadMemories` measures it).
      const memoryRows = await loadMemoryDefaults(q, spaceId, teamMemberId, taskIds);
      const rendered = new Map((await loadMemoriesById(q, spaceId, memoryRows.map((row) => row.entityId)))
        .map((row) => [row.entity_id, renderMemoryText(row)]));
      const memories: Draft[] = memoryRows.map((row) => ({
        entityId: row.entityId,
        kind: 'memory',
        via: row.fromTeammate ? 'teammate' : 'task',
        fallbackTitle: 'Memory',
        measure: () => {
          const text = rendered.get(row.entityId);
          return text === undefined ? 0 : memoryPromptBytes(text);
        },
      }));
      const skills: Draft[] = (await loadSkillDefaults(q, spaceId, teamMemberId, taskIds)).map((row) => {
        // How spawn names the path an equipped skill arrives by (`loadSkills`' rule).
        const via: ContextVia = row.viaTaskId ? 'task' : row.depth > 0 ? 'inherited' : 'teammate';
        return {
          entityId: row.entityId,
          kind: 'skill',
          via: row.depth < 0 ? 'task' : row.depth === 0 ? 'teammate' : 'inherited',
          fallbackTitle: row.name,
          measure: (header, measure) => skillPromptBytes(row, via, header, measure),
        };
      });
      const references: Draft[] = (await loadReferenceDefaults(q, spaceId, taskIds)).map((row) => {
        // Spawn's own rule for `via` on a kept default.
        const via = row.link === 'attached_to' && row.kind === 'file' ? 'attached' : 'linked';
        return {
          entityId: row.entityId,
          kind: row.kind,
          via,
          fallbackTitle: row.entityId,
          measure: (header, measure) =>
            referencePromptBytes({ entityId: row.entityId, kind: row.kind, via, link: row.link, title: header?.name ?? null }, header, measure),
        };
      });

      const headers = await resolveHeaders(q, spaceId, [...memories, ...skills, ...references].map((row) => row.entityId));
      return { memories, skills, references, headers, taskId, warnings, teamMemberId, teammateTool };
    });

    const warnings = [...read.warnings];
    let agentTool = read.teammateTool ?? 'claude-code';
    if (rawTool) {
      if (AGENT_TOOLS.has(rawTool)) agentTool = rawTool;
      else warnings.push(`agentTool ${rawTool} is not claude-code or codex, so skills are measured for ${agentTool}.`);
    }
    let interactionProfileId: string | null = null;
    if (rawProfile) {
      if (UUID_RE.test(rawProfile)) interactionProfileId = rawProfile;
      else warnings.push(`interactionProfileId ${rawProfile} is not an id, so the profile spawn would resolve is used.`);
    }

    // The profile the launch would pin, resolved as `launch.suggest` resolves
    // it — with the teammate only once the read found it, so an unknown
    // teammate is one warning, not two.
    let profileSnapshot: unknown = null;
    try {
      profileSnapshot = await resolveProfile(claims, {
        spaceId,
        teamMemberId: read.teamMemberId === NO_TEAMMATE ? null : read.teamMemberId,
        interactionProfileId,
      });
    } catch {
      warnings.push('The launch’s Interaction Profile could not be resolved, so budgets, floors and the context index are the node defaults.');
    }
    const { contextIndex, rules } = groupRules(env, profileSnapshot);
    const measure: MeasureContext = { contextIndex, agentTool };

    const finish = (rows: readonly Draft[], rule: { budget: number | null; floor: number }): LaunchDefaultsGroup => {
      const items = rows.map(({ fallbackTitle, measure: bytesOf, ...row }): LaunchDefaultItem => {
        const header = read.headers.get(row.entityId);
        const text = header?.whenToUse ?? header?.summary ?? null;
        return {
          ...row,
          title: header?.name || fallbackTitle,
          headerText: text,
          headerSource: text === null ? null : header?.source ?? null,
          promptBytes: bytesOf(header, measure),
        };
      });
      return { items: items.slice(0, SPAWN_SELECTION_GROUP_LIMIT), total: items.length, budget: rule.budget, floor: rule.floor };
    };

    return {
      memories: finish(read.memories, rules.memories),
      skills: finish(read.skills, rules.skills),
      references: finish(read.references, rules.references),
      taskId: read.taskId,
      contextIndex: contextIndex ? 'on' : 'off',
      warnings,
    } satisfies LaunchDefaultsResult;
  });
}
