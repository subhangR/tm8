import type { ContextBudgets, EntitySuggestion, RankedEntityReason, SpawnSelectionGroup } from '@tm8/contract';
import { contextGroupFrameBytes } from '@tm8/prompt';

import { groupIds } from '../domain/launch-selection';
import type { LaunchSelection } from './useLaunchSelection';

/** Jev's answer per group, when it answered ok — the rows' bytes, the group's budget, the reasons. */
export type LaunchRanked = Partial<Record<SpawnSelectionGroup, EntitySuggestion>>;

/** What one group's meter shows. */
export interface GroupMeterFacts {
  /** How many the launch carries for the group. */
  count: number;
  /**
   * Bytes the launch's CURRENT set puts in the prompt: every id's
   * `promptBytes`, plus the group's `<context_index>` frame for an index
   * group while the index is on. Null when any id's bytes are unknown — the
   * meter then shows the count only, never an invented number.
   */
  usedBytes: number | null;
  /** The per-launch override, else Jev's budget, else `launch.defaults`'. Null: takes what the prompt has left; undefined: nobody said. */
  budget: number | null | undefined;
  budgetSource: 'override' | 'jev' | 'defaults' | null;
  contextIndex: 'on' | 'off' | null;
}

/**
 * THE METER'S FACTS FOR ONE GROUP (I7 UI). It measures what THIS LAUNCH
 * carries (the kept defaults and the additions, `groupIds`), not what Jev
 * proposed: an applied Jev group is an ordinary edit by then, and a proposal
 * nobody applied does not reach the prompt.
 *
 * Bytes come from Jev's ranked rows first (measured for this teammate and
 * harness), then `launch.defaults`. Null for a group whose defaults are not
 * read: its set is not known, so neither is its size.
 */
export function groupMeter(
  selection: LaunchSelection,
  group: SpawnSelectionGroup,
  ranked: EntitySuggestion | undefined,
  contextIndex: 'on' | 'off' | null,
  budgets: ContextBudgets | undefined,
): GroupMeterFacts | null {
  const defaults = selection.defaults[group];
  if (defaults.status !== 'ready' || selection.lock(group)) return null;
  const ids = groupIds(defaults, selection.edits[group]);
  const jevBytes = new Map((ranked?.items ?? []).map((item) => [item.entityId, item.promptBytes]));
  const known = selection.bytes[group].bytes;
  let entries = 0;
  let unknown = false;
  for (const id of ids) {
    const bytes = jevBytes.get(id) ?? known[id];
    if (bytes === undefined) unknown = true;
    else entries += bytes;
  }
  const frame = group !== 'memories' && contextIndex !== 'off' && ids.length > 0 ? contextGroupFrameBytes(group, ids.length) : 0;
  /* THE BUDGET THE LAUNCH CARRIES: this launch's override, else what
     `launch.defaults` read for the launch's own harness and profile, else
     Jev's (a Jev answer can predate a harness or profile change). */
  const override = budgets?.[group];
  const defaultsBudget = selection.bytes[group].budget;
  const [budget, budgetSource]: [number | null | undefined, GroupMeterFacts['budgetSource']] = override !== undefined
    ? [override, 'override']
    : defaultsBudget !== undefined
      ? [defaultsBudget, 'defaults']
      : ranked
        ? [ranked.budget, 'jev']
        : [undefined, null];
  return { count: ids.length, usedBytes: unknown ? null : entries + frame, budget, budgetSource, contextIndex };
}

/**
 * Why each default Jev left out is out, for the rows a person's Apply
 * actually removed — so an unticked default says "over budget" instead of
 * vanishing. A removal made by hand carries no Jev reason.
 */
export function appliedReasons(
  ranked: EntitySuggestion | undefined,
  removedByApply: readonly string[] | undefined,
  selection: LaunchSelection,
  group: SpawnSelectionGroup,
): Readonly<Record<string, RankedEntityReason>> {
  if (!ranked || !removedByApply?.length) return {};
  const stillRemoved = new Set<string>(selection.edits[group].removed);
  const out: Record<string, RankedEntityReason> = {};
  for (const item of ranked.items) {
    if (item.reason && removedByApply.includes(item.entityId) && stillRemoved.has(item.entityId)) out[item.entityId] = item.reason;
  }
  return out;
}

export const REASON_WORDS: Readonly<Record<RankedEntityReason, string>> = {
  'over-budget': 'over budget',
  'below-floor': 'below Jev’s floor',
};
