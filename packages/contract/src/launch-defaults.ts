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
 *
 * THE METER WITHOUT ASK JEV (design 01a0d348 §10 Q5). Every item carries its
 * `promptBytes` and every group its `budget` and `floor`, measured and
 * resolved exactly as `launch.suggest` does (`jev/measure.ts`, `groupRules`)
 * under the same Interaction Profile and `<context_index>` switch — one
 * measurement, two readers — so the sheet can show what the defaults cost
 * before anyone asks Jev.
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
  /**
   * Bytes this default adds to the launch prompt, measured with spawn's
   * serializers — the same number `launch.suggest` gives the same entity. A
   * memory's whole `<entry>`; a skill's `<context_index>` entry (its
   * `<skills>` line while the index is off), measured as indexed, not native;
   * a reference's entry, 0 while the index is off.
   */
  promptBytes: number;
}

export interface LaunchDefaultsGroup {
  /** In spawn order, at most `SPAWN_SELECTION_GROUP_LIMIT`. */
  items: LaunchDefaultItem[];
  /** How many defaults the group has; above `items.length` the group cannot be sent as an exact set. */
  total: number;
  /**
   * Bytes the group may take in the prompt: the profile's `contextBudgets`,
   * else the node default; for skills and references it covers the group's
   * frame too. Null: no budget of its own (skills, unless the profile caps
   * them; references while the index is off). As `EntitySuggestion.budget`.
   */
  budget: number | null;
  /** The profile's `contextFloors` for the group, else the node default. */
  floor: number;
}

export interface LaunchDefaultsInput {
  /** The teammate the launch runs as. */
  teamMemberId: EntityId;
  /** The entity launched from: a task, or anything with one open derived task. */
  subjectId?: EntityId;
  /** The Interaction Profile the launch will pin, whose budgets and floors apply. Absent: the one spawn would resolve. */
  interactionProfileId?: EntityId;
  /** The harness the launch runs (a skill's bytes depend on it). Absent: the teammate's own, else `claude-code`. */
  agentTool?: 'claude-code' | 'codex';
}

export interface LaunchDefaultsResult {
  memories: LaunchDefaultsGroup;
  skills: LaunchDefaultsGroup;
  references: LaunchDefaultsGroup;
  /** The task the subject resolved to; null when it has none yet (spawn would mint one). */
  taskId: EntityId | null;
  /**
   * Whether the launch renders `<context_index>` (the node's
   * `TM8_CONTEXT_INDEX`, else the profile's `contextIndex`). `off`: references
   * are not in the prompt (their `promptBytes` are 0) and memory bytes are
   * still real.
   */
  contextIndex: 'on' | 'off';
  /**
   * Why a group is emptier than asked (a teammate or subject that does not
   * resolve), or why budgets are the node defaults (a profile that does not).
   */
  warnings: string[];
}
