import { useState, type FocusEvent, type ReactNode } from 'react';
import type { CommandResult, EntityDetail, EntityId, PatchTaskInput } from '@tm8/contract';
import {
  ConflictBanner,
  DocSource,
  RefusalHost,
  RichBody,
  SaveActions,
  SaveWord,
  useDocSave,
  type DocAttach,
  roundTrips,
  type SaveCodec,
} from '../../doc-edit';
import type { MarkdownFileHref } from '../../kit';
import type { TriggerOption } from '../../rich-input';
import { DisabledIconControl } from '../honesty/DisabledWithReason';

/** The one command this surface writes through — a structural subset of the seam's. */
export interface TaskDescriptionCommands {
  patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult>;
}

/**
 * A TASK'S PROSE ON THE DOC SAVE FLOW. The description is read from
 * `content.description` and written with `patchTask`; everything between the
 * two ends — the base-version law, autosave, the device copy, the one retry
 * over a conflict that never touched the description — is `useDocSave`'s, so
 * there is no second save path for prose (task 01a1163a, agreed with the
 * editor lane 01a1161a). Module-level: the hook wants a stable value.
 */
export const taskDescriptionCodec: SaveCodec<TaskDescriptionCommands> = {
  bodyOf: (detail) => {
    const content = detail.content as unknown as Record<string, unknown>;
    const body = content.description ?? content.body;
    return typeof body === 'string' ? body : '';
  },
  send: (commands, id, edits, expectedVersion) =>
    commands.patchTask(id, {
      ...(edits.body !== undefined ? { description: edits.body } : {}),
      expectedVersion,
    }),
};

/**
 * THE TASK PAGE'S DESCRIPTION (mockup r6) — one editor, always mounted.
 *
 * There is no Edit/Done stance to cross: the page is for writing, so the
 * rendered text IS the editor and a click puts the caret where it landed.
 * What the stance used to buy — a calm page while reading — comes from the
 * chrome instead: the save word and the markdown switch appear only while the
 * description holds focus or holds something unsaved, and a conflict or a
 * refusal is drawn whatever the focus, because hiding either hides its reason.
 *
 * Same fallback as `RichDocView`: a body the rich editor would not keep opens
 * as markdown source with the reason stated, and switching back is refused
 * while the source still holds markup the editor would drop.
 *
 * Mount it keyed by entity id: what the body opened as, and the draft, belong
 * to one task.
 */
export function TaskDescription({
  detail,
  commands,
  editRefusal,
  onSaved,
  onReload,
  fileHref,
  attach,
  onAttached,
  skillOptions,
  attachmentSlot,
}: {
  detail: EntityDetail;
  /** Null ⇒ no executor is wired; the editor is read-only and says so. */
  commands: TaskDescriptionCommands | null;
  /** The registry's `capabilityReasons.canEdit`, for a server-refused edit. */
  editRefusal?: string;
  onSaved?: (result: CommandResult) => void;
  onReload?: (current: EntityDetail) => void;
  fileHref?: MarkdownFileHref;
  attach?: DocAttach;
  onAttached?: () => void;
  skillOptions?: readonly TriggerOption[];
  /** The attachment tiles: last inside the block, which is their drop target. */
  attachmentSlot?: ReactNode;
}) {
  const save = useDocSave({
    detail,
    commands,
    codec: taskDescriptionCodec,
    editRefusal,
    onSaved,
    onReload,
    autosave: true,
  });
  const [opened] = useState(() => roundTrips(save.body));
  const [mode, setMode] = useState<'rich' | 'source'>(opened ? 'rich' : 'source');
  const [focused, setFocused] = useState(false);
  const keepsBody = mode === 'source' ? roundTrips(save.body) : true;
  const writing = focused || save.dirty || save.state.phase !== 'clean';

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus moving between the editor and its own chrome is still writing.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    /* `data-attachment-drophost`: the strip finds its drop target by this
       marker, never by a body class name. */
    <div
      className="sb-description sb-description--rich"
      data-testid="task-description-editor"
      data-attachment-drophost=""
      data-stance={writing ? 'writing' : 'reading'}
      data-mode={mode}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <div className="sb-description__head">
        <span className="sb-description__label">Description</span>
        <span className="sb-description__spacer" />
        {writing && !save.unavailable ? (
          <>
            <SaveWord save={save} version={detail.version} />
            {mode === 'rich' ? (
              <button
                type="button"
                className="sb-description__stance"
                data-testid="task-description-source"
                onClick={() => {
                  void save.flush();
                  setMode('source');
                }}
              >
                Edit as markdown
              </button>
            ) : keepsBody ? (
              <button
                type="button"
                className="sb-description__stance"
                data-testid="task-description-rich"
                onClick={() => setMode('rich')}
              >
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
          </>
        ) : null}
        <SaveActions save={save} />
      </div>
      <ConflictBanner save={save} />
      {mode === 'source' && !opened ? (
        <p className="sb-description__note" data-testid="task-description-source-reason">
          Editing as markdown: this description has markup (usually raw HTML) the rich editor would drop.
        </p>
      ) : null}
      {mode === 'rich' ? (
        <RichBody
          save={save}
          label="Description"
          placeholder="Add a description, or type / for blocks and skills"
          fileHref={fileHref}
          attach={attach}
          onAttached={onAttached}
          skillOptions={skillOptions}
        />
      ) : (
        <DocSource save={save} label="Description" attach={attach} onAttached={onAttached} skillOptions={skillOptions} />
      )}
      <RefusalHost save={save} />
      {attachmentSlot ?? null}
    </div>
  );
}
