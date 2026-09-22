// Graph context at the spawn seam — the third thing Jev selects.
//
// A spawn injects three kinds of material into one budget that THROWS when it
// overflows (`assertWithinBudget`, §8.1): the persona's memories, its resolved
// skills, and material read out of the graph. The graph half is the largest and
// the least examined: a session assigned six tasks injects six full task bodies,
// five of which it is not about to work on.
//
// These two functions are pure on purpose, so the step that decides what an
// agent arrives knowing is exhaustively testable without a network.
//
//   1. THE FOCUS TASK IS NEVER A CANDIDATE. Task 0 is what the relevance
//      question was built from; asking how relevant it is to itself is a
//      question with one answer and a real price.
//   2. IT DEGRADES, IT DOES NOT DROP. Every assigned task keeps its row, its
//      id, its title and its status. Only the body goes, and it is replaced by
//      the command that fetches it back.
//   3. ATTACHMENTS ARE NOT RANKED. A trimmed body leaves a pointer; a dropped
//      attachment leaves nothing, and the agent never learns the file exists.

import { describe, expect, it } from 'vitest';
import type { ContextPlan } from '@tm8/jev';
import { applyContextPlan, contextIntentFor } from '../src/spawn/manifest.js';
import type { SpawnContext, TaskContext } from '../src/spawn/types.js';

function task(id: string, title: string, description: string): TaskContext {
  return {
    id,
    version: 1,
    title,
    description,
    priority: 'normal',
    status: 'open',
    acceptanceCriteria: [],
  };
}

function ctx(tasks: TaskContext[], over: Partial<SpawnContext> = {}): SpawnContext {
  return {
    spaceId: 'space-1',
    project: null,
    teamMember: {
      id: 'tm-1',
      name: 'Opus',
      role: 'engineer',
      identity: 'builds things',
      memories: ['the deploy box is prod'],
      model: null,
      agentTool: null,
      mode: null,
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks,
    skills: [{ name: 'runbook', body: 'swap the dist' }],
    ...over,
  };
}

/** A plan shaped like a real one, carrying only the fields under test. */
function plan(over: Partial<ContextPlan>): ContextPlan {
  return {
    activation: null as unknown as ContextPlan['activation'],
    keepMemoryIds: null,
    keepSkillIds: null,
    ...over,
  };
}

const THREE = [
  task('task-a', 'Route models with Jev', 'Pick the model from the task, not the default.'),
  task('task-b', 'Rewrite the invite emails', 'The copy says "invited" twice.'),
  task('task-c', 'Fix the deploy target', 'deploy.sh points at 7777, not 17777.'),
];

describe('contextIntentFor — the graph group', () => {
  it('offers every assigned task except the one the question was built from', () => {
    const intent = contextIntentFor(ctx(THREE));
    expect(intent.graph?.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(intent.graph?.map((c) => c.name)).toEqual([
      'Rewrite the invite emails',
      'Fix the deploy target',
    ]);
    // Positions are absolute, not relative to the slice — `t1` is `tasks[1]`.
    expect(intent.graph?.[0]?.text).toBe(THREE[1]!.description);
  });

  it('offers no graph group at all for the ordinary single-task spawn', () => {
    const intent = contextIntentFor(ctx([THREE[0]!]));
    expect(intent.graph).toBeUndefined();
    expect(intent.graphSubject).toBeUndefined();
    // The persona's own material is still offered — this is a graph-group
    // absence, not a disabled advisor.
    expect(intent.memories).toHaveLength(1);
    expect(intent.skills).toHaveLength(1);
  });

  it('skips a body-less task rather than offering an empty candidate', () => {
    const intent = contextIntentFor(ctx([THREE[0]!, task('task-d', 'Untitled', '   '), THREE[2]!]));
    expect(intent.graph?.map((c) => c.id)).toEqual(['t2']);
  });

  it('names the subject, because the noun is what the score means', () => {
    expect(contextIntentFor(ctx(THREE)).graphSubject).toBe('other task assigned to the same agent');
  });
});

describe('applyContextPlan — the graph group', () => {
  it('trims the body of a task the plan cut, and leaves a way back to it', () => {
    const next = applyContextPlan(ctx(THREE), plan({ keepGraphIds: ['t2'] }));
    expect(next.tasks).toHaveLength(3);
    // Everything a person or an agent identifies the task BY survives.
    expect(next.tasks[1]!.id).toBe('task-b');
    expect(next.tasks[1]!.title).toBe('Rewrite the invite emails');
    expect(next.tasks[1]!.status).toBe('open');
    expect(next.tasks[1]!.description).toContain('tm8 entity context task-b');
    expect(next.tasks[1]!.description).not.toContain('invited');
    // The kept one is untouched, byte for byte.
    expect(next.tasks[2]).toEqual(THREE[2]);
  });

  it('never trims the focus task, whatever the plan says', () => {
    // A plan that names neither t0 nor anything else still leaves task 0 whole:
    // it was excluded from the candidates, so its absence is not a verdict.
    const next = applyContextPlan(ctx(THREE), plan({ keepGraphIds: [] }));
    expect(next.tasks[0]).toEqual(THREE[0]);
    expect(next.tasks[1]!.description).toContain('trimmed at spawn');
    expect(next.tasks[2]!.description).toContain('trimmed at spawn');
  });

  it('is a no-op when the advisor had no opinion on the graph', () => {
    const before = ctx(THREE);
    expect(applyContextPlan(before, plan({ keepGraphIds: null })).tasks).toEqual(THREE);
    expect(applyContextPlan(before, null).tasks).toEqual(THREE);
  });

  it('leaves attachments alone — a dropped one leaves no pointer behind', () => {
    const withFiles: TaskContext = {
      ...THREE[1]!,
      attachments: [{ fileEntityId: 'file-1', name: 'brief.pdf', mime: 'application/pdf' }],
    };
    const intent = contextIntentFor(ctx([THREE[0]!, withFiles]));
    // Attachments are never candidates, so nothing can cut them...
    expect(intent.graph?.map((c) => c.id)).toEqual(['t1']);
    const next = applyContextPlan(ctx([THREE[0]!, withFiles]), plan({ keepGraphIds: [] }));
    // ...and a trimmed body still carries the file the agent must know about.
    expect(next.tasks[1]!.attachments).toEqual(withFiles.attachments);
  });

  it('does not mutate the context it was handed', () => {
    const before = ctx(THREE);
    applyContextPlan(before, plan({ keepGraphIds: [] }));
    expect(before.tasks[1]!.description).toBe(THREE[1]!.description);
  });
});
