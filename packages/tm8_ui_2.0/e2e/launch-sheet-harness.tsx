import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId } from '@tm8/contract';
import { LaunchSheet } from '../src/views/LaunchSheet';
import {
  LAUNCH_CAPACITY,
  LAUNCH_PROFILES,
  LAUNCH_PROJECTS,
  LAUNCH_TEAMMATES,
  type LaunchTeammate,
} from '../src/views/launch-fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR `LaunchSheet` — the 2026-08-09
 * reorganisation (important configuration on top, searchable teammate roster)
 * is a claim about WHAT SITS ABOVE THE FOLD, and jsdom has no layout engine:
 * the vitest suite proves DOM order, not that the model/effort/permission
 * controls are actually visible without scrolling, nor that a 14-teammate
 * roster stays capped instead of pushing them off screen.
 *
 * `?roster=big` swells the roster past the search threshold so the filter and
 * the scroll cap can be measured; the default mounts the standard fixtures.
 */
const params = new URLSearchParams(window.location.search);
const big = params.get('roster') === 'big';

const BIG_ROSTER: readonly LaunchTeammate[] = [
  ...LAUNCH_TEAMMATES,
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `ent-tm-extra-${i}`,
    name: ['lint', 'probe', 'draft', 'zeta', 'quill', 'sable', 'rook', 'ivy', 'moss', 'flint', 'wren', 'ash'][i] ?? `tm-${i}`,
    initial: 'T',
    model: i % 2 === 0 ? 'claude-opus-5' : 'claude-sonnet-5',
    agentTool: 'claude-code',
    owner: '@ada',
  })),
];

function Harness() {
  const teammates = useMemo(() => (big ? BIG_ROSTER : LAUNCH_TEAMMATES), []);
  const [submitted, setSubmitted] = useState<string>('');
  return (
    <div className="cv2-root" style={{ width: '100%', height: '100%' }}>
      <div style={{ position: 'relative', width: 900, height: 860, background: 'var(--pn-bg)' }}>
        <LaunchSheet
          subjectId={'task-harness' as EntityId}
          fromChip="◔ Run ▸"
          fromCaption="subject pre-associated — the session links to it"
          teammates={teammates}
          projects={LAUNCH_PROJECTS}
          profiles={LAUNCH_PROFILES}
          capacity={LAUNCH_CAPACITY}
          onLaunch={(config) => setSubmitted(JSON.stringify(config))}
          onCancel={() => {}}
        />
        {submitted ? <pre data-testid="harness-submitted">{submitted}</pre> : null}
      </div>
      <span data-testid="harness-ready" />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
