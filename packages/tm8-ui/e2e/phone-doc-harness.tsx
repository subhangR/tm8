import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GateApp } from '../src/views/GateApp';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import { docLayoutSpec, fixtureDetails } from '../src/fixtures';
import { SHELL_OVERRIDE_KEY } from '../src/mobile';
import { installActiveStyle } from '../src/theme/style-store';
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
 * THE WHOLE APP ON THE PHONE SHELL, over the fixture seam — `work-tab-harness`
 * with the shell pinned to mobile. For checking a phone screen (the doc page,
 * a deep link) at a phone viewport with no node and no sign-in. AuthGate is
 * not wrapped for the same reason as there.
 *
 * The address is the app's own: a hash route, or a path link such as
 * `/e/{id}`, which the router respells on boot. `?last=` seeds last-place, so
 * a path link can be shown NOT to land there. `?doc=` names a JSON file
 * `{ title, body }` served beside the harness, which replaces the fixture
 * doc's (`doc-layout-spec`) title and markdown — a real document's text, read
 * on the phone with no node.
 */
const params = new URLSearchParams(window.location.search);
window.localStorage.setItem(SHELL_OVERRIDE_KEY, 'mobile');
window.localStorage.setItem(
  'tm8.last-place.v1.local',
  JSON.stringify({ spaceId: 'sp-atelier', targets: { 'sp-atelier': { type: 'kind', ref: params.get('last') ?? 'task' } } }),
);
installActiveStyle();

function Harness() {
  const seam = useMemo(() => createFixtureSeam(), []);
  return <GateApp seam={seam} />;
}

async function withDoc(): Promise<void> {
  const url = params.get('doc');
  if (!url) return;
  const doc = (await (await fetch(url)).json()) as { title: string; body: string };
  const detail = fixtureDetails[docLayoutSpec.id]!;
  (docLayoutSpec as { title: string }).title = doc.title;
  (detail as { title: string }).title = doc.title;
  (detail.content as unknown as { body: string }).body = doc.body;
}

void withDoc().then(() => createRoot(document.getElementById('root')!).render(<Harness />));
