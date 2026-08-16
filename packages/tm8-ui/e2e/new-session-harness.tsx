import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { CommandResult, CreateEntityInput, EntityId, ExecutionSpawnInput, SpaceId } from '@tm8/contract';

import { NewSessionScreen } from '../src/new-session';
import { LAUNCH_CAPACITY, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from '../src/views/launch-fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR `NewSessionScreen`.
 *
 * WHY IT EXISTS: the whole feature is a TRANSITION, and jsdom has no layout
 * engine and loads no stylesheets — so no vitest in this package can see
 * whether the composer is centred, whether the veil covers the terminal, or
 * whether the terminal lands at full size. Only pixels can. The app root sits
 * behind `AuthGate`, so this mounts the real screen directly instead.
 *
 * IT MOUNTS THE REAL COMPONENT, not a reconstruction. The create and spawn
 * ports are the only fakes, and they are faked for LATENCY CONTROL — a real
 * spawn resolves too fast (or too slow) to photograph a named phase reliably.
 *
 * `?hold=<phase>` parks the screen mid-transition so a single frame can be
 * captured: `minting`, `spawning`. `?slow=1` also drives the slow notice.
 * With no params the ports resolve immediately and the screen settles.
 */
const params = new URLSearchParams(window.location.search);
const hold = params.get('hold');
const slow = params.get('slow') === '1';

const SPACE = 'sp-atelier' as SpaceId;
const TASK = 'task-new-session-demo' as EntityId;
const SESSION = 'ws-new-session-demo' as EntityId;

/** Never resolves — parks the screen in whatever phase precedes this port. */
const forever = <T,>(): Promise<T> => new Promise<T>(() => {});

function Harness() {
  const commands = useMemo(() => ({
    createEntity: (_input: CreateEntityInput): Promise<CommandResult> => {
      if (hold === 'minting') return forever<CommandResult>();
      return Promise.resolve({
        entity: { id: TASK },
        patches: [],
      } as unknown as CommandResult);
    },
  }), []);

  const spawn = useMemo(() => (_input: ExecutionSpawnInput): Promise<EntityId> => {
    if (hold === 'spawning') return forever<EntityId>();
    if (slow) return new Promise((resolve) => setTimeout(() => resolve(SESSION), 30_000));
    return Promise.resolve(SESSION);
  }, []);

  return (
    <div className="cv2-root" style={{ height: '100vh' }}>
      <NewSessionScreen
        spaceId={SPACE}
        commands={commands}
        spawn={spawn}
        launch={{
          teammates: LAUNCH_TEAMMATES,
          projects: LAUNCH_PROJECTS.map((project) => ({
            id: project.projectId,
            name: project.name,
            trusted: project.trusted,
          })),
          capacity: LAUNCH_CAPACITY,
        }}
        onSessionReady={() => { /* the harness has nowhere to navigate to */ }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
