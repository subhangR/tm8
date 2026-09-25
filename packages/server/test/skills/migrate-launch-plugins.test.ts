import { describe, expect, it } from 'vitest';
// The human-run F3 migration (design 01a0d348 §3.5): its plan is pure, so the
// rule that decides which allowlist entries become equips is tested here.
import { entryMatchesPlugin, planMigration } from '../../../../scripts/migrate-launch-plugins-to-equips.mjs';

const skill = (id: string, pluginName: string | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  state: { level: 'plugin', provider: 'claude', missing: false, loaderMetadata: pluginName ? { pluginName } : {}, ...extra },
});

describe('migrate-launch-plugins-to-equips', () => {
  it('matches an entry to a pluginName the way spawn allows it: full ids exactly, else by bare name', () => {
    expect(entryMatchesPlugin('sales@synced', 'sales@synced')).toBe(true);
    expect(entryMatchesPlugin('sales', 'sales@synced')).toBe(true);
    expect(entryMatchesPlugin('superpowers@official', 'superpowers')).toBe(true);
    expect(entryMatchesPlugin('sales@other', 'sales@synced')).toBe(false);
    expect(entryMatchesPlugin('sales', 'marketing@synced')).toBe(false);
  });

  it('moves entries with skill entities to equips and keeps only MCP-only entries on the allowlist', () => {
    const plan = planMigration({
      plugins: ['sales@synced', 'mcp-only', 'superpowers'],
      skills: [
        skill('s1', 'sales@synced'),
        skill('s2', 'sales@synced'),
        skill('p1', 'superpowers'),
        skill('gone', 'sales@synced', { missing: true }),
        skill('user', undefined, { level: 'user' }),
      ],
      equipped: ['s2'],
    });
    expect(plan.keep).toEqual(['mcp-only']);
    expect(plan.moved).toEqual([
      { entry: 'sales@synced', skillIds: ['s1', 's2'] },
      { entry: 'superpowers', skillIds: ['p1'] },
    ]);
    // Already-equipped skills are not re-equipped; a missing skill is never equipped.
    expect(plan.equip).toEqual(['s1', 'p1']);
  });

  it('plans nothing for a teammate with no allowlist', () => {
    expect(planMigration({ plugins: [], skills: [skill('s1', 'sales@synced')], equipped: [] }))
      .toEqual({ keep: [], moved: [], equip: [] });
  });
});
