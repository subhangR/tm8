/**
 * `@tm8/contract/workspace` — the Workspace runtime's pure core (Spec B §2–§5,
 * Spec D §2): state and command types, selectors, planners and `reduce`. The
 * window's dispatcher and the node's server-side apply both run THIS code, so
 * there is one implementation of the command semantics.
 *
 * A subpath, not the root barrel: names like `Result` and `Source` are
 * Workspace-local and must not collide with the contract's own.
 */
export * from './types.js';
export * from './selectors.js';
export * from './reduce.js';
export * as workspaceCommands from './commands/index.js';
export type { Plan, PlanContext, Planner } from './commands/shared.js';
