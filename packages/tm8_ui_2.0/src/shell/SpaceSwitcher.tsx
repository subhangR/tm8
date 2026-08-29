/**
 * SpaceSwitcher — the identity block at the head of the menu rail: the ONE
 * server ⋄ space control (single-home ruling, 2026-08-14).
 *
 * WHAT IT REPLACED, and why. Server identity used to be drawn twice — monogram
 * rows inside the rail AND a read-only dot+label in the tab bar — with a caret
 * on the rail rows that toggled nothing, while spaces lived in a third place
 * (the tab bar's tablist). But a (server, space) pair is not three facts; it is
 * ONE fact: the context you are standing in. Servers are strictly
 * one-at-a-time (App remounts the whole workspace on switch) and spaces are
 * per-server, so the honest chrome is a single block naming the pair, with a
 * popover for changing either.
 *
 * THE POPOVER IS HONEST ABOUT WHAT IT CANNOT LIST. Spaces are readable only
 * from the ACTIVE server — there is no cross-server aggregation anywhere in
 * this app — so inactive servers render as switch rows, not as expandable
 * space lists. Claiming to list a remote server's spaces would require reads
 * this client deliberately does not do.
 *
 * Both add-affordances keep the D28 posture: focusable,
 * `aria-disabled`-with-reason when the host has no port, never hidden.
 */
import { useEffect, useRef, useState } from 'react';
import type { SpaceId, SpaceSummary } from '@tm8/contract';
import type { ServerRailItem } from './MenuRail';

export interface SpaceSwitcherProps {
  servers: readonly ServerRailItem[];
  activeServerId: string;
  /** The ACTIVE server's spaces — the only ones this client can read. */
  spaces: readonly SpaceSummary[];
  activeSpaceId: SpaceId | null;
  /** Mirrors the rail's discrete width: collapsed renders the monogram only. */
  collapsed: boolean;
  onSelectServer(id: string): void;
  onSelectSpace(id: SpaceId): void;
  onAddServer?(): void;
  onAddSpace?(): void;
  addSpaceReason?: string;
  addServerReason?: string;
}

export const SWITCHER_ADD_SPACE_REASON = 'creating spaces arrives with the settings screens';
export const SWITCHER_ADD_SERVER_REASON = 'adding servers is unavailable on this host';

const monogramOf = (server: ServerRailItem | undefined): string =>
  !server || server.local ? '◈' : server.label.trim().charAt(0).toUpperCase() || '·';

export function SpaceSwitcher(props: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active = props.servers.find((server) => server.id === props.activeServerId);
  const activeSpace = props.spaces.find((space) => space.id === props.activeSpaceId);

  /* Click-outside + Escape both close. Window-level, mounted only while open,
     so a closed switcher costs no listener. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = active
    ? `${active.label}${activeSpace ? ` · ${activeSpace.name}` : ''}`
    : activeSpace?.name ?? 'no space';

  return (
    <div className="shell-switcher" ref={rootRef} data-testid="space-switcher">
      <button
        type="button"
        className="shell-switcher__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Server and space: ${label}`}
        title={props.collapsed ? label : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shell-switcher__monogram" aria-hidden="true">{monogramOf(active)}</span>
        {!props.collapsed ? (
          <span className="shell-switcher__names">
            <span className="shell-switcher__space">{activeSpace?.name ?? 'no space'}</span>
            <span className="shell-switcher__server-line">
              <span
                className={`shell-rail__server-status shell-rail__server-status--${active?.reachability ?? 'checking'}`}
                aria-hidden="true"
              />
              {active?.label ?? 'server'}
            </span>
          </span>
        ) : null}
        {!props.collapsed ? <span className="shell-switcher__caret" aria-hidden="true">{open ? '▾' : '▸'}</span> : null}
      </button>

      {open ? (
        <div className="shell-switcher__pop" role="dialog" aria-label="Switch server or space">
          {props.servers.map((server) => {
            const isActive = server.id === props.activeServerId;
            return (
              <div key={server.id} className="shell-switcher__section">
                <button
                  type="button"
                  className={`shell-switcher__server ${isActive ? 'shell-switcher__server--active' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  /* The active server's row is informational — its spaces are
                     the actionable rows beneath. An INACTIVE server's row is
                     the switch itself. */
                  onClick={() => {
                    if (isActive) return;
                    setOpen(false);
                    props.onSelectServer(server.id);
                  }}
                >
                  <span className="shell-switcher__monogram shell-switcher__monogram--small" aria-hidden="true">
                    {monogramOf(server)}
                  </span>
                  <span className="shell-switcher__server-name">{server.label}</span>
                  <span
                    className={`shell-rail__server-status shell-rail__server-status--${server.reachability}`}
                    aria-hidden="true"
                  />
                </button>
                {isActive ? (
                  props.spaces.map((space) => {
                    const current = space.id === props.activeSpaceId;
                    return (
                      <button
                        key={space.id}
                        type="button"
                        className={`shell-switcher__space-row ${current ? 'shell-switcher__space-row--active' : ''}`}
                        aria-current={current ? 'true' : undefined}
                        onClick={() => {
                          setOpen(false);
                          if (!current) props.onSelectSpace(space.id);
                        }}
                      >
                        <span className="shell-switcher__check" aria-hidden="true">{current ? '✓' : ''}</span>
                        {space.name}
                      </button>
                    );
                  })
                ) : (
                  /* Not a lie dressed as a list: reading a remote server's
                     spaces requires switching to it, and this row says so. */
                  <div className="shell-switcher__hint">switch to see its spaces</div>
                )}
              </div>
            );
          })}

          <div className="shell-switcher__footer">
            <button
              type="button"
              className="shell-switcher__add"
              aria-disabled={props.onAddSpace ? undefined : 'true'}
              title={props.onAddSpace ? 'Create a Space and add a local project' : props.addSpaceReason ?? SWITCHER_ADD_SPACE_REASON}
              onClick={
                props.onAddSpace
                  ? () => {
                      setOpen(false);
                      props.onAddSpace?.();
                    }
                  : (event) => event.preventDefault()
              }
            >
              ＋ new space
            </button>
            <button
              type="button"
              className="shell-switcher__add"
              aria-disabled={props.onAddServer ? undefined : 'true'}
              title={props.onAddServer ? 'Connect another tm8 server' : props.addServerReason ?? SWITCHER_ADD_SERVER_REASON}
              onClick={
                props.onAddServer
                  ? () => {
                      setOpen(false);
                      props.onAddServer?.();
                    }
                  : (event) => event.preventDefault()
              }
            >
              ＋ add server
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
