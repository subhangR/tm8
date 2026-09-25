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
 */
import { SPAWN_SELECTION_GROUP_LIMIT, type LaunchDefaultItem, type LaunchDefaultsGroup, type LaunchDefaultsResult } from '@tm8/contract';

import { claimsFor, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { loadMemoryDefaults, loadReferenceDefaults, loadSkillDefaults } from '../facade/spawn-defaults.js';
import { resolveHeaders } from '../headers/resolve.js';
import { fail } from '../http/errors.js';
import { resolveSubjectTask } from '../jev/candidates.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches no entity: the loaders then answer only from the task side. */
const NO_TEAMMATE = '00000000-0000-0000-0000-000000000000';

type Draft = Omit<LaunchDefaultItem, 'title' | 'headerText' | 'headerSource'> & { fallbackTitle: string };

function group(items: readonly LaunchDefaultItem[]): LaunchDefaultsGroup {
  return { items: items.slice(0, SPAWN_SELECTION_GROUP_LIMIT), total: items.length };
}

export function registerLaunchDefaultsHandler(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.register('launch.defaults', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx);
    const rawTeammate = ctx.query.get('teamMemberId')?.trim() ?? '';
    const rawSubject = ctx.query.get('subjectId')?.trim() ?? '';

    return deps.db.tx(claims, async (q): Promise<LaunchDefaultsResult> => {
      const member = (await q.query<{ ok: boolean }>(
        'select internal.is_space_member($1::uuid) as ok', [spaceId],
      ))[0]?.ok === true;
      if (!member) throw fail('forbidden', 'you are not a member of this space');

      const warnings: string[] = [];

      let teamMemberId = NO_TEAMMATE;
      if (!rawTeammate) {
        warnings.push('No teamMemberId was given, so the teammate’s memories and skills are not included.');
      } else if (!UUID_RE.test(rawTeammate)) {
        warnings.push(`teamMemberId ${rawTeammate} is not an id, so the teammate’s memories and skills are not included.`);
      } else {
        const found = await q.query<{ id: string }>(
          `select e.id from public.entities e join public.team_members tm on tm.entity_id = e.id
            where e.id = $1 and e.space_id = $2 and e.deleted_at is null`,
          [rawTeammate, spaceId],
        );
        if (found.length > 0) teamMemberId = rawTeammate;
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

      const memories: Draft[] = (await loadMemoryDefaults(q, spaceId, teamMemberId, taskIds)).map((row) => ({
        entityId: row.entityId, kind: 'memory', via: row.fromTeammate ? 'teammate' : 'task', fallbackTitle: 'Memory',
      }));
      const skills: Draft[] = (await loadSkillDefaults(q, spaceId, teamMemberId, taskIds)).map((row) => ({
        entityId: row.entityId,
        kind: 'skill',
        via: row.depth < 0 ? 'task' : row.depth === 0 ? 'teammate' : 'inherited',
        fallbackTitle: row.name,
      }));
      const references: Draft[] = (await loadReferenceDefaults(q, spaceId, taskIds)).map((row) => ({
        entityId: row.entityId,
        kind: row.kind,
        // Spawn's own rule for `via` on a kept default.
        via: row.link === 'attached_to' && row.kind === 'file' ? 'attached' : 'linked',
        fallbackTitle: row.entityId,
      }));

      const headers = await resolveHeaders(q, spaceId, [...memories, ...skills, ...references].map((row) => row.entityId));
      const finish = (rows: readonly Draft[]): LaunchDefaultItem[] => rows.map(({ fallbackTitle, ...row }) => {
        const header = headers.get(row.entityId);
        const text = header?.whenToUse ?? header?.summary ?? null;
        return {
          ...row,
          title: header?.name || fallbackTitle,
          headerText: text,
          headerSource: text === null ? null : header?.source ?? null,
        };
      });

      return {
        memories: group(finish(memories)),
        skills: group(finish(skills)),
        references: group(finish(references)),
        taskId,
        warnings,
      };
    });
  });
}
