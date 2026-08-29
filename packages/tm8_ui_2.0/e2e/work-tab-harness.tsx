import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GateApp } from '../src/views/GateApp';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';
import '../src/shell/palette.css';
import '../src/graph/graph.css';
import '../src/servers/server.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE WORK TAB (revision 19, migration
 * 140), and the reason it exists: the deliverable is a claim about COLUMNS —
 * that landing on Work draws the three-panel workspace and NOTHING beside it,
 * no menu rail — and jsdom has no layout engine, so the vitest suite can prove
 * `isRaillessGroup` returns true and structurally cannot prove that the screen
 * a viewer lands on has three columns rather than four.
 *
 * That distinction is the whole feature. The group is railless BY SHAPE (one
 * childless `workspace` view item), so the failure mode being designed out is
 * silent: give the item caret children and every test above the shell still
 * passes while the tab quietly grows a fourth column. This harness is where
 * that is visible.
 *
 * Mounts the WHOLE SHELL — `GateApp`, the shipping component, with the
 * shipping stylesheets — over the fixture seam. `GateApp`'s `seam` prop is a
 * port, not a flag, so this is the same mount the browser gets; what the
 * fixture replaces is the network, not the shell. AuthGate is deliberately not
 * wrapped: it would gate the harness behind a sign-in the fixture seam has no
 * account for, and it renders nothing that this measures.
 *
 * `?ref=` picks the landing tab (default `workspace`), written the way the
 * shipping app writes it — `last-place.v1`, the same record `last-place.ts`
 * persists — so the harness exercises the real landing path rather than a
 * bespoke one.
 */
const params = new URLSearchParams(window.location.search);
const ref = params.get('ref') ?? 'workspace';

window.localStorage.setItem(
  'tm8.last-place.v1.local',
  JSON.stringify({ spaceId: 'sp-atelier', targets: { 'sp-atelier': { type: 'view', ref } } }),
);

function Harness() {
  const seam = useMemo(() => createFixtureSeam(), []);
  return <GateApp seam={seam} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
