import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityCapabilities, EntitySummary } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import type { SessionSharingPatch } from '../src/panels/controls/EntityControls';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/list/maestro-task-tile.css';

/**
 * THE SESSION SHARING PICKER (187 follow-through) in a real browser.
 *
 * The row's sharing slot opens a popover with two radiogroups. Each click
 * sends ONLY its own dial — the log below prints the exact patch — and the
 * handler applies it the way the RPC does: the named key is written, the other
 * is left alone, and `sharingSetAt` is stamped. The first session is re-cast
 * as TEAMMATE-launched with `sharingSetAt: null`, so its picker shows the
 * "open until set" note, and flips to the "applies to everyone" note after
 * the first write.
 *
 *   /e2e/sharing-harness.html
 */
const CAPS_SESSION: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: false, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

function seed(): EntitySummary[] {
  return fixtureSummaries
    .filter((r) => r.kind === 'work_session')
    .slice(0, 3)
    .map((r, i) => ({
      ...r,
      ...(i === 0 ? { createdBy: { ...r.createdBy, kind: 'team_member' } as typeof r.createdBy } : {}),
      state: {
        ...r.state,
        shareMode: i === 1 ? 'none' : 'space',
        driveMode: 'owner',
        sharingSetAt: i === 0 ? null : '2026-09-20T10:00:00.000Z',
      } as typeof r.state,
    }));
}

function Harness() {
  const [rows, setRows] = useState(seed);
  const [log, setLog] = useState<string[]>([]);
  const share = (id: string, patch: SessionSharingPatch) => {
    setLog((prev) => [`${id.slice(0, 10)} ← ${JSON.stringify(patch)}`, ...prev].slice(0, 6));
    setRows((prev) =>
      prev.map((r) =>
        r.id !== id
          ? r
          : ({ ...r, state: { ...r.state, ...patch, sharingSetAt: new Date().toISOString() } } as EntitySummary),
      ),
    );
  };
  return (
    <div className="cv2-root">
      <div className="harness-col">
        <div className="harness-panel">
          <EntityListPanel
            kind="work_session"
            rowsFor={() => rows}
            ctx={ctx}
            capabilitiesOf={() => CAPS_SESSION}
            livenessOf={() => 'live'}
            onAction={() => undefined}
            onTerminate={() => undefined}
            onComplete={() => undefined}
            onShareSession={share}
          />
        </div>
        <pre className="harness-log" data-testid="harness-log">{log.join('\n') || '— no writes yet —'}</pre>
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; padding: 14px; }
  .harness-panel { width: 360px; height: 300px; overflow: auto; background: var(--pn-card, #fff); border-radius: 8px; }
  .harness-log { margin: 0; padding: 6px 8px; width: 360px; box-sizing: border-box;
    font: 10px/1.5 ui-monospace, monospace; color: #d8ffd8; background: #1c1c1c; border-radius: 6px;
    white-space: pre-wrap; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
