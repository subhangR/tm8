/**
 * F5 — the `--terse` render projection, OPT-IN.
 *
 * Three properties are the contract of this file:
 *
 *  1. THE SHAPE, once, publicly: a projected summary is
 *     { projected: true, id, kind, title, version, parentId, excerpt?,
 *       createdBy: "<display name>", state } — and `version` and `state` are
 *     NEVER absent from a projected node. Anything less is the defect the
 *     design cautions name.
 *  2. OPT-IN: without `--terse` (or with `--full`), byte-identical output to
 *     before the feature existed. The integration suite runs without the flag
 *     and must stay green unmodified.
 *  3. ONE BOUNDARY: the projection applies at Output for json/jsonl, so every
 *     command family inherits the same shape — proven here over the get,
 *     children/query page, context, and task payload shapes.
 */
import { describe, expect, it } from 'vitest';

import { projectTerse } from '../src/terse.js';
import { createOutput } from '../src/output.js';
import { parseInvocation } from '../src/args.js';

const ACTOR = {
  id: '77777777-7777-7777-8777-777777777777',
  kind: 'member',
  displayName: 'Owner',
  avatar: null,
  role: 'owner',
  isAgent: false,
};

const COUNTERS = { likes: 0, dislikes: 0, stars: 2, points: 5, messages: 3, viewerReaction: null };

/** A full task EntitySummary as the wire sends it. */
function taskSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '55555555-5555-7555-8555-555555555555',
    spaceId: '11111111-1111-7111-8111-111111111111',
    kind: 'task',
    title: 'Fix the flange',
    excerpt: 'the flange is broken',
    parentId: '66666666-6666-7666-8666-666666666666',
    position: 4,
    visibility: 'space',
    version: 7,
    activityAt: '2026-08-02T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    deletedAt: null,
    createdBy: ACTOR,
    counters: COUNTERS,
    state: {
      kind: 'task',
      workStatus: 'open',
      priority: 'high',
      axes: {},
      dueDate: null,
      assignees: [ACTOR],
      acceptance: { total: 3, completed: 1 },
    },
    badges: {},
    ...overrides,
  };
}

describe('projectTerse — the shape, chosen once', () => {
  it('a summary keeps exactly the work fields, marked projected', () => {
    const terse = projectTerse(taskSummary()) as Record<string, unknown>;
    expect(Object.keys(terse).sort()).toEqual(
      ['createdBy', 'excerpt', 'id', 'kind', 'parentId', 'projected', 'state', 'title', 'version'].sort(),
    );
    expect(terse['projected']).toBe(true);
    expect(terse['createdBy']).toBe('Owner');
  });

  it('NEVER projects away version or state — the two load-bearing fields', () => {
    const terse = projectTerse(taskSummary()) as Record<string, unknown>;
    expect(terse['version']).toBe(7);
    // state passes through VERBATIM: workStatus, acceptance counts, and the
    // ActorSummaries inside it (assignees are work data, not decoration).
    expect(terse['state']).toEqual(taskSummary()['state']);
  });

  it('drops every decoration field', () => {
    const terse = projectTerse(taskSummary()) as Record<string, unknown>;
    for (const gone of ['spaceId', 'position', 'visibility', 'activityAt', 'createdAt',
      'updatedAt', 'deletedAt', 'counters', 'badges']) {
      expect(gone in terse, gone).toBe(false);
    }
  });

  it('a detail (get family) keeps its extras — content is the point of a get', () => {
    const detail = taskSummary({
      content: { kind: 'task', description: 'the real work brief' },
      hierarchy: { parents: [taskSummary()], childCount: 1 },
      capabilities: { canEdit: true },
    });
    const terse = projectTerse(detail) as Record<string, unknown>;
    expect((terse['content'] as Record<string, unknown>)['description']).toBe('the real work brief');
    expect(terse['capabilities']).toEqual({ canEdit: true });
    // …and a summary nested inside an extra projects too.
    const parent = (terse['hierarchy'] as { parents: Record<string, unknown>[] }).parents[0];
    expect(parent?.['projected']).toBe(true);
    expect('counters' in (parent ?? {})).toBe(false);
  });

  it('a page (children/query family) projects each item and keeps the cursor envelope', () => {
    const page = { items: [taskSummary(), taskSummary()], nextCursor: 'abc' };
    const terse = projectTerse(page) as { items: Record<string, unknown>[]; nextCursor: string };
    expect(terse.nextCursor).toBe('abc');
    expect(terse.items).toHaveLength(2);
    for (const item of terse.items) {
      expect(item['projected']).toBe(true);
      expect(item['version']).toBe(7);
    }
  });

  it('a context view (context family) projects root/parents/children and keeps cursors and provenance', () => {
    const view = {
      schemaVersion: 'tm8.entity-context.v1',
      root: taskSummary(),
      parents: [taskSummary()],
      children: [taskSummary()],
      edges: [],
      messages: [],
      actions: [],
      provenance: { operation: 'entities.context', fetchedAt: 'x', eventSeq: 1 },
      cursors: { messages: null },
      byteSize: 100,
      truncated: false,
    };
    const terse = projectTerse(view) as Record<string, unknown>;
    expect((terse['root'] as Record<string, unknown>)['projected']).toBe(true);
    expect(terse['provenance']).toEqual(view.provenance);
    expect(terse['cursors']).toEqual({ messages: null });
    expect(terse['byteSize']).toBe(100);
  });

  it('non-summary payloads pass through untouched', () => {
    const dto = { schemaVersion: 'tm8.help.v1', nouns: [{ name: 'entity', summary: 's' }] };
    expect(projectTerse(dto)).toEqual(dto);
  });
});

