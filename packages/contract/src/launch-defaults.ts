/**
 * launch.defaults — what a launch loads when the launch sheet selects nothing
 * (integrated design 01a0d348 §5.1).
 *
 * Every `SpawnSelection` group is either absent (its edge-driven defaults) or
 * an exact set. The sheet pre-ticks the defaults so a person sees what an
 * untouched launch carries, and an untick is a visible removal. This read is
 * where the sheet learns them: the SAME loaders `execution.spawn` runs, in the
 * caller's RLS transaction, so the pre-ticked set and the spawned set cannot
 * drift apart.
 *
 * Lenient by design: a missing, deleted or unreadable teammate or subject
 * yields empty groups and a `warnings` line, never a refusal. Only
 * authorization refuses.
 */
import type { EntityId } from './contract.js';
import type { SelectionHeaderSource } from './selection-header.js';

/** Why an entity is a default of this launch. */
export type LaunchDefaultVia =
  /** The teammate `remembers` / `equips` it. */
  | 'teammate'
  /** One of the teammate's ancestors equips it. */
  | 'inherited'
  /** The launch's task `remembers` / `equips` it. */
  | 'task'
  /** The task links it by outgoing `relates_to` or incoming `attached_to`. */
  | 'linked'
  /** A file attached to the task. */
  | 'attached';

export interface LaunchDefaultItem {
  entityId: EntityId;
  kind: string;
  /** The label every list shows (`titleOf`). */
  title: string;
  via: LaunchDefaultVia;
  /**
   * The selection header's `whenToUse`, else its `summary`; null when the
   * header has neither. Graph content: render it as plain text.
   */
  headerText: string | null;
  /** Where `headerText` came from; a UI labels anything but `authored` as derived. */
  headerSource: SelectionHeaderSource | null;
}

export interface LaunchDefaultsGroup {
  /** In spawn order, at most `SPAWN_SELECTION_GROUP_LIMIT`. */
  items: LaunchDefaultItem[];
  /** How many defaults the group has; above `items.length` the group cannot be sent as an exact set. */
  total: number;
}

export interface LaunchDefaultsInput {
  /** The teammate the launch runs as. */
  teamMemberId: EntityId;
  /** The entity launched from: a task, or anything with one open derived task. */
  subjectId?: EntityId;
}

export interface LaunchDefaultsResult {
  memories: LaunchDefaultsGroup;
  skills: LaunchDefaultsGroup;
  references: LaunchDefaultsGroup;
  /** The task the subject resolved to; null when it has none yet (spawn would mint one). */
  taskId: EntityId | null;
  /** Why a group is emptier than asked: a teammate or subject that does not resolve. */
  warnings: string[];
}
