/**
 * The unsaved-changes confirmation (Spec A §6, Spec B §5.4/§5.6): rendered
 * from `state.pending` when its reason is `unsaved_changes`, answered only
 * through `workspace.interactions.resolve` with a person's source. A bulk
 * close lists every dirty draft in ONE dialog. Workstream C.
 *
 * A native modal `<dialog>`: the top layer traps focus, makes the rest
 * inert, and Esc cancels (= Keep editing).
 */
import { useEffect, useRef } from 'react';
import type { InteractionChoice, Source, TabRecord } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { TabLeadIcon, useTabFacts } from './TabStrip';

function DirtyItem({ tab }: { tab: TabRecord }) {
  const { title } = useTabFacts(tab);
  return (
    <li className="tws-ts-confirm-item">
      <TabLeadIcon tab={tab} />
      <span className="tws-ts-title">{title}</span>
    </li>
  );
}

export function ConfirmDiscard({ onResolved }: { onResolved?: (choice: InteractionChoice) => void }) {
  const { dispatch } = useWorkspace();
  const pending = useWorkspaceState((s) => (s.pending?.reason === 'unsaved_changes' ? s.pending : undefined));
  const tabs = useWorkspaceState((s) => s.tabs);
  const ref = useRef<HTMLDialogElement>(null);

  const open = pending !== undefined;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      // The safe answer takes focus first.
      dialog.querySelector<HTMLElement>('[data-choice="keep"]')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!pending) return <dialog ref={ref} className="tws-ts-confirm" hidden />;

  const dirty = (pending.tabIds ?? []).map((id) => tabs[id]).filter((t): t is TabRecord => t !== undefined);
  const bulk = (pending.closeTabIds?.length ?? dirty.length) > 1 || dirty.length > 1;
  const heading = dirty.length > 1 ? `Discard ${dirty.length} drafts?` : 'Discard draft?';

  const resolve = (choice: InteractionChoice, source: Source) => {
    onResolved?.(choice);
    dispatch({ command: 'workspace.interactions.resolve', args: { interactionId: pending.id, choice }, source });
  };
  const sourceOf = (detail: number): Source => (detail === 0 ? 'keyboard' : 'click');

  return (
    <dialog
      ref={ref}
      className="tws-ts-confirm"
      role="alertdialog"
      aria-labelledby="tws-ts-confirm-title"
      aria-describedby="tws-ts-confirm-body"
      data-testid="tws-confirm-discard"
      onCancel={(event) => {
        // Esc: Keep editing, through the dispatcher (the dialog closes when pending clears).
        event.preventDefault();
        resolve('keep', 'keyboard');
      }}
    >
      <h2 id="tws-ts-confirm-title" className="tws-ts-confirm-title">
        {heading}
      </h2>
      <div id="tws-ts-confirm-body" className="tws-ts-confirm-body">
        {bulk && dirty.length > 0 ? (
          <>
            <p>{dirty.length > 1 ? 'These drafts have unsaved changes:' : 'This draft has unsaved changes:'}</p>
            <ul className="tws-ts-confirm-list">
              {dirty.map((tab) => (
                <DirtyItem key={tab.id} tab={tab} />
              ))}
            </ul>
          </>
        ) : (
          <p>Your changes to this draft will be lost.</p>
        )}
      </div>
      <div className="tws-ts-confirm-actions">
        <button
          type="button"
          className="tws-ts-confirm-btn"
          data-choice="keep"
          onClick={(event) => resolve('keep', sourceOf(event.detail))}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="tws-ts-confirm-btn"
          data-choice="discard"
          data-tone="danger"
          onClick={(event) => resolve('discard', sourceOf(event.detail))}
        >
          {dirty.length > 1 ? 'Discard drafts' : 'Discard draft'}
        </button>
      </div>
    </dialog>
  );
}
