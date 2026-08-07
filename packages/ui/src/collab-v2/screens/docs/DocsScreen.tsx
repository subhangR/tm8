/**
 * Docs screen (L5) — chapter tree + the Z4 reader, composed.
 *
 * Nothing here renders a doc: the sidebar is a `CollectionView` in tree layout
 * over the doc kind, the reader is `EntityFullView` (whose registry-selected
 * `reader` layout IS the serif chapter/prose/margin grid), and the margin
 * threads are the Thread subsystem's `discussionSlot()` anchored on whichever
 * doc is selected. The screen owns exactly three things the composition can't:
 * which doc is selected, the version-history disclosure, and the
 * split-to-child-doc command.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { CollectionView } from '../../collections';
import { EntityFullView } from '../../entity';
import { discussionSlot } from '../../subsystems/thread';
import type { ShellViewProps } from '../../shell';
import type { EntityId } from '../../types/contract';
import { defaultDocId, useDocs, useDocVersions } from './useDocs';
import { VersionHistory } from './VersionHistory';

const NEW_CHAPTER_TITLE = 'Untitled chapter';

/** Margin rail of the reader = the doc's anchored discussion (W2 Thread). */
const MARGIN_SLOT = discussionSlot({ variant: 'comments', defaultExpanded: 'all' });

export function DocsScreen({ facade, spaceId, entityId, onOpenEntity }: ShellViewProps) {
  const [nonce, bumpTree] = useReducer((n: number) => n + 1, 0);
  const docs = useDocs(facade, spaceId, nonce);
  const items = useMemo(() => docs.value?.page.items ?? [], [docs.value]);

  const [picked, setPicked] = useState<EntityId | null>(entityId);
  useEffect(() => { if (entityId) setPicked(entityId); }, [entityId]);
  const selected = picked ?? defaultDocId(items);
  const selectedDoc = items.find((d) => d.id === selected) ?? null;

  const [historyOpen, setHistoryOpen] = useState(false);
  const versions = useDocVersions(facade, historyOpen ? selected : null, selectedDoc?.version ?? null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * "Split to child docs": the reader's way of growing a chapter tree — a new
   * doc parented to the one you are reading, and the selection moves to it.
   */
  const split = useCallback(async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await facade.createEntity({
        spaceId,
        kind: 'doc',
        title: NEW_CHAPTER_TITLE,
        parentId: selected,
        content: { body: `## ${NEW_CHAPTER_TITLE}\n\n`, format: 'markdown' },
      });
      const created = result.entity?.id ?? result.patches[0]?.id ?? null;
      if (created) setPicked(created);
      bumpTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [facade, spaceId, selected, busy]);

  return (
    <div className="cv2-docs" data-testid="docs-screen">
      <aside className="cv2-docs__rail" aria-label="Chapter tree">
        <header className="cv2-docs__railhead">
          <span className="cv2-docs__glyph" aria-hidden="true">📄</span>
          <span className="t-title">Docs</span>
        </header>
        <div className="cv2-docs__tree">
          <CollectionView
            key={`docs-tree-${nonce}`}
            query={{ spaceId, kinds: ['doc'], sort: 'position', limit: 200 }}
            layout="tree"
            showControls={false}
            onOpenEntity={(id) => setPicked(id)}
          />
        </div>
      </aside>

      <section className="cv2-docs__reader" aria-label="Reader">
        <div className="cv2-docs__toolbar">
          <span className="t-mono cv2-docs__toolbarmeta">
            {selectedDoc ? `v${selectedDoc.version}` : '—'}
          </span>
          <span className="cv2-docs__toolbarspace" />
          <button
            type="button"
            className="cv2-actionbtn"
            aria-pressed={historyOpen}
            disabled={!selected}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            ⟲ History
          </button>
          <button
            type="button"
            className="cv2-actionbtn cv2-actionbtn--primary"
            title="Create a child doc under this one and open it"
            disabled={!selected || busy}
            onClick={() => void split()}
          >
            ⑃ Split to child doc
          </button>
          <button
            type="button"
            className="cv2-actionbtn"
            title="Open this doc as a panel"
            disabled={!selected}
            onClick={() => { if (selected) onOpenEntity(selected); }}
          >
            ⤡ As panel
          </button>
        </div>

        {error && <div className="cv2-board__banner" role="alert">{error}</div>}

        {historyOpen && (
          <VersionHistory
            rows={versions.value?.items ?? []}
            loading={versions.loading}
            error={versions.error}
            current={selectedDoc?.version ?? 0}
          />
        )}

        {selected ? (
          <EntityFullView
            key={selected}
            entityId={selected}
            slots={{ margin: MARGIN_SLOT }}
            onCollapse={() => onOpenEntity(selected)}
          />
        ) : (
          <div className="cv2-collection__empty" role="status">
            <div className="cv2-collection__emptyglyph" aria-hidden="true">◇</div>
            <p>No docs in this space yet — create one from the palette.</p>
          </div>
        )}
      </section>
    </div>
  );
}
