import { useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import type { DocBlock } from './blocks';
import { DocPreview } from './DocPreview';
import { DocSource } from './DocSource';
import {
  ConflictBanner,
  RefusalHost,
  SaveActions,
  SaveWord,
  StanceToggle,
  type DocStance,
} from './EditorChrome';
import type { DocSaveHandle } from './useDocSave';

/**
 * T5-3 FRAME 1b — "edit" — THE Z3 EDIT SURFACE.
 *
 * Top to bottom, exactly the regions the oracle's edit panel draws (lines
 * 68-118), minus the ones that are SHARED CHROME and belong to the panel rather
 * than to this body:
 *
 *   [chrome]         breadcrumb · title · v-pill · "editing" pill · ⋯ ✕
 *   [chrome]         the four-tab strip
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
 * MOUNTABLE, NOT MOUNTED. Nothing here is wired into a screen; the coordinator
 * holds the wiring seat and `HANDOVER.md` carries the exact props and mounts.
 */
export function DocEditor({
  save,
  detail,
  stance: controlledStance,
  onStanceChange,
  onOpenBlock,
  conflictActor,
}: {
  save: DocSaveHandle;
  detail: EntityDetail;
  /** Controlled stance, for a host that persists it. Uncontrolled by default. */
  stance?: DocStance;
  onStanceChange?: (next: DocStance) => void;
  /** Absent ⇒ every block's editor entry renders disabled-with-reason. */
  onOpenBlock?: (block: DocBlock) => void;
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
        <SaveActions save={save} />
      </div>

      <ConflictBanner save={save} actor={conflictActor} />

      <div className="de-body">
        {stance === 'write' ? (
          <DocSource save={save} onOpenBlock={onOpenBlock} />
        ) : (
          <DocPreview source={save.body} />
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
