/**
 * `src/terminal/` — terminal CHROME only (Phase 1).
 *
 * R9 keeps the byte stack a verbatim transplant: ptyTransport, writeScheduler,
 * visibilityDriver, xterm and the vendored pty-protocol arrive UNEDITED at
 * integration, and nothing in this directory may read, parse, or schedule a
 * byte. What lives here is the pixel-governed chrome (RULING A), the reserved
 * host box, the honest fallbacks, and the consumer-side activity port.
 *
 * The stylesheet is imported by the barrel so any consumer that renders these
 * components gets their styles, with no bootstrap file to remember to edit.
 */
import '../styles/canvas-extra.css';
import './terminal.css';

export { AlwaysDark } from './AlwaysDark';
export { TerminalChromeStrip, StatusPill } from './TerminalChromeStrip';
export { TerminalHost, TERMINAL_PLACEHOLDER } from './TerminalHost';
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
