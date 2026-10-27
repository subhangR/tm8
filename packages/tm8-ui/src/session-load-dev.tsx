/**
 * Scratch harness for TAB LOADING STATES (task 01a14c39): the real GateApp over
 * the fixture seam, with `seam.entity` HELD for every id until released, so a
 * tab's loading frame can be looked at instead of flashing past. jsdom paints
 * nothing, so whether a session tab's skeleton sits in the same dark scope as
 * its loaded panel can only be checked in a browser.
 *
 * Usage: /session-load-dev.html?kind=work_session
 *   `kind`  — the kind whose first fixture row is opened as a tab (default work_session).
 *   The app theme follows the OS until chosen: emulate `prefers-color-scheme`.
 *   In the console, `__release()` lets the held reads answer (the loaded frame).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import './terminal/terminal.css';
import './shell/palette.css';
import { createFixtureSeam, FIXTURE_SPACE_ID } from './data/fixtures/seam-fixture';
import type { Seam } from './data/seam';
import { GateApp } from './views/GateApp';

const params = new URLSearchParams(location.search);
const kind = params.get('kind') ?? 'work_session';

let held = true;
const waiting: Array<() => void> = [];
(window as unknown as { __release(): void }).__release = () => {
  held = false;
  waiting.splice(0).forEach((go) => go());
};

const base = createFixtureSeam();
/* A spread, not `Object.create`: bodies spread the seam, which drops inherited methods. */
const seam: Seam = {
  ...base,
  entity: (id) => (held ? new Promise<void>((go) => waiting.push(go)).then(() => base.entity(id)) : base.entity(id)),
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GateApp seam={seam} />
  </React.StrictMode>,
);

/* The kind's first row, for the driver to open through the start surface's
   search (its read is then the held one). */
setTimeout(() => {
  void base.query({ spaceId: FIXTURE_SPACE_ID, kinds: [kind] } as Parameters<Seam['query']>[0]).then((result) => {
    const first = result.page.items[0];
    (window as unknown as { __first: unknown }).__first = first ? { id: first.id, title: first.title } : null;
  });
}, 0);
