import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId, ProjectId } from '@tm8/contract';

import { LaunchComposerPopup } from '../src/new-session/LaunchComposerPopup';
import type { LaunchProjectOption } from '../src/domain/launch';
import type { LaunchContextRow } from '../src/domain/launch-selection';
import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../src/views/launch-fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE LAUNCH CARD v2 (artifact 01a0dd42
 * rev 4). The card's whole narrow-width contract — shed a label, never clip a
 * control; keep every menu inside the card — is a claim about LAYOUT, and the
 * vitest suite runs in jsdom, which has no layout engine. It can prove the
 * DOM says "Dispatch"; only a browser can prove Dispatch is on screen at
 * 800px and that the attach menu near the right edge flipped instead of
 * hanging off the card.
 *
 * The popup is `position: fixed; inset: 0` and sizes itself in container
 * units of that layer, so the BROWSER VIEWPORT is the only input that matters
 * — `capture-launch-card.mjs` drives it at 1440/1024/800/390.
 *
 * Query params
 *   ?verb=run|coordinate   the verb badge (default run)
 *   ?open=<testid>         open one menu on mount by its test id: lcd-attach,
 *                          nsx-model, nsx-effort, nsx-perm, nsx-workdir,
 *                          nsx-team, lcd-subject
 *   ?drawer=1              open the advanced drawer
 *   ?text=1                pre-fill the title and instructions
 */
const params = new URLSearchParams(window.location.search);

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];
const PROJECTS: readonly LaunchProjectOption[] = [
  { projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true },
  { projectId: 'pj-b' as ProjectId, name: 'tm8-server', trusted: true },
];
const CANDIDATES: readonly LaunchContextRow[] = [
  ...LAUNCH_REFERENCE_CANDIDATES,
  { id: 'ent-doc-runbook' as EntityId, kind: 'doc', title: 'Node runbook', text: null, derived: false, via: null },
  { id: 'ent-art-mock' as EntityId, kind: 'artifact', title: 'Launch card — mock v2', text: null, derived: false, via: null },
];

const LONG_TITLE = 'Wire the launch flow end to end and keep the narrow widths honest';

function Harness() {
  const [ready, setReady] = useState(false);
  const selection = useMemo(
    () => ({ load: () => Promise.resolve(LAUNCH_DEFAULTS), candidates: { references: CANDIDATES } }),
    [],
  );

  /* The card is driven through the real DOM after it has settled, so the
     screenshot shows the shipping component reacting to real clicks — not a
     harness-only branch that the product never takes. */
  const drive = () => {
    const menu = params.get('open');
    if (menu) document.querySelector<HTMLElement>(`[data-testid="${menu}"]`)?.click();
    if (params.get('drawer') === '1') document.querySelector<HTMLElement>('[data-testid="lcd-advanced-toggle"]')?.click();
    if (params.get('text') === '1') {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="lcd-instructions"]');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(ta, 'Start from origin/main. Do not touch the seam; the popup already reads launch.defaults.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    setReady(true);
  };

  return (
    <div className="cv2-root" style={{ width: '100%', height: '100%' }}>
      <LaunchComposerPopup
        subject={{ id: 'task-9', title: LONG_TITLE, kind: 'task' }}
        spaceId="sp-1"
        teammates={TEAMMATES}
        projects={PROJECTS}
        capacity={{ slotsFree: 5, slotsTotal: 8 }}
        selection={selection}
        clientMutationId="m:harness"
        verbLabel={params.get('verb') === 'coordinate' ? 'Coordinate' : 'Run'}
        loadDescription={() => Promise.resolve('The Run popup should carry the v2 card at every width.')}
        onSaveSubject={() => {}}
        /* The product's `useLaunchPort` always supplies an upload, so a
           harness without one photographs a refusal the viewer never sees. */
        upload={() => ({ result: new Promise<never>(() => {}), cancel: () => {} })}
        onSpawn={() => {}}
        /* Every real launch surface wires Dispatch through the launch port, so
           the harness draws it too — the footer is measured as it ships. */
        onDispatch={() => Promise.resolve()}
        onDismiss={() => {}}
      />
      {/* The defaults land asynchronously; the driver runs on the frame after
          the references chip has stopped saying "…" so a menu opens against
          settled content, not a spinner. */}
      <Settle onSettled={drive} />
      {ready ? <span data-testid="harness-ready" /> : null}
    </div>
  );
}

function Settle({ onSettled }: { onSettled: () => void }) {
  const [done, setDone] = useState(false);
  if (!done) {
    const tick = () => {
      const chip = document.querySelector('[data-testid="lsel-chip-references"]');
      if (chip && !chip.textContent?.includes('…')) {
        setDone(true);
        requestAnimationFrame(onSettled);
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }
  return null;
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
