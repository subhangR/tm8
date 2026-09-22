import { describe, expect, it } from 'vitest';
import { JevClient } from '../src/client.js';
import { JevContextAdvisor, type ContextCandidate } from '../src/context.js';
import { contextIntentFor, type ContextEntity } from '../src/context-intent.js';

const TASK = { title: 'Fix the deploy script', description: 'It targets the wrong instance.' };
const memories: ContextCandidate[] = [{ id: 'memory-1', text: 'deploy runbook' }];
const skills: ContextCandidate[] = [{ id: 'skill-1', name: 'deploy', text: 'deployment skill' }];

const entity = (entityId: string, entityVersion: number, text: string, name?: string): ContextEntity => ({
  entityId,
  entityVersion,
  text,
  ...(name ? { name } : {}),
});

describe('context activation provenance', () => {
  it('records the echoed concrete model and candidate provenance defaults', async () => {
    const client = new JevClient({
      apiKey: 'fixture-key',
      retries: 0,
      fetchImpl: (async () => new Response(JSON.stringify({
        model: 'jev-2026-09-22-build-17',
        answers: {
          c0: { score: 3, confidence: 0.9 },
        },
        usage: { input_tokens: 11, output_tokens: 0 },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    const advisor = new JevContextAdvisor({ client, budget: { floor: 0 } });

    const result = await advisor.planDetailed(TASK, { memories, skills });

    expect(result.value).not.toBeNull();
    expect(result.activation).toMatchObject({ jevModel: 'jev-2026-09-22-build-17' });
    const decision = result.value?.activation.memories.decisions[0];
    expect(decision).toMatchObject({
      id: 'memory-1',
      entityId: null,
      entityVersion: null,
      widened: false,
      source: 'persona',
    });
  });

  it('returns a detailed failure while legacy plan remains null', async () => {
    const client = new JevClient({
      apiKey: 'fixture-key',
      retries: 0,
      fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    });
    const advisor = new JevContextAdvisor({ client });

    const detailed = await advisor.planDetailed(TASK, { memories, skills });
    const legacy = await advisor.plan(TASK, { memories, skills });

    expect(detailed.value).toBeNull();
    expect(detailed.activation).toMatchObject({ reason: '5xx' });
    expect(legacy).toBeNull();
  });

  it('preserves positional ids, labels source, dedupes groups, and marks widening', () => {
    const intent = contextIntentFor(
      {
        memories: ['legacy memory', entity('m-1', 2, 'persona memory')],
        skills: [entity('skill-kept', 1, 'persona skill', 'deploy')],
      },
      {
        memories: [entity('m-1', 2, 'duplicate task memory'), entity('task-1', 3, 'task memory')],
        graph: [entity('task-graph', 4, 'other task')],
      },
      {
        memories: [entity('sheet-1', 5, 'sheet memory')],
        skills: [entity('skill-sheet', 1, 'sheet-selected skill', 'review')],
      },
      [entity('skill-sheet', 1, 'eligible sheet skill', 'review'), entity('skill-new', 2, 'widened skill', 'lint')],
    );

    expect(intent.memories).toMatchObject([
      { id: 'm0', source: 'persona', entityId: null, entityVersion: null },
      { id: 'm1', source: 'persona', entityId: 'm-1', entityVersion: 2 },
      { id: 'm2', source: 'task', entityId: 'task-1', entityVersion: 3 },
      { id: 'm3', source: 'sheet', entityId: 'sheet-1', entityVersion: 5 },
    ]);
    expect(intent.skills).toMatchObject([
      { id: 's0', source: 'persona', widened: false },
      { id: 's1', source: 'sheet', widened: true, entityId: 'skill-sheet', entityVersion: 1 },
      { id: 's2', source: 'jev', widened: true, entityId: 'skill-new', entityVersion: 2 },
    ]);
    expect(intent.graph).toMatchObject([{ id: 't0', source: 'task', entityId: 'task-graph', entityVersion: 4 }]);
  });
});
