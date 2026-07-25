/**
 * Drawings tab — list and read. The EDITOR is deliberately deferred (CTO ruling).
 *
 * WHAT IS REAL HERE. A drawing is not a new concept on this node: it is a `doc`
 * whose `format` is `excalidraw` and whose `body` holds the scene JSON. That is
 * byte-identical to how old maestro persisted one (an Excalidraw
 * `serializeAsJSON` blob stored as a doc), so these rows are genuine drawings,
 * fully round-trippable, with no server work behind them.
 *
 * WHY THERE IS NO CANVAS. Mounting an editor means taking
 * `@excalidraw/excalidraw` — a heavy dependency in a package that deliberately
 * declines even `@xterm/addon-fit` to avoid moving `bun.lock`. The ruling was to
 * ship list+read now and decide the editor separately.
 *
 * So this tab shows what it can PROVE from the stored scene — how many elements
 * it has, and the scene source — and says plainly that editing is not wired yet.
 * It does not draw a placeholder rectangle that implies a preview, and it does
 * not hide the tab: a hidden tab reads as "this product has no drawings", which
 * is false, while a captioned one reads as "not built here yet", which is true.
 */
import { useEffect, useState } from 'react';
import type { EntityDetail, EntitySummary } from '../../../collab-v2/types/contract';
import type { RealFacade } from '../../RealFacade';
import { docsQuery, isDrawing } from '../queries';
import { LIST_POLL_MS } from '../useSessions';
import { usePolledCollection } from '../usePolledCollection';

export interface DrawingsTabProps {
  facade: RealFacade;
  spaceId: string;
}

/**
 * How many elements the stored scene holds, or null when the body is not a
 * scene we can read.
 *
 * Returning null rather than 0 on a parse failure is the point: "0 elements" is
 * a claim about an empty drawing, and a corrupt or foreign body is a different
 * statement entirely. The caller renders them differently.
 */
export function sceneElementCount(body: string): number | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as { elements?: unknown };
    return Array.isArray(parsed.elements) ? parsed.elements.length : null;
  } catch {
    return null;
  }
}

function DrawingViewer({ facade, drawing, onClose }: {
  facade: RealFacade; drawing: EntitySummary; onClose: () => void;
}) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    facade.getEntity(drawing.id).then(
      (d) => { if (alive) setDetail(d); },
      (err: unknown) => { if (alive) setError(String((err as Error)?.message ?? err)); },
    );
    return () => { alive = false; };
  }, [facade, drawing.id]);

  const body = ((detail?.content as unknown as { body?: string } | undefined)?.body) ?? '';
  const count = detail ? sceneElementCount(body) : null;

  return (
    <div className="ws-res__editor" data-testid="drawing-viewer" data-doc={drawing.id}>
      <div className="ws-res__panehead">
        <button type="button" className="tm8-sess__btn" onClick={onClose}>← All drawings</button>
        <span className="ws-res__editortitle">{drawing.title || 'Untitled'}</span>
      </div>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}
      {detail === null && !error && <p className="cv2-empty-line">Loading…</p>}

      {detail !== null && (
        <>
          <p className="ws-res__note">
            {count === null
              ? 'This scene could not be read as Excalidraw JSON.'
              : `Excalidraw scene · ${count} element${count === 1 ? '' : 's'}.`}{' '}
            Viewing the source only — the drawing editor is not wired on this node yet.
          </p>
          {/* read-only, and marked so: the body is a real scene and editing it
              as text would be a way to corrupt a drawing silently. */}
          <textarea
            className="ws-res__textarea ws-res__textarea--ro"
            value={body}
            readOnly
            aria-label={`Scene source of ${drawing.title || 'drawing'}`}
            spellCheck={false}
          />
        </>
      )}
    </div>
  );
}

export function DrawingsTab({ facade, spaceId }: DrawingsTabProps) {
  // The SAME query the Docs tab uses — shared subscription, one poll.
  const { items, error, reload } = usePolledCollection(facade, docsQuery(spaceId), LIST_POLL_MS);
  const [openId, setOpenId] = useState<string | null>(null);

  const drawings = (items ?? []).filter(isDrawing);
  const open = openId ? drawings.find((d) => d.id === openId) ?? null : null;

  useEffect(() => {
    if (openId && items !== null && !items.some((d) => d.id === openId)) setOpenId(null);
  }, [openId, items]);

  if (open) {
    return <DrawingViewer facade={facade} drawing={open} onClose={() => setOpenId(null)} />;
  }

  return (
    <div className="ws-res__pane" data-testid="tab-drawings">
      <div className="ws-res__panehead">
        <span className="cv2-eyebrow">drawings</span>
        <span className="tm8-sess__spacer" />
        <button type="button" className="tm8-sess__btn" onClick={reload}>Refresh</button>
      </div>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}

      {items === null && !error && <p className="cv2-empty-line">Loading drawings…</p>}

      {items !== null && drawings.length === 0 && (
        <p className="cv2-empty-line">
          No drawings yet. A drawing is a document stored in Excalidraw format —
          agents can create one; the in-app editor is not wired yet.
        </p>
      )}

      {drawings.length > 0 && (
        <section className="tm8-sess__group">
          {drawings.map((d) => (
            <button
              key={d.id}
              type="button"
              className="tm8-sessrow ws-res__row"
              data-doc={d.id}
              onClick={() => setOpenId(d.id)}
            >
              <span className="tm8-sessrow__title">{d.title || 'Untitled'}</span>
              <span className="tm8-sessrow__meta t-mono">excalidraw</span>
            </button>
          ))}
        </section>
      )}

      {/*
        Stated once, at the foot, rather than on every row. Creating is genuinely
        possible over the API — it is only the CANVAS that is missing — so the
        caption names the missing piece precisely instead of implying the whole
        feature is absent.
      */}
      <p className="ws-res__note">
        Read-only: drawings round-trip through the graph, but the Excalidraw
        canvas is a deferred dependency on this build.
      </p>
    </div>
  );
}
