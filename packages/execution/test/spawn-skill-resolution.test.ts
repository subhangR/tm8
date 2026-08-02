// Row #11 — skill resolution across a team member's ancestor chain.
//
// The ancestor WALK is SQL and is covered by the DB test in
// packages/server/test/db/spawn-skill-resolution.pg.test.ts. What is covered
// here is the collision rule, which is where the judgement lives: what happens
// when a child and a parent equip the same name, when the same skill is
// equipped twice, and when there is genuinely nothing to prefer.

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_SKILLS, resolveSkills, type ResolvedSkillRow } from '../src/spawn/skills.js';
import { composeManifest, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

function row(over: Partial<ResolvedSkillRow> & { entityId: string }): ResolvedSkillRow {
  return { name: `skill-${over.entityId}`, body: `body-${over.entityId}`, depth: 0, ...over };
}

describe('resolveSkills', () => {
  it('returns nothing for a persona that equips nothing', () => {
    expect(resolveSkills([])).toEqual({ skills: [], dropped: [] });
  });

  it('unions skills across the chain, nearest first', () => {
    const resolved = resolveSkills([
      row({ entityId: 'root', name: 'Root', depth: 2 }),
      row({ entityId: 'own', name: 'Own', depth: 0 }),
      row({ entityId: 'parent', name: 'Parent', depth: 1 }),
    ]);
    expect(resolved.skills.map((s) => s.name)).toEqual(['Own', 'Parent', 'Root']);
  });

  it('carries the skill body through — the whole point of the feature', () => {
    const resolved = resolveSkills([row({ entityId: 'a', name: 'Review', body: '# how to review' })]);
    expect(resolved.skills).toEqual([{ name: 'Review', body: '# how to review' }]);
  });

  it('lets a nearer skill shadow a same-named ancestor skill', () => {
    // The specific persona beats the general one — this is what makes nesting
    // useful rather than merely additive.
    const resolved = resolveSkills([
      row({ entityId: 'child-review', name: 'Review', body: 'child version', depth: 0 }),
      row({ entityId: 'parent-review', name: 'Review', body: 'parent version', depth: 1 }),
    ]);
    expect(resolved.skills).toEqual([{ name: 'Review', body: 'child version' }]);
  });

  it('treats case and surrounding whitespace as the same name when shadowing', () => {
    const resolved = resolveSkills([
      row({ entityId: 'child', name: 'code review', body: 'child', depth: 0 }),
      row({ entityId: 'parent', name: '  Code Review  ', body: 'parent', depth: 1 }),
    ]);
    expect(resolved.skills).toEqual([{ name: 'code review', body: 'child' }]);
  });

  it('counts the SAME skill equipped at two levels once, not as a collision', () => {
    // Dedup is by entity id first. A shared skill equipped by both a parent and
    // its child is one skill; throwing here would make a reasonable graph
    // unspawnable.
    const resolved = resolveSkills([
      row({ entityId: 'shared', name: 'Shared', depth: 0 }),
      row({ entityId: 'shared', name: 'Shared', depth: 1 }),
    ]);
    expect(resolved.skills).toHaveLength(1);
  });

  it('throws on two different skills sharing a name at the SAME depth', () => {
    // No nearer-ness to break the tie. Picking one silently would vary with row
    // order and be invisible in the manifest.
    expect(() =>
      resolveSkills([
        row({ entityId: 'a', name: 'Review', depth: 1 }),
        row({ entityId: 'b', name: 'Review', depth: 1 }),
      ]),
    ).toThrow(/ambiguous skill "Review"/);
  });

  it('does not throw when the same name collides at DIFFERENT depths', () => {
    expect(() =>
      resolveSkills([
        row({ entityId: 'a', name: 'Review', depth: 0 }),
        row({ entityId: 'b', name: 'Review', depth: 3 }),
      ]),
    ).not.toThrow();
  });

  it('is order-independent: shuffled input resolves identically', () => {
    const rows = [
      row({ entityId: 'a', name: 'A', depth: 0 }),
      row({ entityId: 'b', name: 'B', depth: 1 }),
      row({ entityId: 'c', name: 'C', depth: 2 }),
    ];
    const forward = resolveSkills(rows).skills;
    const backward = resolveSkills([...rows].reverse()).skills;
    expect(backward).toEqual(forward);
  });

  it('caps the effective set and REPORTS what it dropped', () => {
    // Silent truncation is the failure this guards: a persona with 70 skills
    // would otherwise spawn looking exactly like one correctly holding 64.
    const many = Array.from({ length: DEFAULT_MAX_SKILLS + 6 }, (_, i) =>
      row({ entityId: `s${i}`, name: `S${i}`, depth: i }),
    );
    const resolved = resolveSkills(many);
    expect(resolved.skills).toHaveLength(DEFAULT_MAX_SKILLS);
    expect(resolved.dropped).toHaveLength(6);
    expect(resolved.dropped[0]).toBe(`S${DEFAULT_MAX_SKILLS}`);
  });

  it('drops the FURTHEST skills, keeping the nearest', () => {
    const resolved = resolveSkills(
      [
        row({ entityId: 'far', name: 'Far', depth: 9 }),
        row({ entityId: 'near', name: 'Near', depth: 0 }),
      ],
      { maxSkills: 1 },
    );
    expect(resolved.skills.map((s) => s.name)).toEqual(['Near']);
    expect(resolved.dropped).toEqual(['Far']);
  });
});

// --- the projection into the manifest the CLI actually reads ----------------

function context(skills?: SpawnContext['skills']): SpawnContext {
  return {
    spaceId: 'space-1',
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'tm-1',
      name: 'Draco',
      role: 'PTY engineer',
      identity: 'terminal seam',
      memories: [],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks: [],
    ...(skills ? { skills } : {}),
  };
}

const request: SpawnRequest = { spaceId: 'space-1', teamMemberId: 'tm-1' };

/** The already-resolved inputs composeManifest needs; none are under test here. */
function manifestFixtures() {
  return {
    launch: resolveLaunchConfig(request, context(), {}),
    workdir: { mode: 'reuse' as const, path: '/tmp/tm8-fixture' },
    command: 'echo-agent',
    baseUrl: 'http://127.0.0.1:4610',
  };
}

describe('composeManifest — skills', () => {
  it('projects resolved skills into the manifest', () => {
    // THE regression test for row #11. Before this change composeManifest
    // emitted a hardcoded `skills: []` regardless of the graph, so a persona
    // reached its CLI with no capability at all.
    const manifest = composeManifest({
      sessionId: 'sess-1',
      request,
      context: context([{ name: 'Review', body: '# how to review' }]),
      ...manifestFixtures(),
    });
    expect(manifest.skills).toEqual([{ name: 'Review', body: '# how to review' }]);
  });

  it('still emits [] when the context carries no skills', () => {
    // Shape stability: a SpawnContext predating row #11 is "no skills", not an
    // error, and the field stays present so the CLI reader is unaffected.
    const manifest = composeManifest({
      sessionId: 'sess-1',
      request,
      context: context(),
      ...manifestFixtures(),
    });
    expect(manifest.skills).toEqual([]);
  });
});
