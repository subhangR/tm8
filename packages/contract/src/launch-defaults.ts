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
   * memory's, a skill's (measured as indexed, not native) or a reference's
   * `<context_index>` entry. A file is 0: files are never index entries, they
   * ride in `<attachments>`.
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
  /**
   * The COUNT of entries the launch's index budget never shrinks this group
   * below when groups compete for room (`contextIndexMinEntries`): 1 for
   * every group. Only when even the minimums do not fit do
   * groups give way, lowest tier first (`CONTEXT_INDEX_GIVE_WAY_ORDER`). Not
   * `floor`, which is Jev's relevance-score floor.
   */
  minEntries: number;
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
  /**
   * `selection.teammateIds`' defaults: the teammates the launch's task links
   * (`relates_to` / `attached_to`), the launch teammate excluded — empty for
   * most worker launches. Budget: `contextBudgets.teammates` when the
   * profile sets one; null when it does not (a worker's teammates then share
   * the references cap) and while the index is off (teammates are then not
   * in the prompt). Floor: `contextFloors.teammates`.
   */
  teammates: LaunchDefaultsGroup;
  /** The task the subject resolved to; null when it has none yet (spawn would mint one). */
  taskId: EntityId | null;
  /**
   * Whether the launch renders `<context_index>`: always `on` (launch card v3,
   * owner answer `index_always`). `TM8_CONTEXT_INDEX` and a profile's
   * `contextIndex` no longer turn it off; the `off` member stays in the type
   * for back-compat only and is never served.
   */
  contextIndex: 'on' | 'off';
  /**
   * Bytes the title row may send in full (launch card v3, decision 1): the
   * subject's `<task>` plus every `inFullIds` entry. A fixed share of
   * `launchCapBytes`. Past it spawn refuses `payload_too_large` /
   * `in_full_budget`; a subject alone past it goes to reference mode instead.
   */
  inFullBudgetBytes: number;
  /**
   * The whole initial injection's hard cap (`combinedInitialInjection`,
   * 32768 today). Past it spawn refuses `payload_too_large` / `launch_total`.
   */
  launchCapBytes: number;
  /**
   * Why a group is emptier than asked (a teammate or subject that does not
   * resolve), or why budgets are the node defaults (a profile that does not).
   */
  warnings: string[];
}
