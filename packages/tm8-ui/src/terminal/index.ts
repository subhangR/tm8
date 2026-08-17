/**
 * `src/terminal/` — terminal chrome AND the live byte stack (P2).
 *
 * R9's Phase-1 rule was that nothing here reads a byte; that phase is done.
 * `pty/` now carries the transplanted ptyTransport/writeScheduler/
 * visibilityDriver/pty-protocol port from packages/ui. The offset-resume and
 * epoch laws remain load-bearing; tm8-ui additionally tracks hidden ancestors
 * and attach readiness so retained terminals activate reliably. `LiveTerminal`
 * mounts real xterm into the T0-2 host box. The mount is opt-in behind
 * `isLiveTerminalEnabled()` (`liveTerminalFlag.ts`) until the Frontend lane's
 * sessionId plumbing and the real seam land, so the fixture-driven chrome
 * this barrel already shipped stays the default.
 *
 * The stylesheet is imported by the barrel so any consumer that renders these
 * components gets their styles, with no bootstrap file to remember to edit.
 */
import '../styles/canvas-extra.css';
import './terminal.css';

export { AlwaysDark } from './AlwaysDark';
export { TerminalChromeStrip, StatusPill } from './TerminalChromeStrip';
export { TerminalHost, TERMINAL_PLACEHOLDER } from './TerminalHost';
export { LiveTerminal, type LiveTerminalHandle, type LiveTerminalProps } from './LiveTerminal';
export { isLiveTerminalEnabled } from './liveTerminalFlag';
export { ExitedFallback, StaleFallback, UnverifiedFallback } from './SessionFallback';
export { NeedsYouBanner } from './NeedsYouBanner';
export { ReservedToolbarSeam } from './ReservedToolbarSeam';
export {
  presentSession,
  presentationStyle,
  sessionStyle,
  type LivenessTone,
  type PresentationInput,
  type PresentationStyle,
  type SessionPresentation,
} from './session-presentation';
export { toSessionRow, type SessionRow } from './session-row';
export {
  createScriptedActivitySource,
  useTerminalActivity,
  useTerminalActivityMap,
  type ActivitySource,
  type ScriptedActivitySource,
} from './activity';
