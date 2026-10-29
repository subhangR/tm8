import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId, ProjectId } from '@tm8/contract';

import { LaunchComposerPopup } from '../src/new-session/LaunchComposerPopup';
import type { LaunchProjectOption } from '../src/domain/launch';
import type { LaunchContextRow, LaunchDefaultsResult } from '../src/domain/launch-selection';
import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../src/views/launch-fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE LAUNCH CARD. The card's size and
 * narrow-width contract — content-sized, shed a label, never clip a control —
 * is a claim about LAYOUT, and the vitest suite runs in jsdom, which has no
 * layout engine. Only a browser can measure that the card is 300px tall with
 * nothing attached, or that a menu still fits at 800px.
 *
 * The popup is `position: fixed; inset: 0` and sizes itself in container
 * units of that layer, so the BROWSER VIEWPORT is the only input that matters
 * — `capture-launch-card.mjs` drives it.
 *
 * Query params
 *   ?verb=run|coordinate   the verb badge (default run)
 *   ?open=<testid>         open one menu on mount by its test id: lcd3-attach,
 *                          nsx-model, nsx-effort, nsx-perm, nsx-workdir, lcd-verb
 *   ?drawer=1              open the advanced drawer
 *   ?text=1|long           type notes into the card (long: eight lines)
 *   ?theme=dark            the dark palette
 *   ?attach=0              the launch starts with nothing attached
 *   ?launch=1              press Launch; the node never answers (the in-card launching state)
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
  { id: 'ent-art-mock' as EntityId, kind: 'artifact', title: 'Launch card — mock', text: null, derived: false, via: null },
];

const EMPTY_GROUP = { items: [], total: 0, budget: null, floor: 1.5, minEntries: 1 };
const NOTHING_ATTACHED: LaunchDefaultsResult = {
  ...LAUNCH_DEFAULTS,
  memories: EMPTY_GROUP,
  skills: EMPTY_GROUP,
  references: EMPTY_GROUP,
};

const LONG_TITLE = 'Wire the launch flow end to end and keep the narrow widths honest';

function Harness() {
  const [ready, setReady] = useState(false);
  const selection = useMemo(
    () => ({
      load: () => Promise.resolve(params.get('attach') === '0' ? NOTHING_ATTACHED : LAUNCH_DEFAULTS),
      candidates: { references: CANDIDATES },
    }),
    [],
  );

  /* The card is driven through the real DOM after it has settled, so the
     screenshot shows the shipping component reacting to real clicks — not a
     harness-only branch that the product never takes. */
  const drive = () => {
    if (params.get('text') === '1' || params.get('text') === 'long') {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="lcd3-notes"]');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        const line = 'Start from origin/main. Do not touch the seam; the popup already reads launch.defaults.';
        setter?.call(ta, params.get('text') === 'long' ? Array.from({ length: 8 }, () => line).join('\n') : line);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const menu = params.get('open');
    if (menu) document.querySelector<HTMLElement>(`[data-testid="${menu}"]`)?.click();
    if (params.get('drawer') === '1') document.querySelector<HTMLElement>('[data-testid="lcd-advanced-toggle"]')?.click();
    if (params.get('launch') === '1') document.querySelector<HTMLElement>('[data-testid="nsx-send"]')?.click();
    requestAnimationFrame(() => setReady(true));
  };

  return (
    <div
      className="cv2-root"
      data-theme={params.get('theme') === 'dark' ? 'dark' : undefined}
      style={{ width: '100%', height: '100vh', background: 'var(--pn-paper)' }}
    >
      <LaunchComposerPopup
        subject={{ id: 'task-9', title: LONG_TITLE, kind: 'task' }}
        spaceId="sp-1"
        teammates={TEAMMATES}
        projects={PROJECTS}
        capacity={{ slotsFree: 5, slotsTotal: 8 }}
        selection={selection}
        clientMutationId="m:harness"
        verbLabel={params.get('verb') === 'coordinate' ? 'Coordinate' : 'Run'}
        loadDescription={() => Promise.resolve('The Run popup should carry the card at every width.')}
        /* The product's `useLaunchPort` always supplies an upload, so a
           harness without one photographs a refusal the viewer never sees. */
        upload={() => ({ result: new Promise<never>(() => {}), cancel: () => {} })}
        /* A node that never answers: the launching state stays on screen. */
        onSpawn={() => new Promise<void>(() => {})}
        /* Every real launch surface wires Dispatch through the launch port, so
           the harness draws it too — the footer is measured as it ships. */
        onDispatch={() => Promise.resolve()}
        onDismiss={() => {}}
      />
      {/* The defaults land asynchronously; the driver runs once the strip has
          stopped reading them, so a menu opens against settled content. */}
      <Settle onSettled={drive} />
      {ready ? <span data-testid="harness-ready" /> : null}
    </div>
  );
}

function Settle({ onSettled }: { onSettled: () => void }) {
  const [done, setDone] = useState(false);
  if (!done) {
    const tick = () => {
      const card = document.querySelector('[data-testid="launch-card"]');
      if (card && !card.textContent?.includes('Reading context')) {
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
