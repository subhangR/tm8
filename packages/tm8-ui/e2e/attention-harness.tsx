import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId, SpaceId } from '@tm8/contract';
import { AttentionInbox } from '../src/attention/AttentionInbox';
import { browserWebSocketFactory, createRealSeam } from '../src/data';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

/**
 * A REAL-SERVER harness for the attention inbox.
 *
 * The fixture seam can only ever synthesize attention rows from a badge the
 * fixture dataset does not carry, so mounting this over fixtures proves the
 * empty state and nothing else. What needs proving is the path the feature
 * actually runs on: HTTP → `attentionRequests.list` → rows for MANY entities →
 * grouped to one row each → laid out by the real stylesheet.
 *
 * So this builds the REAL seam against a running node. `AttentionInbox` touches
 * exactly two seam methods (`attentionRequests`, `entity`), neither of which
 * needs an open space, so no hydration or gate is involved.
 *
 * `nameOf` deliberately returns undefined for everything: with no store to
 * consult, every row must take the hydrate-over-the-wire path, which is the
 * branch a fixture test cannot reach.
 *
 *   /e2e/attention-harness.html?spaceId=<uuid>&api=http://127.0.0.1:4610
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const spaceId = (params.get('spaceId') ?? '') as SpaceId;
  // SAME-ORIGIN by default: tm8-server sends no CORS headers (vite.config.ts),
  // so the dev proxy is the only way in. An absolute `api` will be refused by
  // the browser, not by the server.
  const api = params.get('api') ?? '';

  const seam = useMemo(() => createRealSeam({
    baseUrl: api,
    // A relative baseUrl carries no host, so the ws url cannot be derived
    // without being told the origin explicitly.
    origin: window.location.origin,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init),
    webSocketFactory: browserWebSocketFactory,
  }), [api]);

  if (!spaceId) return <div data-testid="harness-error">pass ?spaceId=&lt;uuid&gt;</div>;

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ position: 'fixed', inset: 0, background: 'var(--pn-paper)' }}
    >
      <AttentionInbox
        seam={seam}
        spaceId={spaceId}
        nameOf={() => undefined}
        onOpenEntity={(id: EntityId) => {
          // Navigation is the app's job; the harness only records that the row
          // asked for it, so a Playwright run can assert the click target.
          (window as unknown as { __opened?: string }).__opened = id;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
