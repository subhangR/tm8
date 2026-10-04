/**
 * Browser-only harness for the story drill-in (task 01a1090f): the story page
 * mounted on whatever entity the navStore routes to, with the navStore's
 * pushes mirrored into browser history and popstate mirrored back — the slice
 * of GateApp's URL sync the Enter / Esc round trip needs. Fixtures only.
 * ?theme=dark for the dark ground.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId } from '@tm8/contract';
import { StoryPage } from '../src/story/StoryPage';
import { STORY_FIXTURE } from '../src/story/fixture';
import type { StoryView } from '../src/story/model';
import { storyGameStore } from '../src/story/game/store';
import { navStore, resetNav, useNavStore } from '../src/stores/navStore';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

/** The first child story as a smaller story of its own, whose parent is the fixture. */
function childView(): StoryView {
  const child = STORY_FIXTURE.page.childStories[0]!;
  const view = structuredClone(STORY_FIXTURE);
  const roots = view.page.roots.slice(0, 2);
  const keep = new Set([child.id, ...roots.map((r) => r.id)]);
  for (const n of view.page.nodes) if (n.rootIds.some((id) => keep.has(id))) keep.add(n.id);
  view.id = child.id;
  view.title = child.title;
  view.page.parent = { id: STORY_FIXTURE.id, title: STORY_FIXTURE.title };
  view.page.roots = roots.map((r) => ({ ...r, trail: r.trail.filter((t) => keep.has(t.id) && keep.has(t.viaId)) }));
  view.page.nodes = view.page.nodes.filter((n) => keep.has(n.id)).map((n) => (n.id === STORY_FIXTURE.id ? { ...n, id: child.id, title: child.title } : n));
  view.page.edges = view.page.edges.filter((e) => keep.has(e.fromId) && keep.has(e.toId));
  view.page.childStories = [];
  view.page.sessions = view.page.sessions.filter((s) => s.taskIds.some((id) => keep.has(id)));
  return view;
}
const VIEWS = new Map<string, StoryView>([[STORY_FIXTURE.id, STORY_FIXTURE], [STORY_FIXTURE.page.childStories[0]!.id, childView()]]);

resetNav('', { view: 'entity', entityId: STORY_FIXTURE.id as EntityId, origin: null, full: true });
history.replaceState({ view: navStore.getState().view }, '');
let seen = navStore.getState().revision;
navStore.subscribe((s) => {
  if (s.revision === seen) return;
  seen = s.revision;
  if (s.history === 'push') history.pushState({ view: s.view }, '');
  else history.replaceState({ view: s.view }, '');
});
addEventListener('popstate', (e) => {
  const view = (e.state as { view?: ReturnType<typeof navStore.getState>['view'] } | null)?.view;
  if (!view) return;
  navStore.setState((s) => ({ view, history: 'replace', revision: s.revision + 1 }));
  seen = navStore.getState().revision;
});
storyGameStore.getState().setMode(STORY_FIXTURE.id, 'game');

function Harness() {
  const routed = useNavStore((s) => (s.view.view === 'entity' ? s.view.entityId : null));
  const [opened, setOpened] = useState<string[]>([]);
  const view = routed ? VIEWS.get(routed) : undefined;
  const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : undefined;
  return (
    <div className="cv2-root" data-theme={theme} style={{ minHeight: '100vh', background: 'var(--pn-paper)' }}>
      {view ? <StoryPage key={view.id} view={view} layout="full" actions={{ open: (id) => setOpened((o) => [...o.slice(-2), id]) }} /> : <p>No story routed: {routed}</p>}
      <output data-testid="drill-opened" style={{ position: 'fixed', right: 8, bottom: 8, fontSize: 'var(--pn-fs-fine)', color: 'var(--pn-ink-3)' }}>{opened.length ? `open → ${opened.join(', ')}` : ''}</output>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
