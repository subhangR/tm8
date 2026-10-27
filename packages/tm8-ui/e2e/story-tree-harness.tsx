/** Browser-only test entry. Optional snapshots are read-only local evidence, never bundled. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoryPage } from '../src/story/StoryPage';
import { storyGameStore } from '../src/story/game/store';
import { STORY_FIXTURE } from '../src/story/fixture';
import { toStoryView } from '../src/story/data/toStoryView';
import { EMPTY_PROGRESS, type StoryNode, type StoryView } from '../src/story/model';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

const params = new URLSearchParams(location.search);
function large(): StoryView {
  const view = structuredClone(STORY_FIXTURE);
  view.page.nodes = [];
  view.page.edges = [];
  view.page.roots = [];
  view.page.sessions = [];
  view.page.childStories = [];
  view.page.team = [];
  const node = (id: string, title: string, kind: string): StoryNode => ({ id, title, kind, depth: 0, rootIds: [],
    status: 'open', statusCategory: 'to_do', blocked: false, createdAt: '', activityAt: null });
  for (let b = 0; b < 24; b++) {
    const root = node(`branch-${b}`, `Workstream ${b + 1}`, 'story');
    view.page.nodes.push(root);
    const ids: string[] = [];
    for (let n = 0; n < 50; n++) {
      const child = node(`child-${b}-${n}`, `Workstream ${b + 1} · Task ${n + 1}`, 'task');
      view.page.nodes.push(child);
      ids.push(child.id);
      view.page.edges.push({ id: null, fromId: root.id, toId: child.id, type: 'parent', family: 'parent', cross: false, rootIds: [root.id] });
    }
    view.page.roots.push({ ...root, position: b, childIds: ids, descendantCount: 50, trail: [], progress: EMPTY_PROGRESS,
      taskProgress: { ...EMPTY_PROGRESS, work: 50, toDo: 50 } });
  }
  view.title = 'A story with 1,200 tasks';
  view.state = { ...view.state, rootCount: 24, itemCount: 1224, liveSessionCount: 0,
    taskProgress: { ...EMPTY_PROGRESS, work: 1200, toDo: 1200 } };
  return view;
}

let initial = params.has('large') ? large() : STORY_FIXTURE;
if (params.has('snapshot')) {
  const entity = await fetch(`/e2e/story-snapshots/${encodeURIComponent(params.get('snapshot')!)}.json`).then(r => r.json());
  initial = toStoryView({ entity })!;
}
storyGameStore.getState().setMode(initial.id, 'tree');
function Harness() {
  const [view, setView] = useState(initial);
  const [result, setResult] = useState('');
  const [dark, setDark] = useState(params.has('dark'));
  const [paused, setPaused] = useState(false);
  const create = async (parentId: string, title: string, kind: string) => {
    setResult(JSON.stringify({ operation: 'create', parentId, title, kind }));
    const id = `created-${Date.now()}`;
    setView(old => {
      const parentKind = parentId === old.id ? 'story' : old.page.nodes.find(n => n.id === parentId)?.kind;
      const isStory = parentKind === 'story';
      const isChild = parentKind === kind;
      return { ...old, page: { ...old.page, nodes: [...old.page.nodes, {
        id, title, kind, depth: 1, rootIds: [], status: 'open', statusCategory: 'to_do', blocked: false, createdAt: '', activityAt: null,
      }], edges: [...old.page.edges, {
        id: null, fromId: isStory || isChild ? parentId : id, toId: isStory || isChild ? id : parentId,
        type: isStory ? 'contains' : isChild ? 'parent' : 'attached_to',
        family: isStory ? 'story' : isChild ? 'parent' : 'made', cross: false, rootIds: [],
      }] } };
    });
    return id;
  };
  return <div className="cv2-root" data-theme={dark ? 'dark' : undefined} style={{ minHeight: '100vh', background: 'var(--pn-paper)' }}>
    <div style={{ display: 'flex', gap: 12, padding: '4px 12px', fontSize: 11 }}>
      <button onClick={() => setDark(!dark)}>Theme</button>
      <button onClick={() => setView(old => ({ ...old, version: old.version + 1 }))}>Live refresh</button>
      <output data-testid="action-result">{result}</output>
    </div>
    <StoryPage view={view} layout="full" actions={{
      open: id => setResult(`open:${id}`),
      createTask: (p, t) => create(p, t, 'task'), createDocument: (p, t) => create(p, t, 'doc'),
      add: async req => { setResult(JSON.stringify(req)); },
      sendMessage: async (id, body) => { setResult(JSON.stringify({ id, body })); },
      setStatus: async status => setView(old => ({ ...old, status })),
    }} runners={[{ id: 'test-runner', name: 'Browser test teammate', mode: 'worker' }]}
    live={{ status: paused ? 'paused' : 'live', paused, setPaused, queued: 0, updatesLastMinute: 0, landed: new Set() }} />
  </div>;
}
document.body.style.margin = '0';
createRoot(document.getElementById('root')!).render(<Harness />);
