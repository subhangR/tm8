/**
 * ThreadGallery — the Thread driving itself, standalone, against the mock.
 *
 * Four panes, one component: the #v2-build channel feed, T-104's comment
 * thread, the spec doc's margin notes, and Subhang's member wall. Nothing is
 * configured per pane except the anchor id and the variant — which is the
 * whole claim of Layer 2.1, made visible.
 *
 * Self-wrapping (like `gallery/Gallery`), so mounting it anywhere is one tag.
 */
import { useMemo } from 'react';
import { PopoverProvider } from '../../kit';
import { CollabFacadeProvider } from '../../entity';
import { createSeededFacade, type MockFacade } from '../../mock';
import { connectStores } from '../../stores';
import { Thread } from './Thread';
import type { ThreadVariant } from './types';

export interface ThreadGalleryProps {
  /** Reuse an existing facade (the app's); a seeded one is made otherwise. */
  facade?: MockFacade;
}

interface Pane { title: string; note: string; anchorId: string; variant: ThreadVariant }

export function ThreadGallery({ facade: facadeProp }: ThreadGalleryProps) {
  const facade = useMemo(() => facadeProp ?? createSeededFacade(), [facadeProp]);
  const panes: Pane[] = useMemo(() => {
    const ids = facade.ids;
    return [
      { title: 'Channel feed', note: '#v2-build — embeds, an agent report, an unread line', anchorId: ids.chBuild, variant: 'feed' },
      { title: 'Task comments', note: 'T-104 — a two-deep reply subtree with a mention', anchorId: ids.t104, variant: 'comments' },
      { title: 'Doc margin thread', note: 'the V2 spec — review notes beside the text', anchorId: ids.docSpec, variant: 'comments' },
      { title: 'Member wall', note: "Subhang's profile — the same component again", anchorId: ids.subhang, variant: 'comments' },
    ];
  }, [facade]);

  // One subscription for the page; every Thread reads the same stores.
  useMemo(() => connectStores(facade, facade.ids.space), [facade]);

  return (
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>
        <div className="cv2-threadgallery">
          {panes.map((p) => (
            <section key={p.anchorId} className="cv2-threadgallery__pane">
              <header className="cv2-threadgallery__head">
                <span className="cv2-eyebrow">{p.title}</span>
                <span className="cv2-threadgallery__note">{p.note}</span>
              </header>
              <Thread anchorId={p.anchorId} variant={p.variant} live={false} markReadOnView={false} />
            </section>
          ))}
        </div>
      </PopoverProvider>
    </CollabFacadeProvider>
  );
}
