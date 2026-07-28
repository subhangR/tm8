/**
 * `src/keyboard/` — the C6 contract (LLD §7, WLT §5.8).
 *
 * One controller, layered scopes, one chord machine. A focused terminal owns
 * the keyboard except the physical `Ctrl+Backquote` blur chord (L9).
 */

export {
  BINDINGS,
  CHORD_LEAD,
  CHORD_WINDOW_MS,
  LAYER_ORDER,
  hasMod,
  isAdvertised,
  isBrowserReserved,
  isTerminalBlurChord,
} from './contract';

export type { Binding, KeyCommand, KeyInput, KeyLayer, KeyMatcher, Platform } from './contract';

export { createKeyboardController } from './controller';
export type {
  KeyRefusal,
  KeyResult,
  KeyboardContext,
  KeyboardController,
  KeyboardControllerOptions,
} from './controller';
