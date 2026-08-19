import { useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import type { MarkdownFileHref } from '../kit';
import type { DocBlock } from './blocks';
import { DocPreview } from './DocPreview';
import { DocSource, type DocAttach } from './DocSource';
import type { TriggerOption } from '../rich-input';
import {
  ConflictBanner,
  RefusalHost,
  SaveActions,
  SaveWord,
  StanceToggle,
  type DocStance,
} from './EditorChrome';
import type { DocSaveHandle } from './useDocSave';
import './doc-edit-phone.css';

/**
 * T5-3 FRAME 1b — "edit" — THE Z3 EDIT SURFACE.
 *
 * Top to bottom, exactly the regions the oracle's edit panel draws (lines
 * 68-118), minus the ones that are SHARED CHROME and belong to the panel rather
 * than to this body:
 *
 *   [chrome]         breadcrumb · title · v-pill · "editing" pill · ⋯ ✕
 *   [chrome]         the panel tab strip
 *   action bar       Write|Preview · (spacer) · Cancel · Save v4    ← here
 *   conflict banner  only in a conflict                             ← here
 *   body             mono source, or the preview                    ← here
 *   footer           save word · esc cancels · ⌘enter saves         ← here
 *
 * WHAT IS DELIBERATELY NOT DRAWN HERE, and where it lives instead:
 *   · the "editing" pill — chrome's header (line 74). `authoring/SaveControls`
 *     already renders exactly that pill for the header's `actions` slot.
 *   · ⤢ / ⇲ — the promote-and-collapse pair is drawn in the PANEL HEADER (read
 *     panel line 38, split header line 145), not inside the content region. The
 *     handover tells the host to route its ⤢ to a `DocSplitView` mount; drawing
 *     a second one in here would be two controls for one gesture.
 *   · "N readers now" — the READ footer's, not the edit footer's (line 63 vs
 *     113). It has no seam source either way; reported as GAP G1 against chrome.
 *
 * D63 retired the standalone action row in favour of an inline header bar for
 * the panel's own verbs. THIS bar is not that one: it is the editor's own
 * stance-and-commit row, which the oracle draws INSIDE the content region and
 * which exists only while editing.
 *
 * MOUNTED SINCE 2026-08-20, ON THE PHONE ONLY. `ReaderSurface` picks this over
 * `DocSplitView` when `useMobileSurface().oneSurface` is true — the arrangement
 * this component's own Write⇄Preview toggle was written for and, until now, the
 * one nobody had mounted it into. The desktop keeps the split.
 */
export function DocEditor({
  save,
  detail,
  stance: controlledStance,
  onStanceChange,
  onOpenBlock,
  onCollapse,
  collapseRefusal,
  conflictActor,
  fileHref,
  attach,
  onAttached,
  skillOptions,
}: {
  save: DocSaveHandle;
  detail: EntityDetail;
  /** Resolves `tm8://file/<id>` images in the preview stance. See `DocPreview`. */
  fileHref?: MarkdownFileHref;
  /** Uploads a file and writes its reference at the caret. See `DocAttach`. */
  attach?: DocAttach;
  onAttached?: () => void;
  /** Skills `/` can reference in the source stance (R1). */
  skillOptions?: readonly TriggerOption[];
  /** Controlled stance, for a host that persists it. Uncontrolled by default. */
  stance?: DocStance;
  onStanceChange?: (next: DocStance) => void;
  /** Absent ⇒ every block's editor entry renders disabled-with-reason. */
  onOpenBlock?: (block: DocBlock) => void;
  /**
   * ⇲ — leave the edit stance. THE SAME PAIR `DocSplitView` TAKES, and it is
   * not symmetry for its own sake: on the phone this component IS the whole
   * edit stance, so without an exit the only way back to the document is
   * Cancel — which drops the draft and STAYS in edit (`ReaderSurface`'s own
   * note on the two controls that look like one). A reader who opened the
   * editor to look at the source would have no way out that did not also throw
   * something away.
   */
  onCollapse?: () => void;
  /**
   * Why collapse is refused, when the HOST is the one refusing it — an unsaved
   * draft, in `ReaderSurface`'s case. See `DocSplitView` for the full argument.
   *
   * THIS PROP IS ALSO WHAT CLAIMS THE EXIT, and that is the one place this
   * component's contract differs from the split's. The split is a full-view
   * promotion and ALWAYS has a way back, so `onCollapse` absent can only mean
   * "refused" there. Here it is genuinely ambiguous: the header block above
   * records that ⇲ "is drawn in the PANEL HEADER, not inside the content
   * region", and a host that draws its own exit passes NEITHER prop. Rendering
   * a refusal for that host would be a second control for one gesture — the
   * thing this component was written not to do — and it would be refusing a
   * verb the reader can already perform, which is worse than hiding one.
   *
   * So: neither prop ⇒ the host owns the exit and nothing is drawn here. This
   * prop present, `onCollapse` absent ⇒ the exit is THIS bar's and is refused,
   * so it renders dimmed carrying this reason. Never enabled-inert, and never
   * silently dropped once claimed.
   */
  collapseRefusal?: { cause: string; remedy: string };
  /** The other writer's name, when the host knows it from the event stream. */
  conflictActor?: string | null;
}) {
  const [ownStance, setOwnStance] = useState<DocStance>('write');
  const stance = controlledStance ?? ownStance;
  const setStance = (next: DocStance) => {
    setOwnStance(next);
    onStanceChange?.(next);
  };

  return (
    <div className="de-root" data-testid="doc-editor">
      <div className="de-bar">
        <StanceToggle stance={stance} onChange={setStance} />
        <span className="de-bar__spacer" />
        {onCollapse ? (
          <button type="button" className="de-btn de-btn--quiet" data-testid="doc-collapse" onClick={onCollapse}>
            ⇲ close
          </button>
        ) : collapseRefusal ? (
          <DisabledIconControl label="Close the editor" reason={collapseRefusal}>
            ⇲ close
          </DisabledIconControl>
        ) : null}
        <SaveActions save={save} />
      </div>

      <ConflictBanner save={save} actor={conflictActor} />

      <div className="de-body">
        {stance === 'write' ? (
          <DocSource save={save} onOpenBlock={onOpenBlock} attach={attach} onAttached={onAttached} skillOptions={skillOptions} />
        ) : (
          <DocPreview source={save.body} fileHref={fileHref} />
        )}
      </div>

      <RefusalHost save={save} />

      <div className="de-foot">
        <SaveWord save={save} version={detail.version} />
        <span className="de-foot__spacer" />
        <span className="de-foot__hint">esc cancels · ⌘enter saves</span>
      </div>
    </div>
  );
}
