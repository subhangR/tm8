import { useEffect, useMemo, useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { getKind } from '../../domain';
import {
  DocEditor,
  DocSplitView,
  EditEntryControl,
  useDocSave,
  type DocAttach,
  type DocCommands,
} from '../../doc-edit';
import type { MarkdownFileHref } from '../../kit';
import { useMobileSurface } from '../../mobile';
import type { TriggerOption } from '../../rich-input';
import { ReaderBody } from './ReaderBody';

/**
 * READER SURFACE — the Content body of every `reader`-archetype kind, in its
 * two stances.
 *
 *   read  — `ReaderBody`: the outline chips over the document rendered as
 *           markdown, with the oracle's `Edit` primary above it.
 *   edit  — `DocSplitView` on a desktop: markdown source beside its live
 *           preview, sharing one draft, mounted exactly where the handover
 *           says the editor goes — "replaces the Content-tab body while
 *           editing, i.e. where ReaderBody renders". On a phone, `DocEditor`:
 *           one pane and a Write⇄Preview toggle. See the fork below.
 *
 * WHY THIS FILE EXISTS AT ALL. `useDocSave` is a hook and `PanelBody` is a
 * function that early-returns eight different bodies — a hook there would run
 * conditionally. One component per stance-holding archetype is the shape that
 * keeps the hook unconditional, which is the same reason `EntityDetailPanel`
 * hoists `useTaskSave` above its own early returns.
 *
 * NO KIND LITERAL (§15.2). The switch that routes here is on `panel.archetype`
 * — registry DATA — and the refusal sentence comes from the same row's
 * `panel.capabilityReasons.canEdit`. `doc` is the only kind carrying `reader`
 * today; a second one gets this surface by adding a row, not by editing this
 * file.
 *
 * ONE SAVE HANDLE PER DOC. The handover's warning is load-bearing: a second
 * `useDocSave` for the same entity would fork the user's text into two drafts.
 * The handle is created here and here only; a Z4 split view, when it is
 * wired, must receive THIS handle rather than make its own.
 *
 * THE TWO CONTROLS THAT LOOK LIKE ONE, and are not. `Cancel` (inside the
 * split's `SaveActions`) drops the DRAFT and stays in edit — the stance is the
 * host's, which is the handover's §7.3.2 split rather than an oversight.
 * `⇲ collapse` leaves the stance, and is withheld while the draft is dirty so
 * that no single click can discard text under a label that does not say
 * "discard" (L6: visible, dead, and stating the reason).
 */
export interface ReaderSurfaceProps {
  detail: EntityDetail;
  blocks: readonly ContentBlockRef[];
  historyUnavailableReason: string;
  onOpenEntity?: (id: string) => void;
  /**
   * The doc executor, accepted PARTIALLY because the panel's `commands` prop
   * is the shared authoring port and only some hosts wire the entity half.
   * No `patchEntity` ⇒ `Edit` renders disabled-with-reason ("editing is not
   * wired here"), never a live control that drops the keystrokes.
   * `Seam['commands']` satisfies this structurally — no cast anywhere.
   */
  commands?: Partial<DocCommands> | null;
  onSaved?: (result: CommandResult) => void;
  onReloadDetail?: (current: EntityDetail) => void;
  /**
   * Resolves `![](tm8://file/<id>)` to bytes. Handed to BOTH stances, and that
   * is the point: a preview that resolves images differently from the reader is
   * not a preview. Absent ⇒ every internal image states itself in both places
   * rather than one of them guessing a URL.
   */
  fileHref?: MarkdownFileHref;
  /**
   * Uploads a file against this document and writes its reference at the
   * caret. Absent ⇒ the editor's insert control renders disabled-with-reason.
   */
  attach?: DocAttach;
  /** An upload landed — the host refetches so the strip shows the new edge. */
  onAttached?: () => void;
  /**
   * Skills the source's `/` trigger can REFERENCE (R1 — a committed skill is
   * a `tm8://skill/<id>` link in the body; nothing is invoked). Absent ⇒ `/`
   * types plain text, which is what it did before the panel host had a seam
   * to read them from.
   */
  skillOptions?: readonly TriggerOption[];
}

export function ReaderSurface(props: ReaderSurfaceProps) {
  const { detail, onOpenEntity } = props;
  const [editing, setEditing] = useState(false);
  const { oneSurface } = useMobileSurface();

  const config = getKind(detail.kind);
  const editRefusal = config.panel.capabilityReasons?.canEdit;

  /**
   * The narrowing, and the one place it happens. This is a PROJECTION, not an
   * adapter: the same function reference is handed on, so there is no wrapper
   * in which `expectedVersion` could be dropped — which `doc-edit/commands.ts`
   * names as the failure that would silently turn every conflict into an
   * overwrite. Memoised so the save handle's callbacks keep their identity.
   */
  const patchEntity = props.commands?.patchEntity;
  const commands = useMemo<DocCommands | null>(
    () => (patchEntity ? { patchEntity } : null),
    [patchEntity],
  );

  const save = useDocSave({
    detail,
    commands,
    editRefusal,
    onSaved: props.onSaved,
    onReload: props.onReloadDetail,
  });

  /**
   * A different entity in the same panel slot is a DIFFERENT DOCUMENT. Without
   * this the panel would carry the stance — and worse, a dirty draft — from
   * the doc the user just closed onto the one they just opened, and the next
   * ⌘enter would write one document's text into another's record.
   */
  useEffect(() => {
    setEditing(false);
  }, [detail.id]);

  if (editing) {
    /**
     * THE SPLIT IS THE EDIT SURFACE (user ruling 2026-07-31): markdown source
     * on the left, the live rendered preview on the right, one draft between
     * them. This centre column is full-width, and at that width showing both
     * at once beats making the viewer choose.
     *
     * ON A PHONE IT IS NOT (user ruling 2026-08-20: "no split view on the
     * phone"). Two honest columns do not exist at 390px — the split's own
     * annotation says the stance is "chosen by geometry, not preference", and
     * this is the geometry it meant. `DocEditor` is that answer: one pane, a
     * Write⇄Preview toggle, the SAME `DocSaveHandle`. Same session, same draft,
     * same conflict story; only the arrangement differs, which is the whole
     * reason both frames were built against one hook.
     *
     * THE FORK IS `oneSurface`, NOT A WIDTH. A media query would restyle the
     * desktop shell in a narrow window (`mobile/surface.tsx` states why at
     * length); off the phone shell there is no provider, so the phone arm here
     * is unreachable by construction rather than by a selector.
     *
     * ONE EXIT, not two, in BOTH arrangements. `⇲` in the editor's own bar IS
     * the exit, and it is withheld while the draft is dirty so a click cannot
     * silently discard text — with `collapseRefusal` carrying the true reason,
     * since the control's own fallback copy would blame the wiring instead.
     */
    const exit = {
      onCollapse: save.dirty ? undefined : () => setEditing(false),
      collapseRefusal: {
        cause: 'This document has unsaved changes',
        remedy: 'save them, or use Cancel to drop the draft first',
      },
    };

    return (
      <div
        className="rs-root"
        data-testid="reader-surface"
        data-stance="edit"
        data-arrangement={oneSurface ? 'phone' : 'desktop'}
      >
        {oneSurface ? (
          <DocEditor
            save={save}
            detail={detail}
            fileHref={props.fileHref}
            attach={props.attach}
            onAttached={props.onAttached}
            skillOptions={props.skillOptions}
            {...exit}
          />
        ) : (
          <DocSplitView
            save={save}
            detail={detail}
            fileHref={props.fileHref}
            attach={props.attach}
            onAttached={props.onAttached}
            skillOptions={props.skillOptions}
            {...exit}
          />
        )}
      </div>
    );
  }

  return (
    <div className="rs-root" data-testid="reader-surface" data-stance="read">
      <div className="rs-bar">
        <EditEntryControl
          detail={detail}
          commands={commands}
          editRefusal={editRefusal}
          onEnterEdit={commands ? () => setEditing(true) : undefined}
        />
      </div>
      <div className="rs-body">
        <ReaderBody
          detail={detail}
          blocks={props.blocks}
          historyUnavailableReason={props.historyUnavailableReason}
          onOpenEntity={onOpenEntity}
          fileHref={props.fileHref}
        />
      </div>
    </div>
  );
}
