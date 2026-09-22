import { z } from 'zod';
import { resolve } from 'node:path';
import { CollabError } from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../facade/context.js';
import { W2EntitiesCommandsTrackingService } from '../facade/services/w2/entities-commands-tracking.js';
import { resolveSkillRoots, scanSpaceSkills } from './service.js';
import { discoverSkillFiles } from './discovery.js';
import { skillDestination, writeSkillFile } from './authoring.js';
const envelope = { actorId: z.string().uuid().optional(), clientMutationId: z.string().optional() };
export const SkillEquipInputSchema = z.object({ ...envelope, teamMemberId: z.string().uuid() }).strict();
export const SkillCreateInputSchema = z.object({ ...envelope, provider: z.enum(['agents', 'claude', 'codex', 'hermes']).default('agents'), level: z.enum(['project', 'user']).default('project'), root: z.string().min(1), name: z.string().min(1), description: z.string().default(''), body: z.string().default('') }).strict();
export const SkillEditInputSchema = z.object({ ...envelope, expectedVersion: z.number().int().positive(), contentHash: z.string().optional(), name: z.string().min(1).optional(), description: z.string().optional(), body: z.string().optional() }).strict();
export function registerSkillMutations(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.register('skills.roots', async ctx => {
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx);
    const spaceId = requireUuidParam(ctx, 'spaceId');
    await authorize(spaceId, claims);
    const roots = await resolveSkillRoots(deps.db, claims, spaceId, {});
    return { projects: roots.projects, homes: roots.homes };
  });
  // Each operation is registered by its LITERAL name: the conformance source
  // inventory reads registrations statically and cannot see a template string.
  const equipment = (operation: 'equip' | 'unequip') => async (ctx: Parameters<Parameters<HandlerRegistry['register']>[1]>[0]) => {
    const input = SkillEquipInputSchema.parse(ctx.body);
    const owner = await deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const command = commandEnvelope(ctx);
    return deps.db.tx(claimsFor(owner, ctx, command), async q => {
      const endpoints = await q.query<{ id: string; kind: string; space_id: string }>('select id, kind, space_id from public.entities where id = any($1::uuid[]) and deleted_at is null', [[id, input.teamMemberId]]);
      const skill = endpoints.find(e => e.id === id && e.kind === 'skill');
      const member = endpoints.find(e => e.id === input.teamMemberId && e.kind === 'team_member');
      if (!skill || !member || skill.space_id !== member.space_id) throw new CollabError('not_found', 'skill and teammate must be in the same space');
      if (operation === 'equip') return q.rpc('write_edge', [member.id, skill.id, 'equips', '{}', command.actorId ?? null, command.clientMutationId ?? null]);
      const edges = await q.query<{ id: string }>("select id from public.edges where src_id = $1 and dst_id = $2 and type = 'equips'", [member.id, skill.id]);
      if (!edges[0]) return { removed: false };
      await q.rpc('delete_edge', [edges[0].id, command.actorId ?? null, command.clientMutationId ?? null]);
      return { removed: true };
    });
  };
  registry.register('skills.equip', equipment('equip'));
  registry.register('skills.unequip', equipment('unequip'));
  registry.register('skills.create', async ctx => {
    const input = SkillCreateInputSchema.parse(ctx.body);
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx, commandEnvelope(ctx));
    const spaceId = requireUuidParam(ctx, 'spaceId');
    await authorize(spaceId, claims);
    const roots = await resolveSkillRoots(deps.db, claims, spaceId, {});
    let root: string;
    if (input.level === 'project') {
      if (!['agents', 'claude'].includes(input.provider)) throw new CollabError('invalid_input', 'project authoring supports agents and claude providers');
      const project = roots.projects.find(p => p.id === input.root);
      if (!project) throw new CollabError('forbidden', 'project is not linked to this space');
      root = project.workingDir;
    } else {
      const homes = roots.homes.map(h => resolve(h));
      if (!homes.includes(resolve(input.root))) throw new CollabError('forbidden', 'home is not an authorized skill root');
      root = input.root;
    }
    const path = skillDestination(root, input.provider, input.name);
    await writeSkillFile(root, path, input, true);
    const scan = await scanSpaceSkills(deps.db, claims, spaceId, { ...(input.level === 'project' ? { root: input.root } : { homesOnly: true }), force: true });
    const rows = await deps.db.query<{ id: string }>(claims, 'select entity_id as id from public.skills where space_id = $1 and source_path = $2', [spaceId, path]);
    return { id: rows[0]?.id ?? null, sourcePath: path, scan };
  });
  const entities = new W2EntitiesCommandsTrackingService(deps);
  registry.register('skills.edit', async ctx => {
    const input = SkillEditInputSchema.parse(ctx.body);
    const detail = await entities.getEntity(ctx);
    if (detail.state.kind !== 'skill') throw new CollabError('not_found', 'entity is not a skill');
    if (detail.version !== input.expectedVersion) throw new CollabError('version_conflict', 'skill version changed');
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx, commandEnvelope(ctx));
    await authorize(detail.spaceId, claims);
    if (!detail.state.sourcePath) return deps.db.rpc(claims, 'update_skill_entity', [detail.id, input.expectedVersion, claims.actorId ?? null, input.name ?? null, input.description ?? null, input.body ?? null, input.clientMutationId ?? null]);
    if (['system', 'admin', 'plugin', 'synced', 'session'].includes(detail.state.level)) throw new CollabError('forbidden', 'this skill scope is read-only');
    const roots = await resolveSkillRoots(deps.db, claims, detail.spaceId, {});
    const discovered = await discoverSkillFiles(roots);
    const path = detail.state.sourcePath;
    const file = discovered.candidates.find(c => c.path === path);
    if (!file || ['system', 'admin', 'plugin', 'synced', 'session'].includes(file.level)) throw new CollabError('forbidden', 'skill is outside writable roots');
    await writeSkillFile(file.scanRoot, path, input, false, input.contentHash ?? detail.state.contentHash);
    return scanSpaceSkills(deps.db, claims, detail.spaceId, { ...(file.projectId ? { root: file.projectId } : { homesOnly: true }), force: true });
  });
  async function authorize(spaceId: string, claims: import('../db/types.js').DbClaims) {
    const rows = await deps.db.query<{ allowed: boolean }>(claims, 'select internal.is_space_member($1::uuid) and ($2::uuid is null or internal.can_act_as($2::uuid,$1::uuid)) as allowed', [spaceId, claims.actorId ?? null]);
    if (!rows[0]?.allowed) throw new CollabError('forbidden', 'skill authoring requires space membership and an authorized actor');
  }
}
