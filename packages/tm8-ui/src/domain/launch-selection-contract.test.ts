/**
 * THE SEND RULE, PARSED BY I6's CONTRACT (design 01a0d348 §5.1–5.2, I9).
 *
 * The sibling tests pin the SHAPE `composeSelection` / `buildSpawnInput`
 * produce; this one hands every launch they build to the node's own
 * `ExecutionSpawnInputSchema`, so a shape the node refuses (a group named in
 * both `selection` and `selectionReasons`, `memoryIds` beside `selection`, a
 * group above the ceiling) is red here rather than a refusal at Launch.
 */
import { describe, expect, it } from 'vitest';
import { ExecutionSpawnInputSchema, SPAWN_SELECTION_GROUP_LIMIT, type EntityId, type ExecutionSpawnInput } from '@tm8/contract';

import { buildSpawnInput, defaultConfigFor, type LaunchConfig } from './launch';
import {
  composeSelection,
  manualOutcome,
  toggleRow,
  type LaunchContextRow,
  type LaunchGroupDefaults,
  type LaunchGroupEdit,
} from './launch-selection';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as EntityId;
const SPACE = uuid(0xfff0);
const row = (n: number): LaunchContextRow => ({ id: uuid(n), kind: 'memory', title: String(n), text: null, derived: false, via: 'teammate' });
const ready = (...ns: number[]): LaunchGroupDefaults => ({ status: 'ready', rows: ns.map(row), total: ns.length });
const NONE: LaunchGroupEdit = { removed: [], added: [] };

function tick(defaults: LaunchGroupDefaults, ...ns: number[]): LaunchGroupEdit {
  let edit = NONE;
  for (const n of ns) {
    const result = toggleRow(defaults, edit, uuid(n));
    if ('refused' in result) throw new Error(result.refused);
    edit = result.edit;
  }
  return edit;
}

const MEMORIES = ready(1, 2);
const SKILLS = ready(11, 12);
const REFERENCES = ready(21);

function launch(
  edits: Partial<Record<'memories' | 'skills' | 'references', LaunchGroupEdit>>,
  over: Partial<LaunchConfig> = {},
): ExecutionSpawnInput {
  const fields = composeSelection({
    memories: manualOutcome(MEMORIES, edits.memories ?? NONE),
    skills: manualOutcome(SKILLS, edits.skills ?? NONE),
    references: manualOutcome(REFERENCES, edits.references ?? NONE),
  });
  const config = { ...defaultConfigFor({ id: uuid(0xfff1), agentTool: 'claude-code', model: 'claude-opus-5' }), ...fields, ...over };
  return buildSpawnInput({ clientMutationId: 'cmid-contract', spaceId: SPACE, config });
}

function accepted(input: ExecutionSpawnInput): ExecutionSpawnInput {
  const parsed = ExecutionSpawnInputSchema.safeParse(input);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toEqual([]);
  return input;
}

describe('every launch the sheet builds is one I6’s contract accepts', () => {
  it('no group touched: no `selection`, and a reason for every group', () => {
    const input = accepted(launch({}));
    expect(input).not.toHaveProperty('selection');
    expect(input.selectionReasons).toEqual({ memories: 'not-asked', skills: 'not-asked', references: 'not-asked' });
  });

  it('a touched group is its EXACT set, and only the others carry a reason', () => {
    const input = accepted(launch({ memories: tick(MEMORIES, 1, 99) }));
    expect(input.selection).toEqual({ memoryIds: [uuid(2), uuid(99)] });
    expect(input.selectionReasons).toEqual({ skills: 'not-asked', references: 'not-asked' });
  });

  it('removing every default sends the empty set, which the node reads as "none"', () => {
    const input = accepted(launch({ references: tick(REFERENCES, 21) }));
    expect(input.selection).toEqual({ referenceIds: [] });
  });

  it('a set edited back to its defaults is omitted', () => {
    const input = accepted(launch({ skills: tick(SKILLS, 11, 11, 12, 12) }));
    expect(input).not.toHaveProperty('selection');
  });

  it('more than the ceiling is never sent: the group launches with its defaults', () => {
    const over = Array.from({ length: SPAWN_SELECTION_GROUP_LIMIT + 1 }, (_, i) => uuid(1000 + i));
    // The node would refuse this set outright…
    expect(ExecutionSpawnInputSchema.safeParse({
      clientMutationId: 'c', spaceId: SPACE, teamMemberId: uuid(0xfff1), selection: { memoryIds: over },
    }).success).toBe(false);
    // …so the builder never sends it, whichever way it arrives.
    const fields = composeSelection(
      { memories: { send: over }, skills: { omit: 'not-asked' }, references: { omit: 'not-asked' } },
    );
    const config = { ...defaultConfigFor({ id: uuid(0xfff1), agentTool: 'claude-code', model: 'claude-opus-5' }), ...fields };
    const input = accepted(buildSpawnInput({ clientMutationId: 'cmid-contract', spaceId: SPACE, config }));
    expect(input).not.toHaveProperty('selection');
  });

  it('`memoryIds` never rides beside `selection`', () => {
    const input = accepted(launch({ memories: tick(MEMORIES, 2) }, { memoryIds: [uuid(77)] }));
    expect(input).not.toHaveProperty('memoryIds');
    expect(input.selection).toEqual({ memoryIds: [uuid(1)] });
  });

  it('a plugin pick routed through skills (F3) leaves no reason on the skills group', () => {
    const pluginSkills = { defaults: [uuid(11), uuid(12)], byPlugin: { 'sales@synced': [uuid(31)] } };
    const input = accepted(launch({}, { plugins: ['sales@synced'], pluginSkills }));
    expect(input.selection).toEqual({ skillIds: [uuid(11), uuid(12), uuid(31)] });
    expect(input.selectionReasons).toEqual({ memories: 'not-asked', references: 'not-asked' });
  });
});
