/**
 * The unsaved-changes confirmation (Spec A §6, Spec B §5.4/§5.6): rendered
 * from `state.pending` when its reason is `unsaved_changes`, answered only
 * through `workspace.interactions.resolve` with a person's source. A bulk
 * close lists every dirty draft in ONE dialog. Workstream C.
 *
 * A native modal `<dialog>`: the top layer traps focus, makes the rest
 * inert, and Esc cancels (= Keep editing).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { InteractionChoice, Source, TabRecord } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { TabLeadIcon, useTabFacts } from './TabStrip';

function SingleTitle({ tab, children }: { tab: TabRecord; children: (title: string) => ReactNode }) {
  return <>{children(useTabFacts(tab).title)}</>;
}

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
  // Design ruling R1: single vs bulk copy is decided by the number of dirty drafts.
  const bulk = dirty.length > 1;
  const heading = bulk ? `Discard ${dirty.length} drafts?` : 'Discard draft?';

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
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself: Keep editing.
        if (event.target !== event.currentTarget) return;
        const r = event.currentTarget.getBoundingClientRect();
        const inside =
          event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
        if (!inside) resolve('keep', 'click');
      }}
      onCancel={(event) => {
        // Esc: Keep editing, through the dispatcher (the dialog closes when pending clears).
        event.preventDefault();
        resolve('keep', 'keyboard');
      }}
    >
      <h2 id="tws-ts-confirm-title" className="tws-ts-confirm-title">
        {heading}
      </h2>
      <p id="tws-ts-confirm-body" className="tws-ts-confirm-body">
        {bulk ? (
          'These tabs have unsaved changes:'
        ) : dirty[0] ? (
          <SingleTitle tab={dirty[0]}>{(title) => `“${title}” has unsaved changes.`}</SingleTitle>
        ) : (
          'This draft has unsaved changes.'
        )}
      </p>
      {bulk ? (
        <ul className="tws-ts-confirm-list">
          {dirty.map((tab) => (
            <DirtyItem key={tab.id} tab={tab} />
          ))}
        </ul>
      ) : null}
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
          {bulk ? `Discard ${dirty.length} drafts` : 'Discard draft'}
        </button>
      </div>
    </dialog>
  );
}
