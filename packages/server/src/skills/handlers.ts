import { computeEffectiveSkills } from '@tm8/execution';
import { serializeSkillIndexEntry } from '@tm8/prompt';
import type { SkillPreviewResult } from '@tm8/contract';
import { loadSkillEquipment } from './equipment.js';
import { z } from 'zod';
import { CollabError, decodeCursor, encodeCursor } from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../facade/context.js';
import { assembleSummaries, ENTITY_COLUMNS, ENTITY_FROM, type EntityRow } from '../facade/entity-read.js';
import { W2EntitiesCommandsTrackingService } from '../facade/services/w2/entities-commands-tracking.js';
import { scanSpaceSkills } from './service.js';
export const SkillScanInputSchema = z.object({ root: z.string().uuid().optional(), all: z.boolean().optional(), clientMutationId: z.string().optional(), actorId: z.string().uuid().optional() }).strict().refine(value => !(value.root && value.all), { message: 'root and all are mutually exclusive' });
export function registerSkillHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.register('skills.scan', async ctx => {
    const input = SkillScanInputSchema.parse(ctx.body);
    const owner = await deps.owner();
    return scanSpaceSkills(deps.db, claimsFor(owner, ctx, commandEnvelope(ctx)), requireUuidParam(ctx, 'spaceId'), { ...(input.root ? { root: input.root } : {}), force: true });
  });
  registry.register('skills.list', async ctx => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    let after: string | null = null;
    if (cursor) { const { k } = decodeCursor(cursor); if (k.length !== 2 || k[0] !== spaceId || typeof k[1] !== 'string') throw new CollabError('invalid_cursor', 'invalid skill cursor'); after = k[1]; }
    return deps.db.tx(claimsFor(owner, ctx), async q => {
      const rows = await q.query<EntityRow>(`select ${ENTITY_COLUMNS} ${ENTITY_FROM}
        where e.space_id = $1 and e.kind = 'skill' and e.deleted_at is null
          and ($2::uuid is null or e.id > $2::uuid)
          and ($3::text is null or exists(select 1 from public.skills sr where sr.entity_id = e.id and sr.root_ref = $3))
        order by e.id limit $4`, [spaceId, after, ctx.query.get('root'), limit + 1]);
      const page = rows.slice(0, limit);
      return { items: await assembleSummaries(q, page, owner.identityId), nextCursor: rows.length > limit ? encodeCursor([spaceId, page[page.length - 1]!.id]) : null };
    });
  });
  registry.register('skills.preview', async ctx => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = z.object({
      teamMemberId: z.string().uuid(), projectId: z.string().uuid().optional(),
      agentTool: z.enum(['claude-code', 'codex']).optional(),
      workdir: z.string().startsWith('/').optional(),
      agentConfigDir: z.string().startsWith('/').optional(),
    }).strict().parse(Object.fromEntries(ctx.query));
    return deps.db.tx(claimsFor(owner, ctx), async q => {
      const member = (await q.query<{ agent_tool: string | null }>(
        `select tm.agent_tool from public.team_members tm join public.entities e on e.id = tm.entity_id
          where e.id = $1 and e.space_id = $2 and e.deleted_at is null`, [input.teamMemberId, spaceId]))[0];
      if (!member) throw new CollabError('not_found', 'teammate not found in this space');
      let projectRoot: string | null = null;
      if (input.projectId) {
        const project = (await q.query<{ working_dir: string }>(`select p.working_dir from public.projects p
          join public.space_projects sp on sp.project_id = p.id where p.id = $1 and sp.space_id = $2`, [input.projectId, spaceId]))[0];
        if (!project) throw new CollabError('not_found', 'project not linked to this space');
        projectRoot = project.working_dir;
      }
      const equips = await loadSkillEquipment(q, spaceId, input.teamMemberId);
      const scannedAt = equips.flatMap(row => row.lastSeenAt ? [row.lastSeenAt] : []).sort().at(-1) ?? null;
      const effective = computeEffectiveSkills({ agentTool: input.agentTool ?? member.agent_tool ?? 'claude-code', workdir: input.workdir ?? projectRoot ?? '/', projectRoot, equips, scannedAt, agentConfigDir: input.agentConfigDir });
      const rows: SkillPreviewResult['rows'] = equips.map(row => {
        const native = effective.native.find(entry => entry.entityId === row.entityId);
        const indexed = effective.indexed.find(entry => entry.entityId === row.entityId);
        const skipped = effective.skipped.find(entry => entry.entityId === row.entityId);
        const entry = native ?? indexed;
        const sidecar = row.loaderMetadata?.openai as { policy?: { allow_implicit_invocation?: boolean } } | undefined;
        return {
          entityId: row.entityId, entityVersion: row.entityVersion, name: row.name,
          description: row.description || (typeof row.frontmatter?.when_to_use === 'string' ? row.frontmatter.when_to_use : ''),
          provider: row.provider ?? 'tm8', level: row.level ?? 'space', sourcePath: row.sourcePath,
          scope: native ? 'native' : indexed ? 'indexed' : 'skipped',
          indexLine: entry ? serializeSkillIndexEntry(entry) : null,
          contentHash: row.contentHash, missing: row.missing === true,
          equippedBy: row.depth === 0 ? 'persona' : 'ancestor',
          disableModelInvocation: row.frontmatter?.['disable-model-invocation'] === true,
          allowImplicitInvocation: sidecar?.policy?.allow_implicit_invocation !== false,
          ...(skipped ? { reason: skipped.reason } : {}),
        };
      });
      return { ...effective, rows } satisfies SkillPreviewResult;
    });
  });
  const entities = new W2EntitiesCommandsTrackingService(deps);
  registry.register('skills.show', async ctx => {
    const detail = await entities.getEntity(ctx);
    if (detail.kind !== 'skill') throw new CollabError('not_found', 'entity is not a skill');
    return detail;
  });
}
