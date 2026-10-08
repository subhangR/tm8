/** Browser-only synthetic records. Mounts the shipping GateApp and read adapter. */
import { createRoot } from 'react-dom/client';
import type { CollectionQuery, EntityDetail, EntityKind, EntitySummary, StoryPage } from '@tm8/contract';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../src/data/fixtures/seam-fixture';
import { fixtureDetails, fixtureSummaries } from '../src/fixtures';
import { GateApp } from '../src/views/GateApp';
import { STORY_FIXTURE } from '../src/story/fixture';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

const seam = createFixtureSeam();
const records = new Map<string, EntityDetail>();
let sequence = 0;
function make(kind: EntityKind, title: string, parentId: string | null = null) {
  const template = fixtureSummaries.find(row => row.kind === kind)!;
  const extra = fixtureDetails[template.id]!;
  const detail: EntityDetail = {
    ...structuredClone(extra), ...structuredClone(template),
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    title, parentId, position: sequence, spaceId: FIXTURE_SPACE_ID,
    connections: { incoming: [], outgoing: [] },
  };
  records.set(detail.id, detail);
  return detail;
}
const parent = make('story', 'Harness story');
const nested = make('story', 'Nested harness story', parent.id);
const scoped = new Map<string, EntityDetail[]>();
for (const scope of [parent, nested]) {
  const task = make('task', `${scope.title} task`);
  make('task', `${scope.title} task child`, task.id);
  const done = make('task', `${scope.title} completed task`);
  if (done.state.kind === 'task') done.state.status = 'done';
  done.category = 'done';
  const session = make('work_session', `${scope.title} session`);
  if (session.state.kind === 'work_session') { session.state.status = 'running'; session.state.outcome = 'open'; }
  const doc = make('doc', `${scope.title} document`);
  const project = make('project', `${scope.title} project`);
  scoped.set(scope.id, [task, done, session, doc, project,
    ...[...records.values()].filter(row => row.parentId === task.id)]);
}
for (const scope of [parent, nested]) {
  const members = [...new Map(scoped.get(scope.id)!.map(row => [row.id, row])).values()];
  const page: StoryPage = {
    ...structuredClone(STORY_FIXTURE.page), roots: [], nodes: [], edges: [], sessions: [], team: [],
    childStories: [], activity: [], feedAnchorIds: [], recentMessages: [], parent: null,
    follow: { depth: 3, limit: 500, truncated: false, edgeTypes: ['parent'] },
  };
  page.nodes = [scope, ...members].map(row => ({
    ...structuredClone(STORY_FIXTURE.page.nodes[0]!), ...row,
    status: row.state.kind === 'task' || row.state.kind === 'work_session' ? row.state.status : null,
    statusCategory: row.category ?? null,
  }));
  page.roots = members.filter(row => !row.parentId).map(row => ({
    ...structuredClone(STORY_FIXTURE.page.roots[0]!), id: row.id, kind: row.kind, title: row.title,
    status: row.state.kind === 'task' || row.state.kind === 'work_session' ? row.state.status : null,
    statusCategory: row.category ?? null,
  }));
  scope.content = { kind: 'story', description: 'Synthetic browser verification story', page };
}

const queries: CollectionQuery[] = [];
function descendants(id: string): Set<string> {
  const found = new Set<string>(), pending = [id];
  while (pending.length) {
    const parentId = pending.shift()!;
    for (const row of records.values()) if (row.parentId === parentId && !found.has(row.id)) {
      found.add(row.id); pending.push(row.id);
    }
  }
  return found;
}
seam.query = async input => {
  queries.push(structuredClone(input));
  const subtree = input.subtreeOf ? descendants(input.subtreeOf) : null;
  const rows = [...records.values()].filter(row => row.spaceId === input.spaceId &&
    (!input.kinds?.length || input.kinds.includes(row.kind)) &&
    (input.parentId === undefined || row.parentId === input.parentId) && (!subtree || subtree.has(row.id)));
  const offset = input.cursor ? Number(input.cursor) : 0;
  const limit = Math.min(input.limit ?? 2, 2);
  return { query: input, page: { items: rows.slice(offset, offset + limit),
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null, total: rows.length } };
};
const originalEntity = seam.entity.bind(seam);
seam.entity = async id => records.has(id) ? structuredClone(records.get(id)!) : originalEntity(id);
const originalChildren = seam.children.bind(seam);
seam.children = async (id, options) => records.has(id)
  ? { items: [...records.values()].filter(row => row.parentId === id), nextCursor: null }
  : originalChildren(id, options);
const originalConnections = seam.connections.bind(seam);
seam.connections = async (id, options) => records.has(id) ? { items: [], nextCursor: null } : originalConnections(id, options);
const originalMessages = seam.messages.bind(seam);
seam.messages = async (id, options) => records.has(id) ? { items: [], nextCursor: null } : originalMessages(id, options);

Object.assign(window, { __phase1GameHarness: { queries, storyId: parent.id, nestedStoryId: nested.id,
  entities: [...records.values()].map(({ id, title, kind }) => ({ id, title, kind })) } });
if (!window.location.hash) window.location.hash = `#/s/${FIXTURE_SPACE_ID}/work`;
createRoot(document.getElementById('root')!).render(<GateApp seam={seam} />);
