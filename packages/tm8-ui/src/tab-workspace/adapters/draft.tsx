/**
 * Draft host per kind (Spec A §9, Spec B §5.5). STUB — the Creation
 * workstream (F) renders the kind's creation form, autosaves values to the
 * draft store, marks dirty, submits and dispatches `drafts.bind`.
 */
import type { DraftTabRecord } from '../runtime/types';

export interface DraftHostProps {
  tab: DraftTabRecord;
  /** Stored values for this draft (null when none). */
  values: Record<string, unknown> | null;
  /** Store values (debounced) and mark the tab dirty. */
  onValues(values: Record<string, unknown>): void;
  /** Report a created entity; the host dispatches `drafts.bind` (source `system`). */
  onCreated(entityId: string, title: string): void;
  /** Cancel: close the draft tab (through the normal close flow). */
  onCancel(): void;
}

export function DraftHost({ tab }: { tab: DraftTabRecord }) {
  return (
    <div className="tws-body-stub" data-testid="tws-draft-host" data-kind={tab.kind}>
      <p className="tws-quiet">Draft {tab.kind}</p>
    </div>
  );
}
