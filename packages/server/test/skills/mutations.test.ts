import { expect, it, vi } from 'vitest';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerSkillMutations, SkillCreateInputSchema } from '../../src/skills/mutations.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
const skill = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
function setup(kind = 'team_member') {
 const rpc = vi.fn(async () => ({}));
 const query = vi.fn(async (sql: string) => sql.includes('public.entities') ? [{ id: skill, kind: 'skill', space_id: 'space' }, { id: member, kind, space_id: 'space' }] : sql.includes('public.edges') ? [{ id: 'edge' }] : [{ allowed: false }]);
 const db = { query: (_claims: unknown, sql: string) => query(sql), tx: vi.fn(async (_claims, fn) => fn({ query, rpc })) };
 const registry = new HandlerRegistry(); registerSkillMutations(registry, { db, owner: async () => ({ identityId: 'owner' }) } as unknown as FacadeDeps);
 const ctx = { params: { id: skill, spaceId: skill }, body: { teamMemberId: member }, query: new URLSearchParams(), identity: { kind: 'bearer', identityId: 'caller' } } as unknown as RequestContext;
 return { registry, ctx, rpc };
}
it('uses authorized edge RPCs for teammate equips and unequips', async () => {
 const { registry, ctx, rpc } = setup();
 await registry.get('skills.equip')!(ctx); expect(rpc).toHaveBeenCalledWith('write_edge', [member, skill, 'equips', '{}', null, null]);
 await registry.get('skills.unequip')!(ctx); expect(rpc).toHaveBeenCalledWith('delete_edge', ['edge', null, null]);
});
it('refuses session equipment and unauthorized authoring before filesystem work', async () => {
 const { registry, ctx, rpc } = setup('work_session');
 await expect(registry.get('skills.equip')!(ctx)).rejects.toMatchObject({ code: 'not_found' }); expect(rpc).not.toHaveBeenCalled();
 await expect(registry.get('skills.create')!({ ...ctx, body: { root: skill, name: 'demo' } })).rejects.toMatchObject({ code: 'forbidden' });
});
it('rejects read-only scopes at the authoring input boundary', () => {
 for (const level of ['system', 'plugin', 'synced']) expect(SkillCreateInputSchema.safeParse({ root: skill, name: 'demo', level }).success).toBe(false);
});
