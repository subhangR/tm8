import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import { GateApp } from '../src/views/GateApp';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../src/data/fixtures/seam-fixture';

const seam = createFixtureSeam();
const identity = seam.identity.bind(seam);
const params = new URLSearchParams(location.search);
const nodeRole = params.get('node') ?? 'owner';
const spaceRole = params.get('space') ?? 'owner';
seam.identity = async () => ({
  ...await identity(),
  isNodeAdmin: nodeRole === 'admin',
  isOwner: nodeRole === 'owner',
  memberships: (await identity()).memberships.map(m => ({ ...m, role: spaceRole })),
});
if (!location.hash) location.hash = `#/s/${FIXTURE_SPACE_ID}/settings`;
createRoot(document.getElementById('root')!).render(<GateApp seam={seam} />);
