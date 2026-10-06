/** Icon rail (Spec A §4, design log §3): Home rail entries, then ⌘K · Craft · Settings · Help · account. Workstream A. */
import { useWorkspace } from './context';

const BOTTOM_GROUP_IDS = ['craft', 'settings', 'help'] as const;

export function WorkspaceRail() {
  const { gate } = useWorkspace();
  const bottom = BOTTOM_GROUP_IDS.flatMap((id) => gate.shellTabs.filter((tab) => tab.id === id));
  return (
    <nav className="tws-rail" aria-label="Workspace rail" data-testid="tws-rail">
      <div className="tws-rail-top" />
      <div className="tws-rail-bottom">
        <button
          type="button"
          className="tws-icon-btn"
          aria-label="Command palette"
          title="Command palette ⌘K"
          onClick={gate.openPalette}
        >
          ⌘K
        </button>
        {bottom.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="tws-icon-btn"
            aria-label={tab.label}
            title={tab.label}
            onClick={() => gate.onSelectViewTab(tab.id)}
          >
            {tab.label.slice(0, 1)}
          </button>
        ))}
        <div className="tws-rail-account">{gate.accountSlot}</div>
      </div>
    </nav>
  );
}
