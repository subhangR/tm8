/**
 * Icon rail (Spec A §4, design log §3): the Home rail entries, then
 * ⌘K · Craft · Settings · Help · account. Workstream A.
 *
 * THE TOP GROUP IS THE HOME RAIL'S POPULATION, NOT ITS COMPONENT. It reads
 * `homeRailGroups()` — the table `views/HomeRail.tsx` draws — restricted to
 * the Workspace kinds (D7), and draws it icon-only at 48px: the log drops the
 * NEW and Pinned bands, the words and the group eyebrows, so mounting
 * `HomeRail` would mean opting out of everything it draws. A rail entry IS the
 * browser's kind control: clicking one sets `browsers.main.kind`.
 */
import { cloneElement, isValidElement, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { KindIcon, VIEW_ART, homeRailGroups } from '../../domain';
import { VectorIcon } from '../../kit/VectorIcon';
import { isWorkspaceKind } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';

const BOTTOM_GROUP_IDS = ['craft', 'settings', 'help'] as const;
const BOTTOM_ART: Record<(typeof BOTTOM_GROUP_IDS)[number], readonly string[]> = {
  craft: VIEW_ART.craft,
  settings: VIEW_ART.settings,
  help: VIEW_ART.help,
};

export function WorkspaceRail() {
  const { gate, dispatch } = useWorkspace();
  const browserKind = useWorkspaceState((s) => s.browsers.main.kind);
  const groups = useMemo(
    () =>
      homeRailGroups()
        .map((group) => ({ ...group, kinds: group.kinds.filter((config) => isWorkspaceKind(config.kind)) }))
        .filter((group) => group.kinds.length > 0),
    [],
  );
  const bottom = BOTTOM_GROUP_IDS.flatMap((id) => {
    const tab = gate.shellTabs.find((t) => t.id === id);
    return tab ? [{ id, label: tab.label }] : [];
  });

  return (
    <nav className="tws-rail" aria-label="Workspace rail" data-testid="tws-rail">
      <div className="tws-rail-top" role="group" aria-label="Entity kinds">
        {groups.map((group) => (
          <div key={group.id} className="tws-rail-group" role="group" aria-label={group.label}>
            {group.kinds.map((config) => {
              const current = config.kind === browserKind;
              return (
                <RailTip key={config.kind} label={config.labelPlural}>
                  <button
                    type="button"
                    className="tws-rail-btn"
                    aria-label={config.labelPlural}
                    aria-current={current ? 'true' : undefined}
                    data-kind={config.kind}
                    onClick={() =>
                      dispatch({
                        command: 'workspace.browser.set',
                        args: { browserId: 'main', kind: config.kind },
                        source: 'click',
                      })
                    }
                  >
                    <KindIcon kind={config.kind} size={18} />
                  </button>
                </RailTip>
              );
            })}
          </div>
        ))}
      </div>
      <div className="tws-rail-bottom" role="group" aria-label="Workspace tools">
        <RailTip label="Command palette" shortcut="⌘K">
          <button type="button" className="tws-rail-btn" aria-label="Command palette" aria-keyshortcuts="Meta+K" onClick={gate.openPalette}>
            <span className="tws-rail-kbd" aria-hidden>
              ⌘K
            </span>
          </button>
        </RailTip>
        {bottom.map((tab) => (
          <RailTip key={tab.id} label={tab.label}>
            <button
              type="button"
              className="tws-rail-btn"
              aria-label={tab.label}
              data-rail-tool={tab.id}
              onClick={() => gate.onSelectViewTab(tab.id)}
            >
              <VectorIcon paths={BOTTOM_ART[tab.id]} size={18} />
            </button>
          </RailTip>
        ))}
        {gate.accountSlot ? (
          <RailTip label="Account">
            <div className="tws-rail-account">
              {/* R12: the avatar-only trigger with its own accessible name. */}
              {isValidElement<{ compact?: boolean }>(gate.accountSlot)
                ? cloneElement(gate.accountSlot, { compact: true })
                : gate.accountSlot}
            </div>
          </RailTip>
        ) : null}
      </div>
    </nav>
  );
}

/* TOOLTIPS (design log §3): to the right with an 8px offset, after 400ms —
   immediately while another tip is showing or has just hidden. Fixed
   position, so the top group's own scroll cannot clip them. */
const TIP_DELAY_MS = 400;
const TIP_WARM_MS = 300;
const TIP_OFFSET_PX = 8;
let tipShownAt = 0;
let tipHiddenAt = 0;

function RailTip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactElement }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<number | null>(null);
  const anchor = useRef<HTMLDivElement>(null);

  const show = () => {
    const warm = tipShownAt > tipHiddenAt || Date.now() - tipHiddenAt < TIP_WARM_MS;
    const open = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      tipShownAt = Date.now();
      setPos({ left: rect.right + TIP_OFFSET_PX, top: rect.top + rect.height / 2 });
    };
    if (timer.current) window.clearTimeout(timer.current);
    if (warm) open();
    else timer.current = window.setTimeout(open, TIP_DELAY_MS);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (pos) tipHiddenAt = Date.now();
    setPos(null);
  };

  let tip: ReactNode = null;
  if (pos) {
    tip = (
      <span className="tws-tip" role="tooltip" style={{ left: pos.left, top: pos.top }}>
        {label}
        {shortcut ? <span className="tws-tip-kbd">{shortcut}</span> : null}
      </span>
    );
  }
  return (
    <div
      ref={anchor}
      className="tws-tip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
    >
      {children}
      {tip}
    </div>
  );
}
