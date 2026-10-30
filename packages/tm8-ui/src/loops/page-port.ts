/*
 * The loop page's view of PR5a's client (`./api`): the page calls the
 * LoopsClient as-is, so this module only names it for the page's files.
 */
export type {
  LoopAction, LoopRun, LoopRunSkipReason, LoopRunStatus, LoopView, LoopsClient as LoopPagePort,
} from './api';
export type { LoopEntityRef } from './use-entity-ref';
