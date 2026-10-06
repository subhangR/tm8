/**
 * A design (304) read from the CLI lists its PAGES in page order — position,
 * kind, title, id — on `entity context` (the v2 `pages` field), on `entity
 * get` text, and as one small row per page in the bounded json projection.
 */
import { expect, it } from 'vitest';
import { boundEntityDetail } from '../src/entity-bounded.js';
import { renderContextBrief } from '../src/context-brief.js';
import { renderDesignDetail } from '../src/design-render.js';
import { parseManifest } from '../src/manifest.js';
import { operationHelp } from '../src/discovery/help.js';

const page = (id: string, kind: string, title: string, pagePosition: number | null) => ({
  id, kind, title, pagePosition, spaceId: 's', parentId: null, position: 0, version: 1,
  state: { kind }, counters: {}, badges: {}, createdBy: { id: 'm', displayName: 'Owner' },
});

it('entity context prints the pages in order with position, kind, title and id', () => {
  const text = renderContextBrief({
    schemaVersion: 'tm8.entity-context.v2', id: 'design-1', kind: 'design', title: 'Checkout', version: 3,
    status: 'to_do', asOfSeq: 9,
    pages: [
      { id: 'graph-1', kind: 'graph', title: 'Plan', status: 'to_do', position: 1 },
      { id: 'doc-1', kind: 'doc', title: 'Spec', status: 'to_do', position: 2.5, titleTruncated: true },
    ],
  });
  expect(text).toContain('pages (2):\n  #1 graph Plan graph-1\n  #2.5 doc Spec doc-1 [title truncated]');
  expect(text).not.toContain('pages: ');
});

it('an empty design says how to add a page', () => {
  const text = renderContextBrief({ id: 'design-1', kind: 'design', title: 'Empty', version: 1, status: 'to_do', asOfSeq: 1, pages: [] });
  expect(text).toContain('pages (0):');
  expect(text).toContain('tm8 collection add <design-id> <entity-id>');
});

it('entity get text lists the hydrated pages after the summary line', () => {
  const text = renderDesignDetail(
    { id: 'design-1', kind: 'design', content: { kind: 'design', description: '', pages: [page('graph-1', 'graph', 'Plan', 1), page('doc-1', 'doc', 'Spec', null)] } },
    'design design-1 Checkout',
  );
  expect(text).toBe('design design-1 Checkout\npages (2):\n  #1 graph Plan graph-1\n  #- doc Spec doc-1');
  // Not hydrated (a command result): just the summary line.
  expect(renderDesignDetail({ id: 'd', content: { kind: 'design', description: '', pages: null } }, 'line')).toBe('line');
});

it('the bounded projection keeps one small row per page', () => {
  const bounded = boundEntityDetail({
    id: 'design-1', kind: 'design', title: 'Checkout',
    content: { kind: 'design', description: 'x', pages: [page('graph-1', 'graph', 'Plan', 1)] },
  });
  expect(bounded.content).toEqual({ kind: 'design', description: 'x', pages: [{ position: 1, kind: 'graph', title: 'Plan', id: 'graph-1' }] });
});

it('a persisted manifest keeps its design hand-over', () => {
  const manifest = parseManifest({
    sessionId: 'session-1', spaceId: 'space-1', mode: 'worker', agent: { teamMemberId: 'tm-1', name: 'Worker' },
    tasks: [{ id: 'task-1', title: 'Work on: Checkout' }],
    design: { id: 'design-1', title: 'Checkout', taskId: 'task-1', snapshot: 'loaded', pages: [] },
  });
  expect(manifest.design).toMatchObject({ id: 'design-1', taskId: 'task-1', pages: [] });
});

it('collection add/remove help names the design container', () => {
  const add = JSON.stringify(operationHelp('collections.addItem'));
  expect(add).toContain('a story or a design');
  expect(add).toContain('re-adding an existing page with a new --position moves it');
  expect(JSON.stringify(operationHelp('collections.removeItem'))).toContain('never deleted');
});