describe('the gate — opt-in at the render boundary', () => {
  const emit = (render: 'full' | 'terse' | undefined, format: 'json' | 'jsonl' | 'human'): string => {
    let stdout = '';
    const out = createOutput({
      format,
      ...(render === undefined ? {} : { render }),
      streams: { stdout: (c: string | Uint8Array) => { stdout += String(c); }, stderr: () => {} },
    });
    const dto = { entity: taskSummary() };
    if (format === 'jsonl') out.line(dto, () => 'human line');
    else out.data(dto, () => 'human line');
    return stdout;
  };

  it('without the flag the json output is byte-identical to the full envelope', () => {
    expect(emit(undefined, 'json')).toBe(emit('full', 'json'));
    expect(emit(undefined, 'json')).toContain('"counters"');
    expect(emit(undefined, 'json')).not.toContain('"projected"');
  });

  it('terse json is projected; version and state survive', () => {
    const text = emit('terse', 'json');
    expect(text).toContain('"projected": true');
    expect(text).not.toContain('"counters"');
    expect(text).toContain('"version": 7');
    expect(text).toContain('"workStatus": "open"');
  });

  it('terse applies to jsonl lines too — one boundary, no per-command drift', () => {
    const text = emit('terse', 'jsonl');
    expect(text).toContain('"projected":true');
    expect(text).not.toContain('"counters"');
  });

  it('human render is untouched by terse — its renderer still receives the full DTO', () => {
    expect(emit('terse', 'human')).toBe('human line\n');
  });
});

describe('the flags — global, boolean, and full-wins', () => {
  it('--terse and --full parse as globals in any position and never reach the command bag', () => {
    for (const argv of [
      ['--terse', 'entity', 'get', 'e1'],
      ['entity', 'get', 'e1', '--terse'],
      ['--full', 'entity', 'get', 'e1'],
    ]) {
      const inv = parseInvocation([...argv]);
      expect(inv.options.has('terse'), argv.join(' ')).toBe(false);
      expect(inv.options.has('full'), argv.join(' ')).toBe(false);
      expect(inv.positionals).toEqual(['entity', 'get', 'e1']);
    }
  });

  it('default is full; --terse opts in; --full defeats --terse', () => {
    expect(parseInvocation(['entity', 'get', 'e1']).globals.render).toBe('full');
    expect(parseInvocation(['--terse', 'entity', 'get', 'e1']).globals.render).toBe('terse');
    expect(parseInvocation(['--terse', '--full', 'entity', 'get', 'e1']).globals.render).toBe('full');
  });
});
