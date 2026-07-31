import { useCallback, useRef, useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import type { DocBlock } from './blocks';
import { DocPreview } from './DocPreview';
import { DocSource } from './DocSource';
import { ConflictBanner, RefusalHost, SaveActions, SaveWord } from './EditorChrome';
import type { DocSaveHandle } from './useDocSave';

/**
 * T5-3 FRAME 2a — THE Z4 SPLIT: source left, live preview right, a draggable
 * hairline between them (oracle lines 143-170).
 *
 * IT TAKES THE SAME `DocSaveHandle` AS THE Z3 EDITOR, and that is the design
 * rather than a convenience: "⤢ promotes the same editing session … draft
 * intact" (line 171). One draft, one base version, one save — a second hook
 * here would be a second draft, and promoting would silently fork the user's
 * text into two versions of itself.
 *
 * NO STANCE TOGGLE, because the split IS both stances at once. Annotation 2:
 * "One editor, two stances, chosen by geometry — not preference."
 */
export function DocSplitView({
  save,
  detail,
  onCollapse,
  collapseRefusal,
  onOpenBlock,
  conflictActor,
}: {
  save: DocSaveHandle;
  detail: EntityDetail;
  /** ⇲ — back to the panel. Absent ⇒ disabled-with-reason, never hidden. */
  onCollapse?: () => void;
  /**
   * Why collapse is refused, when the HOST is the one refusing it.
   *
   * Without this the absent-`onCollapse` branch could only say "this view was
   * mounted without a collapse dispatch" — true when nobody wired it, and a
   * LIE when the real reason is an unsaved draft. A host that withholds
   * `onCollapse` for a reason of its own supplies that reason here, so the
   * control states the actual cause rather than the structural one.
   */
  collapseRefusal?: { cause: string; remedy: string };
  onOpenBlock?: (block: DocBlock) => void;
  conflictActor?: string | null;
}) {
  const { ratio, onKeyDown, onPointerDown, frame } = useSplitRatio();

  return (
    <div className="de-split" data-testid="doc-split">
      <div className="de-bar">
        {onCollapse ? (
          <button type="button" className="de-btn de-btn--quiet" data-testid="doc-collapse" onClick={onCollapse}>
            ⇲ collapse
          </button>
        ) : (
          <DisabledIconControl
            label="Collapse back to the panel"
            reason={collapseRefusal ?? {
              cause: 'Collapse isn’t connected here',
              remedy: 'this view was mounted without a collapse dispatch',
            }}
          >
            ⇲ collapse
          </DisabledIconControl>
        )}
        <span className="de-bar__title">{detail.title} · full view</span>
        <span className="de-bar__spacer" />
        <SaveActions save={save} />
      </div>

      <ConflictBanner save={save} actor={conflictActor} />

      <div className="de-split__panes" ref={frame}>
        <div className="de-split__pane" style={{ flexGrow: ratio }}>
          <DocSource save={save} onOpenBlock={onOpenBlock} label="Document source (split view)" />
        </div>
        {/*
         * A REAL SEPARATOR, not a decorative 1px div. The oracle draws a grab
         * handle (line 161); a pointer-only handle is unreachable for anyone
         * not using a mouse, so it carries the separator role, a tab stop and
         * arrow keys. `aria-valuenow` is the split percentage, which is also
         * the only honest way to expose where the boundary sits.
         */}
        <div
          className="de-split__bar"
          data-testid="doc-splitter"
          role="separator"
          tabIndex={0}
          aria-label="Resize the source and preview panes"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(ratio * 100)}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
        >
          <span className="de-split__grip" aria-hidden />
        </div>
        <div className="de-split__pane de-split__pane--preview" style={{ flexGrow: 1 - ratio }}>
          <DocPreview source={save.body} />
        </div>
      </div>

      <RefusalHost save={save} />

      <div className="de-foot">
        <SaveWord save={save} version={detail.version} />
        <span className="de-foot__spacer" />
        {/*
         * THE ORACLE'S FOOTER PROMISES THREE THINGS (line 169) AND WE KEEP ONE.
         * "split remembers its ratio per doc" needs storage this package has
         * measured as broken under its own runner, and "preview tracks the
         * caret" needs a scroll-sync nobody built. Rather than print the
         * canvas's sentence and mean none of it, the footer states what is
         * actually true here. GAP G7.
         */}
        <span className="de-foot__hint">ratio resets when this view closes · esc cancels · ⌘enter saves</span>
      </div>
    </div>
  );
}

const MIN = 0.2;
const MAX = 0.8;
const STEP = 0.04;

/**
 * The split ratio, IN MEMORY ONLY.
 *
 * The oracle says "split remembers its ratio per doc". Persisting it wants
 * `localStorage`, which `vite.config.ts` records as measured-broken under this
 * package's test runner (an object with no `setItem`). Shipping a persistence
 * path that silently no-ops in every test is worse than not shipping one, so
 * this holds the ratio for the life of the view and the footer says so.
 */
function useSplitRatio() {
  const [ratio, setRatio] = useState(0.5);
  const frame = useRef<HTMLDivElement | null>(null);

  const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRatio((r) => clamp(r - STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setRatio((r) => clamp(r + STEP));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setRatio(0.5);
    }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => setRatio(clamp((ev.clientX - box.left) / box.width));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return { ratio, onKeyDown, onPointerDown, frame };
}
