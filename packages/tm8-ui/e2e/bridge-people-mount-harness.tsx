// The real bridge panel (BridgePageBlock, #1445) with lane P's roster (#1439)
// and B3's Invite (#1468) mounted on the People tab (task 01a18bff-1231), on
// fixtures. ?theme=dark for the dark check.
import { createRoot } from 'react-dom/client';
import type { CommandResult, EntityDetail, SpaceInviteView } from '@tm8/contract';
import { BridgePageBlock } from '../src/bridges/BridgePage';
import type { BridgesPort } from '../src/bridges/api';
import { createFixtureBridgesClient, fixtureBridgeViewOf } from '../src/bridges/fixture';
import { fixturePort } from '../src/bridges/people/fixtures';
import { bridgeDeploys, bridgeInfra, bridgeRahul } from '../src/fixtures/entities';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

const views = [bridgeInfra, bridgeDeploys, bridgeRahul].map((row) => fixtureBridgeViewOf(row)!);
const client = createFixtureBridgesClient(views);
const ok = { patches: [] } as unknown as CommandResult;
const port: BridgesPort = {
  ...client,
  targets: async () => [],
  memories: async () => [],
  memoryCandidates: async () => [],
  linkMemory: async () => ok,
  unlinkMemory: async () => ok,
  serves: () => true,
  people: fixturePort({ delayMs: 120 }),
  createInvite: async (spaceId, input) => ({
    id: 'inv-1', spaceId, code: 'K7Q2-PX9M', role: input.role ?? 'member', maxUses: 1, useCount: 0,
    expiresAt: null, revokedAt: null, createdAt: new Date().toISOString(),
  }) as unknown as SpaceInviteView,
};
const theme = new URLSearchParams(location.search).get('theme') ?? 'light';
const detail = { id: bridgeInfra.id, version: 1, kind: 'bridge' } as unknown as EntityDetail;

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" data-theme={theme} style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--pn-surface)' }}>
    <div className="pn-panel" style={{ maxWidth: 900, margin: '12px auto', background: 'var(--pn-card)' }}>
      <BridgePageBlock detail={detail} port={port} onOpenEntity={(id) => { document.title = `open ${id}`; }} />
    </div>
  </div>,
);
