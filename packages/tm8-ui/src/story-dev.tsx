import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';

import { StoryPage } from './story/StoryPage';
import type { StoryActions } from './story/actions';
import { STORY_FIXTURE, STORY_FIXTURE_EMPTY } from './story/fixture';

/**
 * STORY PAGE SCRATCH HARNESS — the story page on fixtures, no server, no auth.
 *
 * Usage: /story-dev.html   (?theme=dark for the dark ground,
 *                           ?empty=1     for the empty story,
 *                           ?view=team   etc. is read by the graph block,
 *                           ?readonly=1  for a host that wires no actions)
 *
 * Every action logs to the console and resolves after a short delay, so the
 * affordances behave (pending → done) without a server.
 */
function fakeActions(log: (line: string) => void): StoryActions {
  const ok = <T,>(line: string, value?: T) =>
    new Promise<T | undefined>((resolve) => {
      log(line);
      setTimeout(() => resolve(value), 250);
    });
  return {
    add: (req) => ok(`add ${JSON.stringify(req)}`, 'fx-new').then(() => 'fx-new'),
    createTask: (parentId, title) => ok(`createTask ${parentId} ${title}`).then(() => 'fx-new-task'),
    rename: (entityId, title) => ok(`rename ${entityId} ${title}`).then(() => undefined),
    markDone: (entityId) => ok(`markDone ${entityId}`).then(() => undefined),
    sendMessage: (anchorId, body) => ok(`sendMessage ${anchorId} ${body}`).then(() => 'fx-new-msg'),
    addRoot: (entityId) => ok(`addRoot ${entityId}`).then(() => undefined),
    removeRoot: (entityId) => ok(`removeRoot ${entityId}`).then(() => undefined),
    setStatus: (status) => ok(`setStatus ${status}`).then(() => undefined),
    open: (entityId) => void log(`open ${entityId}`),
  };
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  const view = params.get('empty') === '1' ? STORY_FIXTURE_EMPTY : STORY_FIXTURE;
  const [lines, setLines] = useState<string[]>([]);
  const actions = useMemo<StoryActions>(
    () =>
      params.get('readonly') === '1'
        ? {}
        : fakeActions((line) => {
            console.info('[story-dev]', line);
            setLines((l) => [...l.slice(-4), line]);
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <div className="cv2-root" data-theme={theme} style={{ minHeight: '100vh', background: 'var(--pn-paper)' }}>
      <StoryPage view={view} actions={actions} />
      {lines.length > 0 && (
        <pre data-testid="story-dev-log" style={{ position: 'fixed', left: 8, bottom: 8, margin: 0, fontSize: 11, opacity: 0.7 }}>
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
