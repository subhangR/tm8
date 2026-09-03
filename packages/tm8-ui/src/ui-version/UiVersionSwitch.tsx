/**
 * THE UI VERSION SWITCH — a door to the alternate 2.0 UI.
 *
 * This package is the product UI at `/`. `packages/tm8_ui_2.0` (the Astryx
 * redesign) held that role from 2026-08-29 until 2026-09-03 and is now the
 * alternate, served at `/ui-2.0/` on this origin when an operator sets
 * `TM8_UI_2_0_DIR`. A viewer needs a door to it that does not require them to
 * know the URL; the way back is `UiVersionReturn` in that bundle's own chrome,
 * because a one-way switch is a trap.
 *
 * IT PROBES, unlike the return control on the other side. That one needs no
 * probe — `/` is where the product UI always is, so if the alternate bundle is
 * on screen at all its destination is reachable by construction. This one is
 * asking about an OPTIONAL bundle that an operator may never have configured,
 * and offering a link to a door that is not there is the failure it exists to
 * prevent.
 *
 * IT IS A LINK, NOT A TOGGLE. Switching UI is a full document navigation: the
 * two bundles are separate React roots. An `<a href>` says that honestly, and
 * it gets middle-click and open-in-new-tab for free, which a button wired to
 * `location.assign` would silently take away.
 *
 * NOTHING IS PERSISTED. There is no "preferred UI" setting and no redirect on
 * boot: `/` is always this UI and `/ui-2.0/` is always the other, so the
 * address bar is the whole state. A remembered preference would mean a viewer
 * who switched once could never be shown the product UI again without finding
 * this control inside the UI they are trying to leave.
 */
import { useEffect, useState } from 'react';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { probeUi20, UI_2_0_PATH, type UiVersionAvailability } from './mount';
import './ui-version.css';

const LABEL = 'Switch to UI 2.0';

export interface UiVersionSwitchProps {
  /**
   * Chrome grammar from the host. Passed in rather than applied here: the host
   * chose where to hang this control, so the host says how it sits there.
   */
  className?: string;
  /** Test seam — the probe's transport. */
  fetcher?: typeof fetch;
}

export function UiVersionSwitch({ className, fetcher }: UiVersionSwitchProps) {
  const [state, setState] = useState<UiVersionAvailability>({ phase: 'probing' });

  useEffect(() => {
    let live = true;
    probeUi20(fetcher ?? fetch).then((next) => {
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
     hides. A control that cannot act stays drawn, focusable and named, and
     carries why. Hiding it while the probe is in flight would also make the
     bar's controls move under the pointer on a slow network. */
  if (state.phase !== 'available') {
    const refused = (
      <DisabledAction
        label={LABEL}
        reason={
          state.phase === 'probing'
            ? { cause: 'Checking whether the 2.0 UI is served here' }
            : {
                cause: state.reason,
                remedy: 'an operator sets TM8_UI_2_0_DIR to a built 2.0 bundle',
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
      href={UI_2_0_PATH}
      data-testid="switch-to-ui-2-0"
      aria-label={LABEL}
      title="The Astryx 2.0 UI"
      /* Not `target="_blank"`: this replaces the app rather than opening a
         second copy of it beside itself. Two live UIs over one catalog would
         put the same entity on screen twice with independent event streams. */
    >
      {glyph} {LABEL}
    </a>
  );
}
