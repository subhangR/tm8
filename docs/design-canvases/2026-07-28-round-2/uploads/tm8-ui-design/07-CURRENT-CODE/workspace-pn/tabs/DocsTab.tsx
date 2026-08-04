/**
 * Docs tab — list, read, edit, create. FULLY FUNCTIONAL against today's node.
 *
 * This surface was scoped as "probably blocked" and it is not: `entities.create`
 * and `entities.patch` both support `kind:'doc'` (they route to the
 * `create_document` / `update_document` RPCs), and `collections.query` lists
 * them. So nothing here degrades — every affordance on this tab is real, and
 * that is worth stating because the rest of the panel has to caption absences.
 *
 * OPTIMISTIC CONCURRENCY IS NOT OPTIONAL HERE. `entities.patch` requires
 * `expectedVersion`, and the version travels with the doc we READ. If the doc
 * changed underneath us the server rejects with a version conflict rather than
 * silently overwriting someone else's edit — so the save path surfaces that
 * refusal instead of retrying through it.
 */
import { useEffect, useState } from 'react';
import type { EntityDetail, EntitySummary } from '../../../collab-v2/types/contract';
import type { RealFacade } from '../../RealFacade';
import { docsQuery, isDrawing } from '../queries';
import { LIST_POLL_MS } from '../useSessions';
import { usePolledCollection } from '../usePolledCollection';

/** `documents.body` is `check (char_length(body) <= 200000)` — enforce it before the round trip. */
export const DOC_BODY_MAX = 200_000;

export interface DocsTabProps {
  facade: RealFacade;
  spaceId: string;
}

function docBody(detail: EntityDetail | null): string {
  const content = detail?.content as unknown as { body?: string } | undefined;
  return content?.body ?? '';
}

/** The open document: read its body, edit it, save it back. */
function DocEditor({ facade, doc, onClose, onSaved }: {
  facade: RealFacade; doc: EntitySummary; onClose: () => void; onSaved: () => void;
}) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    setSaved(false);
    facade.getEntity(doc.id).then(
      (d) => { if (alive) { setDetail(d); setBody(docBody(d)); } },
      (err: unknown) => { if (alive) setError(String((err as Error)?.message ?? err)); },
    );
    return () => { alive = false; };
  }, [facade, doc.id]);

  const tooLong = body.length > DOC_BODY_MAX;

  const save = async () => {
    if (!detail || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await facade.patchEntity(doc.id, {
        expectedVersion: detail.version,
        content: { body },
      } as Parameters<RealFacade['patchEntity']>[1]);
      setSaved(true);
      // Re-read rather than bumping the version locally: the server owns the
      // new version, and guessing it would make the NEXT save fail with a
      // conflict against our own write.
      const fresh = await facade.getEntity(doc.id);
      setDetail(fresh);
      setBody(docBody(fresh));
      onSaved();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-res__editor" data-testid="doc-editor" data-doc={doc.id}>
      <div className="ws-res__panehead">
        <button type="button" className="tm8-sess__btn" onClick={onClose}>← All docs</button>
        <span className="ws-res__editortitle">{doc.title || 'Untitled'}</span>
      </div>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}

      {detail === null && !error && <p className="cv2-empty-line">Loading…</p>}

      {detail !== null && (
        <>
          <textarea
            className="ws-res__textarea"
            value={body}
            onChange={(e) => { setBody(e.target.value); setSaved(false); }}
            aria-label={`Body of ${doc.title || 'document'}`}
            spellCheck={false}
          />
          <div className="ws-res__editorfoot">
            {/* The cap is surfaced BEFORE the request: letting Postgres reject a
                200 KB write turns a knowable limit into an opaque 500. */}
            <span className={tooLong ? 'ws-res__over' : 't-mono ws-res__count'}>
              {body.length.toLocaleString()} / {DOC_BODY_MAX.toLocaleString()}
            </span>
            <span className="tm8-sess__spacer" />
            {saved && !busy && <span className="ws-res__saved">saved</span>}
            <button
              type="button"
              className="tm8-sess__btn"
              onClick={() => void save()}
              disabled={busy || tooLong}
              title={tooLong ? `Body exceeds the ${DOC_BODY_MAX.toLocaleString()}-character limit` : undefined}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function DocsTab({ facade, spaceId }: DocsTabProps) {
  // The SAME query the Drawings tab uses — one poll, split by format, so the
  // two tabs can never disagree about which documents exist.
  const { items, error, reload } = usePolledCollection(facade, docsQuery(spaceId), LIST_POLL_MS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const docs = (items ?? []).filter((d) => !isDrawing(d));
  const open = openId ? docs.find((d) => d.id === openId) ?? null : null;

  // A doc that disappears from the list while open (deleted elsewhere, or
  // filtered out) must not leave the editor pointed at nothing.
  useEffect(() => {
    if (openId && items !== null && !items.some((d) => d.id === openId)) setOpenId(null);
  }, [openId, items]);

  const create = async () => {
    const name = title.trim();
    if (!name) return;
    setBusy(true);
    setCreateError(null);
    try {
      await facade.createEntity({
        spaceId, kind: 'doc', title: name, content: { body: '', format: 'markdown' },
      });
      setTitle('');
      reload();
    } catch (err) {
      setCreateError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return <DocEditor facade={facade} doc={open} onClose={() => setOpenId(null)} onSaved={reload} />;
  }

  return (
    <div className="ws-res__pane" data-testid="tab-docs">
      <div className="ws-res__panehead">
        <span className="cv2-eyebrow">docs</span>
        <span className="tm8-sess__spacer" />
        <button type="button" className="tm8-sess__btn" onClick={reload}>Refresh</button>
      </div>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}

      {items === null && !error && <p className="cv2-empty-line">Loading docs…</p>}

      {items !== null && docs.length === 0 && (
        <p className="cv2-empty-line">No documents yet.</p>
      )}

      {docs.length > 0 && (
        <section className="tm8-sess__group">
          {docs.map((d) => (
            <button
              key={d.id}
              type="button"
              className="tm8-sessrow ws-res__row"
              data-doc={d.id}
              onClick={() => setOpenId(d.id)}
            >
              <span className="tm8-sessrow__title">{d.title || 'Untitled'}</span>
              <span className="tm8-sessrow__meta t-mono">{d.excerpt ? '' : 'empty'}</span>
            </button>
          ))}
        </section>
      )}

      <form className="ws-res__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input
          className="ws-res__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New document title"
          aria-label="New document title"
          disabled={busy}
        />
        <button type="submit" className="tm8-sess__btn" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>

      {createError && <pre className="tm8-sess__error" role="alert">{createError}</pre>}
    </div>
  );
}
