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
 * THE HOVER ACTION CLUSTER — Collections · Run · Archive · disclosure — across
 * all three tile anatomies, in a real browser.
 *
 * WHY A HARNESS AND NOT THE APP. Three of the four claims this lane makes are
 * invisible to vitest, because jsdom loads no stylesheets: that the cluster is
 * REVEALED on hover, that its icons sit on one row without colliding with the
 * title at panel width, and that they read in both themes. The fourth — that
 * Archive is absent exactly where the server refuses it — is a DOM question
 * vitest can answer, but only here can you see that its absence leaves no hole.
 *
 * WHY NOT THE RUNNING APP. The app root is behind a sign-in card whenever the
 * node is claimed, and forging a pass to get past it would make the screenshot
 * evidence of nothing. What the app CAN prove independently is that the server
 * puts capabilities on a list summary at all, and that is proven against the
 * live HTTP endpoint rather than guessed at here.
 *
 * CAPABILITIES ARE THE REAL PER-KIND ANSWERS, not an all-true convenience.
 * They are transcribed from what `/v2/collections/query` returned for each kind
 * against a live node on this branch, so what renders below is what the server
 * actually authorises — in particular `work_session.canDelete === false`, which
 * is what must make Archive VANISH rather than grey out.
 *
 *   /e2e/cluster-harness.html
 */

/** As the server answers for a live `task`, `doc` or `collection`. */
const CAPS_DELETABLE: EntityCapabilities = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

/**
 * As the server answers for a live `work_session`: `delete_entity` (migration
 * 017) refuses the kind outright, so `canDelete` is false and the cluster must
 * show NO archive icon at all. `canEdit` stays true — a session's one editable
 * field is its display title.
 */
const CAPS_SESSION: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: false, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

/**
 * The state that must NOT hide anything. Capabilities now ride the summary, so
 * "unknown" is rare — but a row in neither cache, or one from a node too old to
 * send the field, still reaches this. Hiding here would make icons pop in a
 * beat late and reflow the strip under the pointer, so the slot is drawn and
 * refused instead.
 */
const CAPS_UNKNOWN = undefined;

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

function Column({
  kind,
  theme,
  caps,
  label,
}: {
  kind: string;
  theme: 'light' | 'dark';
  caps: EntityCapabilities | undefined;
  label: string;
}) {
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((prev) => [line, ...prev].slice(0, 4));

  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="harness-col">
        <div className="harness-cap">{label}</div>
        {/* 280px — the real side-panel width, which is where the strip is most
            likely to collide with a title. */}
        <div className="harness-panel">
          <EntityListPanel
            kind={kind}
            rowsFor={() => fixtureSummaries.filter((r) => r.kind === kind)}
            ctx={ctx}
            capabilitiesOf={() => caps}
            livenessOf={() => 'live'}
            onAction={(ref: ActionRef, id) => note(`${ref} → ${id.slice(0, 12)}`)}
            onArchive={(ref: ActionRef, id) => note(`${ref} → ${id.slice(0, 12)}`)}
            onTerminate={(id) => note(`terminate → ${id.slice(0, 12)}`)}
            onMembership={(id, setId, on) =>
              note(`${on ? 'add to' : 'remove from'} ${setId.slice(0, 8)} → ${id.slice(0, 8)}`)
            }
            connectionsOf={() => ({ incoming: [], outgoing: [], unresolvedHardDependencyCount: 0 })}
            membershipSets={fixtureSummaries.filter((r) => r.kind === 'collection')}
          />
        </div>
        <pre className="harness-log">{log.join('\n') || '— no writes yet —'}</pre>
      </div>
    </div>
  );
}

/** The three anatomies: control-card, session-tree, standard. */
const ANATOMIES = [
  { kind: 'task', caps: CAPS_DELETABLE, note: 'control-card' },
  { kind: 'work_session', caps: CAPS_SESSION, note: 'session-tree · NO archive' },
  { kind: 'doc', caps: CAPS_DELETABLE, note: 'standard' },
] as const;

function Harness() {
  return (
    <div className="harness-grid">
      {(['light', 'dark'] as const).map((theme) =>
        ANATOMIES.map((a) => (
          <Column
            key={`${theme}-${a.kind}`}
            kind={a.kind}
            theme={theme}
            caps={a.caps}
            label={`${a.kind} · ${a.note} · ${theme}`}
          />
        )),
      )}
      <Column
        kind="doc"
        theme="light"
        caps={CAPS_UNKNOWN}
        label="doc · capabilities unknown · archive REFUSED not hidden"
      />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  .harness-panel { width: 280px; height: 420px; overflow: auto; background: var(--pn-card, #fff); border-radius: 8px; }
  .harness-log { margin: 0; padding: 6px 8px; width: 280px; box-sizing: border-box;
    font: 10px/1.5 ui-monospace, monospace; color: #d8ffd8; background: #1c1c1c; border-radius: 6px;
    white-space: pre-wrap; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
