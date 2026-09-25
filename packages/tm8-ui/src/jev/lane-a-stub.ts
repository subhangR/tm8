/**
 * LOCAL STUB of lane A's Jev state interface — what JevEntryPoint, JevPanel
 * and BudgetMeter read. Deleted the moment lane A's hook publishes the real
 * shape; until then the components code against this, and the hook's return
 * value only has to be STRUCTURALLY assignable to it.
 */
import type { JevCost, LaunchSuggestGroup, ModelSuggestion } from '@tm8/contract';

import type { JevGroups, JevOverallState } from './useJevSuggestions';

/** The three groups whose ticks carry bytes and a budget. */
export type JevEntityGroup = 'memories' | 'skills' | 'references';
export const JEV_ENTITY_GROUPS: readonly JevEntityGroup[] = ['memories', 'skills', 'references'];

export type JevTickKindAll = 'memory' | 'skill' | 'reference';

/** One group's byte budget and what the CURRENT ticks take of it (frame included). */
export interface JevGroupMeter {
  budget: number | null;
  floor: number;
  usedBytes: number;
}

export type JevLedgerEntry =
  | { group: JevEntityGroup; at: number; added: readonly string[]; removed: readonly string[] }
  | { group: 'teammates'; at: number; teammateId: string; previousTeammateId: string | null }
  | { group: 'model'; at: number; model: ModelSuggestion };

export type JevApplyTarget = JevEntityGroup | 'teammates' | 'model';

export interface JevPanelSource {
  groups: JevGroups;
  state: JevOverallState;
  run: JevCost | null;
  askRefusal: string | null;
  ask(groups?: readonly LaunchSuggestGroup[]): void;
  retry(group: LaunchSuggestGroup): void;
  ticked: { readonly memory: readonly string[]; readonly skill: readonly string[]; readonly reference: readonly string[] };
  toggle(kind: JevTickKindAll, id: string): string | null;
  contextIndex: 'on' | 'off' | null;
  meter: Record<JevEntityGroup, JevGroupMeter | null>;
  applied: readonly JevLedgerEntry[];
  applyAll(): void;
  applyGroup(group: JevEntityGroup): void;
  applyTeammate(): void;
  applyModel(): void;
  undo(target: JevApplyTarget): void;
  undoAll(): void;
}
