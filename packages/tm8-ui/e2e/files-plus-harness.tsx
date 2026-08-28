import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import { createRealSeam } from '../src/data';
import { ListRootHeader, rootBirthAction } from '../src/panels';
import { stagedBirthFor } from '../src/authoring';
import { getKind } from '../src/domain';
import { homeRootKinds } from '../src/domain/home-rail';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

/**
 * A BROWSER HARNESS FOR THE ROOT HEADER'S ＋, AGAINST THE REAL NODE.
 *
 * THE QUESTION IT ANSWERS. `staged-birth-wired.test.ts` proves both hosts call
 * `stagedBirthFor`; `staged-birth.test.tsx` proves the action never commits an
 * entity before the bytes are stored. Neither can see whether pressing the ＋
 * that a viewer actually presses opens an OS file picker, because jsdom has no
 * picker and no node behind it. That is the seam Tarkesh bug 01a04730 lived in
 * — the control was right, the header never reached it — so the evidence has
 * to be a real click in a real browser against a real server.
 *
 * WHY A HARNESS AND NOT THE APP. `capture-files-plus.mjs` drives the whole app
 * and is the better instrument when it can run. On a loaded box it cannot: the
 * headless renderer is OOM-killed composing a screenshot of the full surface,
 * and a crash there reports as a failure of the thing under test. This mounts
 * the SAME `ListRootHeader` over the SAME `stagedBirthFor` and nothing else, so
 * the tree is small enough to survive. What it gives up is the app's own boot;
 * what it keeps is every part this change touches.
 *
 * THE SEAM IS REAL — `createRealSeam` over same-origin `/v2`, which vite
 * proxies to the node. A fixture seam here would prove nothing: the whole
 * defect was a create door that never reached a node, and a harness that
 * cannot reach one either would go green on the bug.
 *
 * `?space=<id>` names the space to upload into. `?token=` is NOT accepted —
 * a pass in a URL lands in proxy logs and browser history; the runner writes
 * it into `localStorage` the way the gate itself does.
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const spaceId = (params.get('space') ?? '') as SpaceId;
  const [seam] = useState(() =>
    createRealSeam({
      baseUrl: '',
      /* REQUIRED alongside a relative `baseUrl`: the seam derives its socket
         URL from one or the other, and refuses rather than guessing. */
      origin: window.location.origin,
      /* REQUIRED. Without it the client answers `upstream_unavailable` before
         it makes a single request, and `safeUploadReason` correctly reduces
         that to "Upload failed. Try again." — which reads exactly like the
         product defect and is not one. Bound because a bare `window.fetch`
         reference is called with the wrong receiver. */
      fetch: window.fetch.bind(window),
      getAuthToken: () => {
        const raw = window.localStorage.getItem('tm8ui.auth.passes.v1');
        const all = raw ? (JSON.parse(raw) as Record<string, { token?: string }>) : {};
        return all[window.location.origin]?.token ?? null;
      },
    }),
  );
  const [log, setLog] = useState<string[]>([]);
  const note = useCallback((line: string) => setLog((all) => [...all, line]), []);

  /* The seam, reachable from the driving script. `safeUploadReason` is doing
     its job when it answers "Upload failed. Try again." — it must never leak a
     transport path or a token — but a HARNESS is where the raw failure has to
     be readable, or a red run says nothing about which call broke. */
  (window as unknown as { __seam?: unknown }).__seam = seam;

  const config = getKind('file');

  /**
   * THE HOSTS' `birthFor`, reduced to the two arms this harness can exercise.
   * It is deliberately the same SHAPE as `WorkspaceView.birthFor` — staged
   * first, generic second — because a harness that asked the question in a
   * different order would be testing a different function.
   */
  const birthFor = (kind: string): { refusal: null; perform: () => void } => {
    const target = getKind(kind);
    const staged = stagedBirthFor(target, {
      spaceId,
      files: seam.files,
      onCreated: (id: EntityId, result: CommandResult) =>
        note(`created ${id} · patches ${result.patches?.length ?? 0}`),
      onNotice: (text: string) => note(`refused: ${text}`),
    });
    if (staged) return { refusal: null, perform: staged };
    return { refusal: null, perform: () => note(`generic create for ${kind} — NOT the staged door`) };
  };

  return (
    <div style={{ width: 420, padding: 12 }}>
      <ListRootHeader
        rootsLabel="Harness roots"
        cell={{ kind: config.kind, label: config.labelPlural, single: config.label }}
        cellActive
        onSelectCell={() => undefined}
        onCreate={birthFor(config.kind).perform}
        options={homeRootKinds().map((k) => ({ kind: k.kind, label: k.labelPlural, single: k.label }))}
        currentKind={config.kind}
        onPickKind={() => undefined}
        onCreateKind={(kind) => birthFor(kind).perform()}
        createKindUnavailable={() => null}
      />
      {/* The outcome, in text, so the capture script can assert on it rather
          than on a screenshot a human has to interpret. */}
      <ul data-testid="harness-log" style={{ marginTop: 12, fontFamily: 'monospace', fontSize: 12 }}>
        {log.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p style={{ fontSize: 11, opacity: 0.7 }}>
        birth verb for this cell: {rootBirthAction(config.kind) ? 'started' : 'created'}
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
