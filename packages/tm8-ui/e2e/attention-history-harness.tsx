import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId, SpaceId } from '@tm8/contract';
import { AttentionRequests } from '../src/attention/AttentionRequests';
import { attentionPortFromSeam } from '../src/attention/port';
import { browserWebSocketFactory, createRealSeam } from '../src/data';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

/**
 * A REAL-SERVER harness for the attention HISTORY section.
 *
 * The twin of `attention-harness.tsx`, and it exists for a sharper version of
 * the same reason. The fixture seam can now represent settled rows, but only
 * ones this repo invented; what a fixture can never prove is that the SERVER
 * hands back resolved and dismissed rows on an unfiltered
 * `attentionRequests.list`, with `resolvedBy` and `resolutionNote` populated
 * off real actors. That claim is the whole feature, and only a live node can
 * settle it.
 *
 * The section touches exactly two operations, both through `AttentionPort`:
 * `attentionRequests.list` and `attentionRequests.update`. Neither needs an
 * open space, so no hydration and no gate is involved.
 *
 * Rendered inside `.cv2-root` and a `.pn-body`, because every selector in
 * `attention.css` is scoped to the former and the section's own spacing comes
 * from the latter's `pn-section` rule. Mounting it bare would prove the markup
 * and lie about the layout.
 *
 *   /e2e/attention-history-harness.html?entityId=<uuid>&spaceId=<uuid>
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const spaceId = (params.get('spaceId') ?? '') as SpaceId;
  const entityId = (params.get('entityId') ?? '') as EntityId;
  // SAME-ORIGIN by default: tm8-server sends no CORS headers, so the dev proxy
  // is the only way in. An absolute `api` is refused by the browser, not the
  // server.
  const api = params.get('api') ?? '';

  const seam = useMemo(() => createRealSeam({
    baseUrl: api,
    // A relative baseUrl carries no host, so the ws url cannot be derived
    // without being told the origin explicitly.
    origin: window.location.origin,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init),
    webSocketFactory: browserWebSocketFactory,
  }), [api]);

  const port = useMemo(() => attentionPortFromSeam(seam, spaceId), [seam, spaceId]);

  if (!spaceId || !entityId) {
    return <div data-testid="harness-error">pass ?spaceId=&lt;uuid&gt;&amp;entityId=&lt;uuid&gt;</div>;
  }

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--pn-paper)' }}
    >
      <div className="pn-body" style={{ maxWidth: 620, margin: '0 auto', padding: 24 }}>
        <AttentionRequests
          entityId={entityId}
          port={port}
          onSettled={() => {
            // The host's job in the real app is to refetch the entity so the
            // badge catches up. Here we only record that it was asked.
            (window as unknown as { __settled?: number }).__settled =
              ((window as unknown as { __settled?: number }).__settled ?? 0) + 1;
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
