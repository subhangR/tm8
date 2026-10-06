/** Left header (Spec A §3, design log §2): tm8 mark · view selector · space switcher. Workstream A. */
import { useState } from 'react';
import { useWorkspace } from './context';

export function LeftHeader() {
  const { gate } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <header className="tws-left-header" data-testid="tws-left-header">
      <button type="button" className="tws-icon-btn tws-mark" aria-label="Home" title="Home" onClick={gate.goHome}>
        tm8
      </button>
      <div className="tws-view-select">
        <button
          type="button"
          className="tws-quiet-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Workspace ▾
        </button>
        {open ? (
          <div role="menu" className="tws-menu">
            {gate.viewTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={tab.id === gate.activeViewTabId}
                className="tws-menu-row"
                onClick={() => {
                  setOpen(false);
                  gate.onSelectViewTab(tab.id);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="tws-space-slot">{gate.switcherSlot}</div>
    </header>
  );
}
