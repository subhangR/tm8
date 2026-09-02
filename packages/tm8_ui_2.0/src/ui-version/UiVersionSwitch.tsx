/**
 * THE UI VERSION SWITCH — a door to the frozen 1.0 UI, and back.
 *
 * WHERE IT SITS, and why not the tab row. The owner asked for this "in the top
 * tab bar some where". It hangs in the account menu's utility group, which the
 * top bar owns — beside Inbox and Copy link. Two reasons, both from decisions
 * already in this file's neighbourhood:
 *
 *  1. `SpaceTabBar` revision 21 (owner-ordered, 2026-08-31) DELIBERATELY
 *     emptied the bar's right side, moving Inbox and Copy link into this menu.
 *     Hanging a new control back on the bar would undo that two days later.
 *  2. The tabs are data-driven from the resolved MenuConfig's groups, and
 *     `SpaceTabBar` states it hardcodes no tab names. A UI version is not a
 *     group and has no screen, so it cannot honestly be a tab: a tab that
 *     navigates off the app would be the only one that never reads current.
 *
 * The account menu is also already where per-viewer presentation lives — it is
 * theme's one home (D1) — and which UI you are looking at is the same kind of
 * fact as which theme you are in.
 *
 * IT IS A LINK, NOT A TOGGLE. Switching UI is a full document navigation: the
 * two bundles are separate React roots on different major versions (1.0 is the
 * pre-Astryx snapshot; 2.0 is React 19 + StyleX). An `<a href>` says that
 * honestly, and it gets middle-click and open-in-new-tab for free, which a
 * button wired to `location.assign` would silently take away.
 *
 * NOTHING IS PERSISTED. There is no "preferred UI" setting and no redirect on
 * boot: `/` is always 2.0 and `/ui-1.0/` is always 1.0, so the address bar is
 * the whole state. A remembered preference would mean a viewer who switched
 * once could never be shown the product UI again without finding this control
 * inside the UI they are trying to leave.
 */
import { useEffect, useState } from 'react';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { probeUi10, UI_1_0_PATH, type UiVersionAvailability } from './mount';
import './ui-version.css';

const LABEL = 'Switch to UI 1.0';

export interface UiVersionSwitchProps {
  /**
   * Row grammar from the host. Passed in rather than applied here for the same
   * reason `CopyLinkControl` takes it: the host chose to hang this in a menu,
   * so the host says how it sits there.
   */
  className?: string;
  /** Test seam — the probe's transport. */
  fetcher?: typeof fetch;
}

export function UiVersionSwitch({ className, fetcher }: UiVersionSwitchProps) {
  const [state, setState] = useState<UiVersionAvailability>({ phase: 'probing' });

  useEffect(() => {
    let live = true;
    probeUi10(fetcher ?? fetch).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [fetcher]);

  const glyph = (
    <span className="ui-version__glyph" aria-hidden>
      ⇄
    </span>
  );

  /* PROBING AND ABSENT BOTH REFUSE, with different reasons — and neither
     hides. That is the D28 posture the retired inbox bell brought into this
     menu: a control that cannot act stays drawn, focusable and named, and
     carries why. Hiding the row while the probe is in flight would also make
     the menu's rows move under the pointer on a slow network. */
  if (state.phase !== 'available') {
    const refused = (
      <DisabledAction
        label={LABEL}
        reason={
          state.phase === 'probing'
            ? { cause: 'Checking whether the 1.0 UI is served here' }
            : {
                cause: state.reason,
                remedy: 'an operator sets TM8_UI_1_0_DIR to a built 1.0 bundle',
              }
        }
      >
        {glyph} {LABEL}
      </DisabledAction>
    );
    return className ? <span className={className}>{refused}</span> : refused;
  }

  return (
    <a
      className={`ui-version${className ? ` ${className}` : ''}`}
      href={UI_1_0_PATH}
      data-testid="switch-to-ui-1-0"
      aria-label={LABEL}
      title="The pre-Astryx 1.0 UI, frozen 2026-08-29"
      /* Not `target="_blank"`: this replaces the app rather than opening a
         second copy of it beside itself. Two live UIs over one catalog would
         put the same entity on screen twice with independent event streams. */
    >
      {glyph} {LABEL}
    </a>
  );
}
