/**
 * Scratch harness for the STATUS STRIP (task 01a0dc78): the real GateApp over
 * the fixture seam, gate-free, at the product's own `.cv2-root` zoom (1.1 from
 * app.css). The fixture seam has no host read and no liveness counts, so this
 * wraps it with fixed ones — the point is layout (strip under the top bar, the
 * attention popover dropping over the content), not data.
 *
 * An automation tab usually reports `visibilityState: 'hidden'`, and the strip
 * correctly does not poll then. To see it fill in, run in the console:
 *   Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
 *   document.dispatchEvent(new Event('visibilitychange'));
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
import type { NodeMetricsView } from '@tm8/contract';
import { createFixtureSeam } from './data/fixtures/seam-fixture';
import type { Seam } from './data/seam';
import { GateApp } from './views/GateApp';

const GB = 1024 ** 3;
const base = createFixtureSeam();
const seam = Object.assign(Object.create(base) as Seam, {
  nodeMetrics: async (): Promise<NodeMetricsView> => ({
    sampledAt: new Date().toISOString(),
    cpu: { percent: 20 + Math.random() * 30, cores: 10 },
    memory: { totalBytes: 16 * GB, usedBytes: 12.9 * GB },
    loadAverage: [5.46, 7.93, 7.01],
    disk: { path: '/Users/me/.local/share/tm8', totalBytes: 926 * GB, usedBytes: 702 * GB },
    process: { rssBytes: 412 * 1024 ** 2, heapUsedBytes: 188 * 1024 ** 2, uptimeSeconds: 3725 },
    hostUptimeSeconds: 110_000,
  }),
  liveness: {
    ...base.liveness,
    refresh: async (spaceId: Parameters<Seam['liveness']['refresh']>[0]) => ({
      ...(await base.liveness.refresh(spaceId)),
      liveSessionCount: 3,
      liveChatCount: 2,
      workingChatCount: 1,
    }),
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GateApp seam={seam} />
  </React.StrictMode>,
);
