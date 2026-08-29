import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail, EntityId, SpaceId } from '@tm8/contract';
import { browserWebSocketFactory, createRealSeam } from '../src/data';
import { attachmentsPortFromSeam } from '../src/files/port';
import { EntityDetailPanel, type DetailReasons } from '../src/panels';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';

/**
 * ATTACHMENTS, AGAINST A REAL NODE — the proof no unit test in this package can
 * produce.
 *
 * Every assertion the vitest suite makes about this feature is about SHAPE: a
 * component received a prop, a resolver produced a string, a fake seam recorded
 * a call. None of them can say that bytes went to a server, that a row was
 * written, that the `<img>` the strip renders actually decoded, or that the
 * link downloads the same file that went up. Those are the four things that
 * were broken in production while every unit test was green, so those are the
 * four things this harness exists to check in a browser.
 *
 * It mounts the SHIPPING panel over `createRealSeam` through vite's `/v2`
 * proxy, so the node it talks to is chosen with `TM8_SERVER_ORIGIN` and the
 * page stays same-origin (the node sends no CORS headers — see vite.config.ts).
 *
 * `?entity=` pins a subject; with none, the first entity the space answers with
 * is used, which is enough because `attached_to` places no restriction on the
 * anchor's kind.
 */
const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function Harness() {
  const seam = useMemo(
    () =>
      createRealSeam({
        baseUrl: '',
        origin: window.location.origin,
        fetch: globalThis.fetch.bind(globalThis),
        webSocketFactory: browserWebSocketFactory(WebSocket),
      }),
    [],
  );

  const [spaceId, setSpaceId] = useState<SpaceId | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const wanted = new URLSearchParams(window.location.search).get('entity');

  const load = useCallback(
    async (space: SpaceId, id: EntityId) => {
      setDetail(await seam.entity(id));
      setSpaceId(space);
    },
    [seam],
  );

  useEffect(() => {
    void (async () => {
      try {
        const spaces = await seam.spaces();
        const space = spaces[0];
        if (!space) throw new Error('the node answered zero spaces');
        const id = (wanted ??
          (await seam.query({ spaceId: space.id })).page.items[0]?.id) as EntityId | undefined;
        if (!id) throw new Error('the space answered zero entities');
        await load(space.id, id);
      } catch (error) {
        // Stated, never swallowed: a harness that renders an empty page on a
        // failed boot sends the test hunting through the component.
        setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [load, seam, wanted]);

  if (failure !== null) {
    return <div data-testid="harness-failed">{failure}</div>;
  }
  if (detail === null || spaceId === null) {
    return <div data-testid="harness-booting">booting…</div>;
  }

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      data-entity={detail.id}
      style={{ position: 'fixed', inset: 0, display: 'flex' }}
    >
      <div style={{ width: 520, height: '100%', display: 'flex' }}>
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={{ spaceId }}
          attachments={attachmentsPortFromSeam(seam, spaceId)}
          /* The one refetch both the upload and the detach ride: what changed
             is the anchor's edge set, and re-reading the anchor is how the
             strip learns about it. */
          onAttachmentUploaded={() => void load(spaceId, detail.id)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
