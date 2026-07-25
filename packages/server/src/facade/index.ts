/**
 * The facade block: the handler registry W2 implementations plug into, plus
 * the operation→input-schema table the frame validates with.
 *
 * Derived truth (EntityDetail assembly, capabilities, badges, PullState,
 * autoTabs, titles/tombstones) is computed server-side and lands HERE at W2 —
 * the contract's rule is that the client never derives, it renders (L3).
 * Nothing of it exists yet; this directory is currently the seam only.
 */
export { HandlerRegistry } from './registry.js';
export { INPUT_SCHEMAS, UNBOUND_COMMAND_OPERATIONS } from './input-schemas.js';
