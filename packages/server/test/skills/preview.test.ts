import { expect, it, vi } from 'vitest';
import { serializeSkillIndexEntry } from '@tm8/prompt';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerSkillHandlers } from '../../src/skills/handlers.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { scanSpaceSkills } from '../../src/skills/service.js';
vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn() }));
const space = '00000000-0000-4000-8000-000000000001';
const persona = '00000000-0000-4000-8000-000000000002';
function fixture(visible = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('select tm.agent_tool')) return visible ? [{ agent_tool: 'codex' }] : [];
    expect(sql).not.toMatch(/sk\.content\b/);
    expect(sql).toContain("e.kind = 'team_member'");
    expect(sql).toContain('se.space_id = $2');
    return [{ entity_id: 'skill', version: 9, name: 'demo', description: 'full metadata', depth: 1, reference: { provider: 'agents', level: 'project', source_path: '/repo/.agents/skills/demo/SKILL.md', content_hash: 'hash', last_seen_at: '2026-09-22T00:00:00Z', loader_metadata: { openai: { policy: { allow_implicit_invocation: false } } } } }];
  });
  const tx = vi.fn(async (_claims, fn) => fn({ query }));
  const registry = new HandlerRegistry();
  registerSkillHandlers(registry, { db: { tx }, owner: async () => ({ identityId: 'owner' }) } as unknown as FacadeDeps);
  const ctx = { params: { spaceId: space }, query: new URLSearchParams({ teamMemberId: persona, workdir: '/repo' }), requestId: 'request', identity: { kind: 'bearer', identityId: 'caller' } } as unknown as RequestContext;
  return { handler: registry.get('skills.preview')!, ctx, tx, query };
}
it('returns cached metadata, provenance, flags and exact escaped index text under caller claims', async () => {
  const { handler, ctx, tx } = fixture();
  const result = await handler(ctx) as any;
  expect(tx.mock.calls[0]?.[0]).toMatchObject({ identityId: 'caller' });
  expect(result.rows[0]).toMatchObject({ entityId: 'skill', entityVersion: 9, equippedBy: 'ancestor', contentHash: 'hash', description: 'full metadata', scope: 'indexed', missing: false, allowImplicitInvocation: false });
  expect(result.rows[0].indexLine).toBe(serializeSkillIndexEntry(result.indexed[0]));
  expect(result.scannedAt).toBe('2026-09-22T00:00:00.000Z');
  expect(scanSpaceSkills).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('body');
});
it('refuses an unreadable teammate before fetching equipment', async () => {
  const { handler, ctx, query } = fixture(false);
  await expect(handler(ctx)).rejects.toMatchObject({ code: 'not_found' });
  expect(query).toHaveBeenCalledOnce();
});
it('rejects anonymous requests before any database read', async () => {
  const { handler, ctx, tx } = fixture();
  await expect(handler({ ...ctx, identity: { kind: 'anonymous' } } as RequestContext)).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(tx).not.toHaveBeenCalled();
});
