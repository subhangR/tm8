import { CollabError, type OperationName } from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';

/** An honest 501 (DEV-13) for a loops.* row whose handler has not landed yet. */
function pending(operation: OperationName) {
  return async (): Promise<never> => {
    throw new CollabError('not_implemented', `operation ${operation} is not implemented on this node`);
  };
}

// Loops design 01a182d5 §4.1: every row is mounted; PR1 implements the definition
// and control ops, PR2 runNow and runs.*.
export function registerLoopHandlers(registry: HandlerRegistry, _deps: FacadeDeps): void {
  registry.registerAll({
    'loops.create': pending('loops.create'),
    'loops.update': pending('loops.update'),
    'loops.get': pending('loops.get'),
    'loops.list': pending('loops.list'),
    'loops.enable': pending('loops.enable'),
    'loops.disable': pending('loops.disable'),
    'loops.pause': pending('loops.pause'),
    'loops.resume': pending('loops.resume'),
    'loops.runNow': pending('loops.runNow'),
    'loops.runs.list': pending('loops.runs.list'),
    'loops.runs.get': pending('loops.runs.get'),
    'loops.runs.stop': pending('loops.runs.stop'),
    'loops.schedule.preview': pending('loops.schedule.preview'),
  });
}
