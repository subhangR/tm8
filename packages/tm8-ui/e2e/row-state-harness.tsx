import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityCapabilities } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../src/fixtures';
import type { ActionContext, ActionRef } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/list/maestro-task-tile.css';

/**
 * D67 — a PIXEL harness for the expanded row's state dropdown and archive
 * control, over fixtures.
 *
 * WHY A HARNESS RATHER THAN THE APP. The 34 vitest assertions run in jsdom,
 * which has no layout engine: they can prove the select exists, carries the
 * right options and dispatches the right verb, and they CANNOT prove it fits
 * in a 280px side panel, that the strip does not overflow its tile, or that
 * the pill reads legibly in both themes. Those are the only questions left,
 * and a screenshot is the only instrument that answers them.
 *
 * FIXTURES, NOT THE REAL SEAM, ON PURPOSE. What is under test is a control's
 * GEOMETRY across three tile anatomies and three refusal states. Fixtures put
 * all of them on screen at once and deterministically; a live space would show
 * whichever rows it happens to hold, which is a worse oracle for a layout
 * question and needs a server to be running at all.
 *
 * BOTH THEMES SIDE BY SIDE, because a token that only resolves in light is a
 * defect this package has shipped before.
 *
 *   /e2e/row-state-harness.html?kind=task
 */
const CAPS_FULL: EntityCapabilities = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

const CAPS_NONE: EntityCapabilities = {
  canEdit: false, canDelete: false, canAddChild: false, canLink: false,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/** The three anatomies, one column each — control-card, session-tree, standard. */
const KINDS = ['task', 'work_session', 'doc'] as const;

function Column({
  kind,
  theme,
  caps,
  wired,
  label,
}: {
  kind: string;
  theme: 'light' | 'dark';
  caps: EntityCapabilities | undefined;
  wired: boolean;
  label: string;
}) {
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((prev) => [line, ...prev].slice(0, 4));

  return (
    <div className="cv2-root" data-astryx-theme="neutral" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="harness-col">
        <div className="harness-cap">{label}</div>
        {/* 280px — the real side-panel width. A control that only fits at
            desk width has not been verified for where it actually ships. */}
        <div className="harness-panel">
          <EntityListPanel
            kind={kind}
            rowsFor={() => fixtureSummaries.filter((r) => r.kind === kind)}
            ctx={ctx}
            capabilitiesOf={() => caps}
            onSetState={
              wired
                ? (id, next, via) => note(`setState ${next} via ${via} → ${id.slice(0, 12)}`)
                : undefined
            }
            onArchive={
              wired ? (ref: ActionRef, id) => note(`${ref} → ${id.slice(0, 12)}`) : undefined
            }
          />
        </div>
        <pre className="harness-log">{log.join('\n') || '— no writes yet —'}</pre>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div className="harness-grid">
      {(['light', 'dark'] as const).map((theme) =>
        KINDS.map((kind) => (
          <Column
            key={`${theme}-${kind}`}
            kind={kind}
            theme={theme}
            caps={CAPS_FULL}
            wired
            label={`${kind} · ${theme} · wired`}
          />
        )),
      )}
      {/* The refusal states, which are half of what this control IS. */}
      <Column kind="task" theme="light" caps={CAPS_NONE} wired label="task · refused permission" />
      <Column kind="task" theme="light" caps={undefined} wired label="task · capabilities loading" />
      <Column kind="task" theme="light" caps={CAPS_FULL} wired={false} label="task · host unwired" />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  .harness-panel { width: 280px; height: 620px; overflow: auto; background: var(--pn-card, #fff); border-radius: 8px; }
  .harness-log { margin: 0; padding: 6px 8px; width: 280px; box-sizing: border-box;
    font: 10px/1.5 ui-monospace, monospace; color: #d8ffd8; background: #1c1c1c; border-radius: 6px;
    white-space: pre-wrap; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
