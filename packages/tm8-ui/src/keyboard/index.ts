/**
 * `src/keyboard/` — the C6 contract (LLD §7, WLT §5.8).
 *
 * One controller, layered scopes, one chord machine. A focused terminal owns
 * the keyboard except the physical `Ctrl+Backquote` blur chord (L9).
 */

export {
  BINDINGS,
  BINDING_GROUPS,
  CHORD_LEAD,
  CHORD_LEADS,
  CHORD_WINDOW_MS,
  CREATE_LEAD,
  LAUNCH_KEYS,
  PIN_REF_PREFIX,
  LAYER_ORDER,
  LIST_LEAD,
  TAB_LEAD,
  bindingGroup,
  hasMod,
  hintFor,
  isAdvertised,
  isBrowserReserved,
  isTerminalBlurChord,
  isTerminalPasteChord,
  isTerminalToggleChord,
} from './contract';

export type { Binding, BindingGroup, LaunchKeyAction, KeyCommand, KeyInput, KeyLayer, KeyMatcher, Platform } from './contract';

export { createKeyboardController } from './controller';
export type {
  KeyRefusal,
  KeyResult,
  KeyboardContext,
  KeyboardController,
  KeyboardControllerOptions,
} from './controller';
