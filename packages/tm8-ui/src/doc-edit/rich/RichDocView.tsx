import { useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { DisabledIconControl } from '../../panels/honesty/DisabledWithReason';
import type { MarkdownFileHref } from '../../kit';
import type { TriggerOption } from '../../rich-input';
import { DocSource, type DocAttach } from '../DocSource';
import { DocTitleField } from '../DocTitleField';
import { ConflictBanner, RefusalHost, SaveActions, SaveWord } from '../EditorChrome';
import type { DocSaveHandle } from '../useDocSave';
import { roundTrips } from './markdown';
import { RichBody } from './RichBody';

type Mode = 'rich' | 'source';

/**
 * THE DOC EDIT SURFACE (New doc UX, 2026-10-07) — replaces the source/preview
 * split on the desktop and the Write⇄Preview editor on the phone.
 *
 * Same chrome as before — Done and the save state on top, the conflict banner,
 * the title, refusals, the footer — around one rich body. A body the editor
 * cannot keep (raw HTML, say) opens as markdown source with the reason
 * stated, and any body can be switched to source by hand; switching back is
 * refused, with the reason, while the source holds something the editor would
 * lose.
 */
export function RichDocView({
  save,
  detail,
  onCollapse,
  collapseRefusal,
  conflictActor,
  fileHref,
  attach,
  onAttached,
  skillOptions,
  focusTitle,
  titleElsewhere,
}: {
  save: DocSaveHandle;
  detail: EntityDetail;
  onCollapse?: () => void;
  collapseRefusal?: { cause: string; remedy: string };
  conflictActor?: string | null;
  fileHref?: MarkdownFileHref;
  attach?: DocAttach;
  onAttached?: () => void;
  skillOptions?: readonly TriggerOption[];
  /** Put the caret in the title on mount — a doc New doc just created. */
  focusTitle?: boolean;
  /** The host draws the title in its own band; no second one here. */
  titleElsewhere?: boolean;
}) {
  const [opened] = useState(() => roundTrips(save.body));
  const [mode, setMode] = useState<Mode>(opened ? 'rich' : 'source');
  const keepsBody = mode === 'source' ? roundTrips(save.body) : true;

  return (
    <div className="de-root de-richview" data-testid="doc-rich-view" data-mode={mode} data-doc-editor="">
      <div className="de-bar">
        {onCollapse ? (
          <button type="button" className="de-btn de-btn--quiet" data-testid="doc-collapse" onClick={onCollapse}>
            Done
          </button>
        ) : (
          <DisabledIconControl
            label="Back to reading"
            reason={collapseRefusal ?? {
              cause: 'Leaving isn’t connected here',
              remedy: 'this view was mounted without a collapse dispatch',
            }}
          >
            Done
          </DisabledIconControl>
        )}
        <span className="de-bar__spacer" />
        {mode === 'rich' ? (
          <button
            type="button"
            className="de-btn de-btn--quiet"
            data-testid="doc-mode-source"
            onClick={() => {
              void save.flush();
              setMode('source');
            }}
          >
            Edit as markdown
          </button>
        ) : keepsBody ? (
          <button type="button" className="de-btn de-btn--quiet" data-testid="doc-mode-rich" onClick={() => setMode('rich')}>
            Rich editor
          </button>
        ) : (
          <DisabledIconControl
            label="Rich editor"
            reason={{
              cause: 'This text has markup the rich editor would drop',
              remedy: 'usually raw HTML; it stays editable here as markdown',
            }}
          >
            Rich editor
          </DisabledIconControl>
        )}
        <SaveActions save={save} />
      </div>

      <ConflictBanner save={save} actor={conflictActor} />

      {!titleElsewhere ? (
        <div className="de-titlerow">
          <DocTitleField save={save} autoFocus={focusTitle} />
        </div>
      ) : null}

      {mode === 'source' && !opened ? (
        <p className="de-richview__note" data-testid="doc-source-reason">
          Editing as markdown: this document has markup (usually raw HTML) the rich editor would drop.
        </p>
      ) : null}

      <div className="de-richview__body">
        {mode === 'rich' ? (
          <RichBody
            save={save}
            fileHref={fileHref}
            attach={attach}
            onAttached={onAttached}
            skillOptions={skillOptions}
          />
        ) : (
          <DocSource save={save} label="Document source" attach={attach} onAttached={onAttached} skillOptions={skillOptions} />
        )}
      </div>

      <RefusalHost save={save} />

      <div className="de-foot">
        <SaveWord save={save} version={detail.version} />
        <span className="de-foot__spacer" />
        <span className="de-foot__hint">
          {mode === 'rich' ? 'saves as you type · / for blocks and skills · ⌘enter saves now' : 'saves as you type · ⌘enter saves now'}
        </span>
      </div>
    </div>
  );
}
