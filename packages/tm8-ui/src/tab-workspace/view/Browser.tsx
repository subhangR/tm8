/** Entity browser (Spec A §5): kind control · + New · search · filters · list. Workstream B. */
import { getKindAdapter } from '../adapters/registry';
import { useWorkspace, useWorkspaceState } from './context';

export function Browser() {
  const { dispatch } = useWorkspace();
  const kind = useWorkspaceState((s) => s.browsers.main.kind);
  const adapter = getKindAdapter(kind);
  const disabledReason = adapter.creatable === true ? null : adapter.creatable.disabledReason;
  return (
    <section className="tws-browser" aria-label="Workspace browser" data-testid="tws-browser">
      <div className="tws-browser-toolbar">
        <button type="button" className="tws-quiet-btn" aria-label="Entity kind in Workspace browser">
          {adapter.nounPlural} ▾
        </button>
        <button
          type="button"
          className="tws-new-btn"
          aria-label={`Create ${adapter.noun.toLowerCase()}`}
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => dispatch({ command: 'workspace.drafts.open', args: { kind }, source: 'click' })}
        >
          + New
        </button>
      </div>
      <div className="tws-browser-list" />
    </section>
  );
}
