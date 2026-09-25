import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollabError,
  LAUNCH_SUGGEST_GROUPS,
  SPAWN_SELECTION_GROUP_LIMIT,
  type ContextBudgets,
  type EntityId,
  type EntitySuggestion,
  type JevAgentTool,
  type JevCost,
  type JevFailure,
  type JevGroupResult,
  type JevSkipReason,
  type LaunchReasoningEffort,
  type LaunchSuggestDraft,
  type LaunchSuggestGroup,
  type LaunchSuggestInput,
  type ModelSuggestion,
  type RankedEntity,
  type SpawnSelectionDefaultReason,
  type SpawnSelectionGroup,
  type TeammateSuggestion,
} from '@tm8/contract';
import { contextGroupFrameBytes } from '@tm8/prompt';

import {
  jevContextRow,
  jevGroupDiff,
  jevGroupEdit,
  restoreRows,
  type GroupOutcome,
  type LaunchContextRow,
  type LaunchGroupEdit,
  type LaunchSelectionDefaults,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';
import type { JevPort } from './port';

/**
 * useJevSuggestions — the one hook behind Ask Jev on LaunchSheet AND the Run
 * popup (design 01a0cb80 §3, §7.5; Jev UX lane A). Both surfaces render the
 * same state and send the same request.
 *
 * WHAT IT OWNS:
 *   · `runId`, minted once per mount — one sheet or popup is one run, and every
 *     press or re-ask while it stays open is costed to it.
 *   · a state per group (model, teammates, memories, skills, references),
 *     independently: one group failing never touches another, and each can be
 *     retried alone.
 *   · Jev's TICKS for memories, skills and references, seeded from `suggested`
 *     in rank order. Ticks are Jev's proposal, NOT the launch's selection.
 *   · the APPLY actions and the `applied` ledger. Applying a group writes Jev's
 *     ticks into that group's ordinary `LaunchGroupEdit` through the host;
 *     applying the teammate or the model calls the host's setter. Each has an
 *     undo. From there the ordinary per-group send carries it.
 *
 * WHAT IT NEVER DOES: apply anything by itself. Jev only suggests (rule 1). An
 * answer — including the re-ask a teammate change triggers — only reseeds the
 * ticks; the launch changes only on an Apply click.
 */

export type JevGroupState<T> =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'ok'; value: T; cost: JevCost }
  | { status: 'failed'; reason: JevFailure; cost: JevCost }
  | { status: 'skipped'; reason: JevSkipReason; cost: JevCost };

export interface JevGroupValues {
  model: ModelSuggestion;
  teammates: TeammateSuggestion;
  memories: EntitySuggestion;
  skills: EntitySuggestion;
  references: EntitySuggestion;
}

export type JevGroups = { [G in LaunchSuggestGroup]: JevGroupState<JevGroupValues[G]> };

export type JevOverallState = 'idle' | 'asking' | 'ready' | 'stale' | 'unavailable';

/** The three groups Jev ticks — exactly the `SpawnSelection` groups. */
export type JevEntityGroup = Extract<SpawnSelectionGroup, 'memories' | 'skills' | 'references'>;
export const JEV_ENTITY_GROUPS: readonly JevEntityGroup[] = ['memories', 'skills', 'references'];

/** What Apply can target. */
export type JevApplyTarget = JevEntityGroup | 'teammate' | 'model';

/** The launch's model, tool and effort — the three Apply sets together. */
export interface JevModelChoice {
  model: string;
  agentToolId: string;
  reasoningEffort: LaunchReasoningEffort | null;
}

/**
 * The surface's launch state, which Apply writes and Undo restores. Read at
 * ACTION time (it may be a fresh object every render). Every member is
 * optional in effect: a surface without one gets that Apply refused with a
 * reason, never a silent no-op.
 */
export interface JevApplyHost {
  /** `useLaunchSelection().defaults` — an Apply to a locked group is refused. */
  defaults: LaunchSelectionDefaults;
  /** `useLaunchSelection().edits`. */
  edits: LaunchSelectionEdits;
  /**
   * Replace one group's edit (`useLaunchSelection().setEdit`). `rows` carries
   * the display row of every id the edit ADDS that the sheet may not know
   * yet, so a Jev-added row keeps its title while it is ticked. Returns a
   * refusal (the group is locked) or null; a refused Apply is not recorded.
   */
  setEdit(group: JevEntityGroup, edit: LaunchGroupEdit, rows?: readonly LaunchContextRow[]): string | null | void;
  /** Absent: the surface's teammate is fixed, and applyTeammate is refused. */
  setTeammate?(teamMemberId: string): void;
  /** The launch's current model choice; absent means applyModel is refused. */
  model?: JevModelChoice | null;
  setModel?(choice: JevModelChoice): void;
  /** Why this surface cannot run Jev's model (`modelApplyRefusal`); null when it can. */
  modelRefusal?(suggestion: ModelSuggestion): string | null;
}

/** One row of a ticked group, in Jev's rank order. Graph content: render title and header as plain text. */
export interface JevRow extends RankedEntity {
  /** Jev's current tick (the proposal), not the launch's state. */
  ticked: boolean;
}

/** One ticked group's applied record. */
export interface JevAppliedGroup {
  /** `now()` at the click. */
  at: number;
  /** Non-defaults Apply ticked, in rank order. */
  added: readonly EntityId[];
  /** Defaults Apply left unticked. */
  removed: readonly EntityId[];
  /** The ticks applied, in rank order. */
  ticks: readonly EntityId[];
  /** Every row Apply decided — what Undo restores. */
  touched: readonly EntityId[];
  /** The group's edit just before the Apply. */
  before: LaunchGroupEdit;
  /** The answer (requestId) the ticks came from. */
  requestId: string;
}

export interface JevAppliedTeammate {
  at: number;
  teamMemberId: string;
  /** The teammate before the Apply; null when there was none (then Undo is refused). */
  previous: string | null;
}

export interface JevAppliedModel {
  at: number;
  value: JevModelChoice;
  previous: JevModelChoice | null;
}

/** What was applied and when. An entry is removed by its Undo. */
export interface JevAppliedLedger {
  memories?: JevAppliedGroup;
  skills?: JevAppliedGroup;
  references?: JevAppliedGroup;
  teammate?: JevAppliedTeammate;
  model?: JevAppliedModel;
}

/** The view model a ticked group renders from. */
export interface JevEntityGroupView {
  group: JevEntityGroup;
  state: JevGroupState<EntitySuggestion>;
  /** Every ranked row, rank order; [] until the group answers ok. */
  rows: readonly JevRow[];
  /** Jev's ticked ids, rank order (then any the person ticked, in tick order). */
  ticked: readonly EntityId[];
  /** Bytes the group may take: the per-launch override, else Jev's (`EntitySuggestion.budget`). Null: no budget of its own. */
  budget: number | null;
  budgetSource: 'override' | 'jev' | null;
  /** Jev's floor for the group; null until it answers. */
  floor: number | null;
  /** Bytes the CURRENT ticks put in the prompt: Σ promptBytes, plus the group frame for an index group when the index is on. */
  usedBytes: number;
  /** The frame part of `usedBytes` (0 for memories, with no ticks, or with the index off). */
  frameBytes: number;
  /** `usedBytes > budget`. */
  overBudget: boolean;
  /** The context index as the answer reported it; null until the group answers. */
  contextIndex: 'on' | 'off' | null;
  /** False for references while the context index is off: their bytes are not in the prompt. */
  inPrompt: boolean;
  /** What Apply would write, as a diff against the defaults (`jevGroupDiff`). */
  proposal: LaunchGroupEdit;
  /** Why Apply is refused; null when it may be pressed. */
  applyRefusal: string | null;
  applied: JevAppliedGroup | null;
  /** The applied entry came from THIS answer with THESE ticks; false after a re-ask or a re-tick. */
  appliedIsCurrent: boolean;
}

export interface JevApplyReport {
  applied: readonly JevApplyTarget[];
  /** Targets not applied, and why (refused, not answered, or ranked for a teammate this Apply changed). */
  skipped: Partial<Record<JevApplyTarget, string>>;
}

export interface JevSpawnFields {
  /** Why a group Jev was asked about, and that was never applied, launches on its defaults. */
  defaultReasons?: Partial<Record<JevEntityGroup, SpawnSelectionDefaultReason>>;
  jevRunId?: EntityId;
  /** @deprecated Jev mode is retired: never set. Kept so un-migrated callers compile. */
  groups?: Partial<Record<JevEntityGroup, GroupOutcome>>;
}

/** @deprecated The two kinds the old checklists toggled by. Use a `JevEntityGroup`. */
export type JevTickKind = 'memory' | 'skill';

export interface JevSuggestions {
  runId: string;
  groups: JevGroups;
  state: JevOverallState;
  /** The whole run's cost, from the latest answer. Null until one arrives. */
  run: JevCost | null;
  /** Why Ask Jev cannot be pressed on this surface; null when it can. */
  askRefusal: string | null;
  /** `ask()` sends all five groups; `ask(groups)` a subset. */
  ask(groups?: readonly LaunchSuggestGroup[]): void;
  retry(group: LaunchSuggestGroup): void;

  /** The context index of the latest answer; null before one. */
  contextIndex: 'on' | 'off' | null;
  /** Per ticked group: rows, ticks, budget, used bytes, proposal, applied state. */
  entity: Readonly<Record<JevEntityGroup, JevEntityGroupView>>;
  /** Flip Jev's tick on one row. Returns the refusal (the per-group ceiling) or null. */
  toggle(group: JevEntityGroup | JevTickKind, id: string): string | null;
  /** The last refused tick, so a row can say why. */
  tickRefusal: {
    group: JevEntityGroup;
    id: string;
    reason: string;
    /** @deprecated The old kind name, for un-migrated checklists; null for references. */
    kind: JevTickKind | null;
  } | null;

  /** Jev's top teammate that fits; null when none, not answered, or `noFit`. */
  teammatePick: RankedEntity | null;
  /** Why applyTeammate is refused; null when it may be pressed. */
  teammateRefusal: string | null;
  /** Why applyModel is refused; null when it may be pressed. */
  modelRefusal: string | null;
  /** The launch's model already is Jev's (model, tool and effort). */
  modelMatches: boolean;

  applied: JevAppliedLedger;
  applyGroup(group: JevEntityGroup): string | null;
  /** Apply Jev's top teammate, or `teamMemberId` from its ranks. */
  applyTeammate(teamMemberId?: string): string | null;
  applyModel(): string | null;
  /** Apply everything applicable. Groups ranked for a teammate this call changes are skipped — they re-ask. */
  applyAll(): JevApplyReport;
  /** Each returns the refusal, or null once undone. */
  undo(target: JevApplyTarget): string | null;
  /** Undo what the last applyAll applied, still standing. */
  undoAll(): void;

  toSpawnFields(): JevSpawnFields;

  /** @deprecated Always false: Jev mode is retired, Apply replaces it. */
  jevMode: false;
  /** @deprecated Always null. */
  launchNote: null;
  /** @deprecated Memories and skills ticks by the old kind names. */
  ticked: { readonly memory: readonly string[]; readonly skill: readonly string[] };
  /** @deprecated Reseeds nothing; clears Jev's ticks. */
  reset(): void;
}

/** Every group said `no_key`: neither this member nor this node has a TypeSafe key. */
export const JEV_UNAVAILABLE_COPY = 'Ask Jev needs a TypeSafe key, and none is saved for you.';
export const JEV_ADD_KEY_COPY = 'Add yours in Settings → Agent credentials';
export const JEV_UNWIRED_REASON = 'Jev isn’t wired on this surface, so there is nobody to ask.';
export const JEV_NO_HOST_REASON = 'This surface can’t take Jev’s picks yet — tick them yourself.';
export const JEV_NOT_ANSWERED_REASON = 'Jev hasn’t answered this group yet — ask, then apply.';
export const JEV_TEAMMATE_FIXED_REASON = 'The teammate is fixed on this surface.';
export const JEV_NO_FIT_REASON = 'Jev found no teammate that fits this work — pick one yourself.';
export const JEV_CANT_UNDO_TEAMMATE = 'There was no teammate before this Apply to go back to — pick one.';
export const JEV_TEAMMATE_CHANGED_REASON = 'Ranked for the previous teammate — Jev is re-asking; apply once it answers.';
export const TICK_CEILING_REASON =
  `A launch names at most ${String(SPAWN_SELECTION_GROUP_LIMIT)} per group — untick one before ticking another.`;
/** @deprecated The 32-memory limit is gone; the byte budget is the real limit. */
export const MEMORY_LIMIT_REASON = TICK_CEILING_REASON;

/** What the meter's tooltip says about a skill's bytes (lane B renders it). */
export const SKILL_BYTES_NOTE = 'A skill’s bytes assume it is indexed, not native — whether it is native depends on the launch’s workdir.';
/** What a references group says while the context index is off. */
export const REFERENCES_OFF_NOTE = 'Not in the prompt while the context index is off.';

const IDLE: JevGroups = {
  model: { status: 'idle' },
  teammates: { status: 'idle' },
  memories: { status: 'idle' },
  skills: { status: 'idle' },
  references: { status: 'idle' },
};

const NO_TICKS: Record<JevEntityGroup, EntityId[]> = { memories: [], skills: [], references: [] };

const ZERO_COST: JevCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 };

/** The groups a teammate change invalidates: all three are ranked FOR the teammate (its defaults included). */
const TEAMMATE_DEPENDENT: readonly LaunchSuggestGroup[] = ['memories', 'skills', 'references'];

const KIND_GROUP: Record<JevTickKind, JevEntityGroup> = { memory: 'memories', skill: 'skills' };

export function newJevId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 v4 shape from Math.random — only reached where crypto is absent.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
  });
}

/**
 * A thrown request is not a Jev answer, so it becomes a per-group failure the
 * sheet can show and retry. A node that predates the handler (501) is the same
 * fact to the viewer as a node without a key: Jev is not available here.
 */
function failureOf(error: unknown): JevFailure {
  if (error instanceof CollabError || (error as { code?: unknown })?.code !== undefined) {
    const code = (error as { code?: unknown }).code;
    if (code === 'not_implemented') return 'no_key';
    if (code === 'rate_limited') return 'rate_limited';
    if (code === 'upstream_unavailable') return 'overloaded';
    return 'http_error';
  }
  return 'network';
}

function draftKey(draft: LaunchSuggestDraft | undefined): string {
  return draft ? `${draft.title}\u0000${draft.description}` : '';
}

/** Rows in rank order: score descending, the server's order breaking ties. */
function ranked(items: readonly RankedEntity[]): RankedEntity[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .map(({ item }) => item);
}

/** Suggested ids in rank order, at most the per-group ceiling. */
export function seedTicks(result: EntitySuggestion): EntityId[] {
  return ranked(result.items)
    .filter((item) => item.suggested)
    .map((item) => item.entityId as EntityId)
    .slice(0, SPAWN_SELECTION_GROUP_LIMIT);
}

/**
 * Bytes a set of ticks puts in the prompt. Memories are whole `<entry>`s with
 * no frame; skills and references also pay their `<group>` frame, but only
 * when the index is on (off, a skill is a `<skills>` line and a reference a
 * linked name, and `promptBytes` already says so).
 */
export function usedBytesOf(
  group: JevEntityGroup,
  result: EntitySuggestion,
  ticked: readonly string[],
  contextIndex: 'on' | 'off',
): { used: number; frame: number } {
  const bytes = new Map(result.items.map((item) => [item.entityId, item.promptBytes]));
  const entries = ticked.reduce((sum, id) => sum + (bytes.get(id) ?? 0), 0);
  const frame = group !== 'memories' && contextIndex === 'on' && ticked.length > 0
    ? contextGroupFrameBytes(group, ticked.length)
    : 0;
  return { used: entries + frame, frame };
}

export { jevContextRow };

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameModel(a: JevModelChoice | null | undefined, s: ModelSuggestion): boolean {
  return Boolean(a) && a?.model === s.model && a?.agentToolId === s.agentTool && a?.reasoningEffort === s.effort;
}

function topTeammate(state: JevGroupState<TeammateSuggestion>): RankedEntity | null {
  if (state.status !== 'ok' || state.value.noFit) return null;
  return ranked(state.value.items).find((item) => item.suggested) ?? null;
}

export function useJevSuggestions(args: {
  port?: JevPort | null;
  spaceId: string;
  subjectId: string;
  /** The teammate the launch runs as; memories, skills and references are ranked for it. */
  teammateId?: string | null;
  /** The Run popup's LIVE title and description. Absent: the saved subject. */
  draft?: LaunchSuggestDraft;
  /** The harness the launch runs, which decides how a skill's entry reads. */
  agentTool?: JevAgentTool;
  /** Where Apply writes. Absent: every Apply is refused with a reason. */
  host?: JevApplyHost | null;
  /** The launch's per-launch budget override, shown in place of Jev's budget. */
  contextBudgets?: ContextBudgets | null;
  /** The ledger's clock. Default `Date.now`. */
  now?: () => number;
}): JevSuggestions {
  const { port, spaceId, subjectId, teammateId, draft, agentTool, host, contextBudgets } = args;

  // One run per mount. `useState`'s initializer runs once, so this is stable.
  const [runId] = useState(newJevId);
  const [groups, setGroups] = useState<JevGroups>(IDLE);
  const [run, setRun] = useState<JevCost | null>(null);
  const [asked, setAsked] = useState(false);
  const [askedDraft, setAskedDraft] = useState('');
  const [ticks, setTicks] = useState<Record<JevEntityGroup, EntityId[]>>(NO_TICKS);
  /** Which request produced each group's current answer, and its context index. */
  const [answers, setAnswers] = useState<Partial<Record<JevEntityGroup, { requestId: string; contextIndex: 'on' | 'off' }>>>({});
  const [contextIndex, setContextIndex] = useState<'on' | 'off' | null>(null);
  const [tickRefusal, setTickRefusal] = useState<JevSuggestions['tickRefusal']>(null);
  const [applied, setApplied] = useState<JevAppliedLedger>({});
  const [lastAll, setLastAll] = useState<readonly JevApplyTarget[]>([]);

  /* The request inputs and the host, read at ACTION time rather than
     captured: a press sends what the surface shows at that moment, and the
     actions stay referentially stable. */
  const live = useRef({ port, spaceId, subjectId, teammateId, draft, agentTool, host, now: args.now ?? Date.now });
  live.current = { port, spaceId, subjectId, teammateId, draft, agentTool, host, now: args.now ?? Date.now };

  /* Which request each group's answer must come from. A slower, older answer
     that lands after a re-ask is dropped per group, never merged over the new. */
  const latest = useRef<Partial<Record<LaunchSuggestGroup, string>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const askRefusal = !port
    ? JEV_UNWIRED_REASON
    : !subjectId
      ? 'There is no subject to ask Jev about.'
      : null;

  const ask = useCallback((requested?: readonly LaunchSuggestGroup[]) => {
    const { port: p, spaceId: space, subjectId: subject, teammateId: teammate, draft: text, agentTool: tool } = live.current;
    if (!p || !subject) return;
    const list = [...new Set(requested && requested.length > 0 ? requested : LAUNCH_SUGGEST_GROUPS)];
    const requestId = newJevId();
    for (const group of list) latest.current[group] = requestId;

    const input: LaunchSuggestInput = {
      runId,
      requestId,
      subjectId: subject,
      groups: list,
      ...(text ? { draft: { title: text.title, description: text.description } } : {}),
      ...(teammate ? { teamMemberId: teammate } : {}),
      ...(tool ? { agentTool: tool } : {}),
    };

    setAsked(true);
    setAskedDraft(draftKey(text));
    setGroups((current) => {
      const next = { ...current };
      for (const group of list) (next as Record<string, unknown>)[group] = { status: 'asking' };
      return next;
    });

    const settle = (
      answer: (group: LaunchSuggestGroup) => JevGroupResult<unknown> | undefined,
      index: 'on' | 'off' | null,
    ) => {
      if (!mounted.current) return;
      const landed = list.filter((group) => latest.current[group] === requestId);
      if (landed.length === 0) return;
      const results = new Map(landed.map((group) => [group, answer(group)] as const));
      setGroups((current) => {
        const next = { ...current };
        for (const [group, result] of results) {
          // A group the server left out of its answer is a server fault, said as one.
          (next as Record<string, unknown>)[group] = result
            ?? { status: 'failed', reason: 'unparsed', cost: ZERO_COST };
        }
        return next;
      });
      if (index) setContextIndex(index);
      /* An answer only RESEEDS Jev's ticks. The launch's edits — and anything
         applied from an earlier answer — are untouched until the next click. */
      setTicks((current) => {
        const next = { ...current };
        for (const group of JEV_ENTITY_GROUPS) {
          if (!results.has(group)) continue;
          const result = results.get(group);
          next[group] = result?.status === 'ok' ? seedTicks(result.value as EntitySuggestion) : [];
        }
        return next;
      });
      setAnswers((current) => {
        const next = { ...current };
        for (const group of JEV_ENTITY_GROUPS) {
          if (!results.has(group)) continue;
          if (results.get(group)?.status === 'ok' && index) next[group] = { requestId, contextIndex: index };
          else delete next[group];
        }
        return next;
      });
      setTickRefusal(null);
    };

    p.suggest(space, input).then(
      (result) => {
        if (!mounted.current) return;
        // `run` is the server's running total; the larger answer is the later one.
        setRun((current) => (current && current.calls > result.run.calls ? current : result.run));
        settle((group) => result.groups[group] as JevGroupResult<unknown> | undefined, result.contextIndex);
      },
      (error: unknown) => {
        const reason = failureOf(error);
        settle(() => ({ status: 'failed', reason, cost: ZERO_COST }), null);
      },
    );
  }, [runId]);

  const retry = useCallback((group: LaunchSuggestGroup) => { ask([group]); }, [ask]);

  /* TEAMMATE CHANGE after an answer re-asks the three ticked groups — each is
     ranked FOR the teammate — in the same run, with a new requestId. It never
     re-applies: whatever was applied stays as it was, now marked as from an
     earlier answer, until the person applies again. */
  const lastTeammate = useRef(teammateId);
  const dependentAsked = TEAMMATE_DEPENDENT.some((group) => groups[group].status !== 'idle');
  useEffect(() => {
    if (lastTeammate.current === teammateId) return;
    lastTeammate.current = teammateId;
    if (dependentAsked) ask(TEAMMATE_DEPENDENT);
  }, [teammateId, dependentAsked, ask]);

  const toggle = useCallback((which: JevEntityGroup | JevTickKind, id: string): string | null => {
    const group = which in KIND_GROUP ? KIND_GROUP[which as JevTickKind] : which as JevEntityGroup;
    const current = ticks[group];
    if (!current.includes(id as EntityId) && current.length >= SPAWN_SELECTION_GROUP_LIMIT) {
      const kind = group === 'memories' ? 'memory' : group === 'skills' ? 'skill' : null;
      setTickRefusal({ group, id, reason: TICK_CEILING_REASON, kind });
      return TICK_CEILING_REASON;
    }
    setTicks((all) => ({
      ...all,
      [group]: all[group].includes(id as EntityId) ? all[group].filter((x) => x !== id) : [...all[group], id as EntityId],
    }));
    setTickRefusal(null);
    return null;
  }, [ticks]);

  const reset = useCallback(() => {
    setTicks(NO_TICKS);
    setTickRefusal(null);
  }, []);

  const state = useMemo<JevOverallState>(() => {
    const touched = LAUNCH_SUGGEST_GROUPS.filter((group) => groups[group].status !== 'idle');
    if (touched.length === 0) return 'idle';
    if (touched.some((group) => groups[group].status === 'asking')) return 'asking';
    if (touched.every((group) => {
      const g = groups[group];
      return g.status === 'failed' && g.reason === 'no_key';
    })) return 'unavailable';
    if (draftKey(draft) !== askedDraft) return 'stale';
    return 'ready';
  }, [groups, draft, askedDraft]);

  /* ---------------------------------------------------------------- views */

  const entity = useMemo(() => {
    const out = {} as Record<JevEntityGroup, JevEntityGroupView>;
    for (const group of JEV_ENTITY_GROUPS) {
      const g = groups[group];
      const value = g.status === 'ok' ? g.value : null;
      const index = answers[group]?.contextIndex ?? null;
      const ticked = value ? ticks[group] : [];
      const on = new Set<string>(ticked);
      const rows: JevRow[] = value ? ranked(value.items).map((item) => ({ ...item, ticked: on.has(item.entityId) })) : [];
      const override = contextBudgets?.[group];
      const budget = override ?? value?.budget ?? null;
      const { used, frame } = value && index ? usedBytesOf(group, value, ticked, index) : { used: 0, frame: 0 };
      const proposal = jevGroupDiff(rows.map((row) => ({ id: row.entityId as EntityId, isDefault: row.default })), ticked);
      const entry = applied[group] ?? null;
      let applyRefusal: string | null = null;
      if (!value) applyRefusal = JEV_NOT_ANSWERED_REASON;
      else if (!host) applyRefusal = JEV_NO_HOST_REASON;
      else applyRefusal = jevGroupEdit(host.defaults[group], host.edits[group], { items: rows, ticked }).refusal;
      out[group] = {
        group,
        state: g,
        rows,
        ticked,
        budget,
        budgetSource: override !== undefined ? 'override' : value?.budget != null ? 'jev' : null,
        floor: value?.floor ?? null,
        usedBytes: used,
        frameBytes: frame,
        overBudget: budget !== null && used > budget,
        contextIndex: index,
        inPrompt: !(group === 'references' && index === 'off'),
        proposal,
        applyRefusal,
        applied: entry,
        appliedIsCurrent: entry !== null
          && entry.requestId === answers[group]?.requestId
          && sameIds(entry.ticks, ticked),
      };
    }
    return out;
  }, [groups, answers, ticks, contextBudgets, applied, host]);

  const teammatePick = topTeammate(groups.teammates);
  const teammateRefusal = groups.teammates.status !== 'ok'
    ? JEV_NOT_ANSWERED_REASON
    : !teammatePick
      ? JEV_NO_FIT_REASON
      : !host?.setTeammate
        ? JEV_TEAMMATE_FIXED_REASON
        : null;
  const modelSuggestion = groups.model.status === 'ok' ? groups.model.value : null;
  const modelRefusal = !modelSuggestion
    ? JEV_NOT_ANSWERED_REASON
    : !host?.setModel || host.model === undefined
      ? JEV_NO_HOST_REASON
      : host.modelRefusal?.(modelSuggestion) ?? null;
  const modelMatches = Boolean(modelSuggestion) && sameModel(host?.model, modelSuggestion as ModelSuggestion);

  /* --------------------------------------------------------------- actions */

  /* The actions read the view through a ref so each click acts on what the
     person saw at that render, and the functions stay stable. */
  const view = useRef({ entity, teammatePick, teammateRefusal, modelSuggestion, modelRefusal, applied });
  view.current = { entity, teammatePick, teammateRefusal, modelSuggestion, modelRefusal, applied };

  const applyGroup = useCallback((group: JevEntityGroup): string | null => {
    const { host: h, now } = live.current;
    const g = view.current.entity[group];
    if (g.applyRefusal || !h) return g.applyRefusal ?? JEV_NO_HOST_REASON;
    const before = h.edits[group];
    const result = jevGroupEdit(h.defaults[group], before, { items: g.rows, ticked: g.ticked });
    if (result.refusal) return result.refusal;
    const refused = h.setEdit(group, result.edit, result.rows);
    if (typeof refused === 'string') return refused;
    const entry: JevAppliedGroup = {
      at: now(),
      added: result.diff.added,
      removed: result.diff.removed,
      ticks: g.ticked,
      touched: result.touched,
      // A re-Apply keeps the ORIGINAL before, so Undo returns to the pre-Jev launch.
      before: view.current.applied[group]?.before ?? before,
      requestId: answers[group]?.requestId ?? '',
    };
    setApplied((current) => ({ ...current, [group]: entry }));
    return null;
  }, [answers]);

  const applyTeammate = useCallback((teamMemberId?: string): string | null => {
    const { host: h, now, teammateId: current } = live.current;
    const { teammatePick: pick, teammateRefusal: refusal } = view.current;
    const target = teamMemberId ?? pick?.entityId;
    if (teamMemberId === undefined && refusal) return refusal;
    if (!h?.setTeammate) return JEV_TEAMMATE_FIXED_REASON;
    if (!target) return JEV_NO_FIT_REASON;
    h.setTeammate(target);
    setApplied((ledger) => ({
      ...ledger,
      teammate: { at: now(), teamMemberId: target, previous: ledger.teammate?.previous ?? current ?? null },
    }));
    return null;
  }, []);

  const applyModel = useCallback((): string | null => {
    const { host: h, now } = live.current;
    const { modelSuggestion: s, modelRefusal: refusal } = view.current;
    if (refusal || !s || !h?.setModel) return refusal ?? JEV_NO_HOST_REASON;
    const value: JevModelChoice = { model: s.model, agentToolId: s.agentTool, reasoningEffort: s.effort };
    const previous = h.model ?? null;
    h.setModel(value);
    setApplied((ledger) => ({ ...ledger, model: { at: now(), value, previous: ledger.model?.previous ?? previous } }));
    return null;
  }, []);

  const undo = useCallback((target: JevApplyTarget): string | null => {
    const { host: h } = live.current;
    const entry = view.current.applied[target];
    if (!entry) return 'Nothing of Jev’s is applied here.';
    if (!h) return JEV_NO_HOST_REASON;
    if (target === 'teammate') {
      const t = entry as JevAppliedTeammate;
      if (!t.previous || !h.setTeammate) return JEV_CANT_UNDO_TEAMMATE;
      h.setTeammate(t.previous);
    } else if (target === 'model') {
      const m = entry as JevAppliedModel;
      if (!m.previous || !h.setModel) return 'There was no model before this Apply to go back to — pick one.';
      h.setModel(m.previous);
    } else {
      const g = entry as JevAppliedGroup;
      const refused = h.setEdit(target, restoreRows(h.edits[target], g.before, g.touched), []);
      if (typeof refused === 'string') return refused;
    }
    setApplied((ledger) => {
      const next = { ...ledger };
      delete next[target];
      return next;
    });
    return null;
  }, []);

  const applyAll = useCallback((): JevApplyReport => {
    const report: { applied: JevApplyTarget[]; skipped: Partial<Record<JevApplyTarget, string>> } = { applied: [], skipped: {} };
    const note = (target: JevApplyTarget, refusal: string | null) => {
      if (refusal) report.skipped[target] = refusal;
      else report.applied.push(target);
    };
    const { entity: groupsNow, teammatePick: pick, modelSuggestion: s } = view.current;
    if (s) note('model', applyModel());
    else report.skipped.model = JEV_NOT_ANSWERED_REASON;
    /* A teammate Apply that CHANGES the teammate makes the three groups'
       answers stale (ranked for the old one): they re-ask, and wait for a
       click on the new answer. */
    const changesTeammate = Boolean(pick) && pick?.entityId !== live.current.teammateId;
    if (changesTeammate) note('teammate', applyTeammate());
    else report.skipped.teammate = pick ? 'Already Jev’s pick.' : view.current.teammateRefusal ?? JEV_NO_FIT_REASON;
    const teammateMoved = report.applied.includes('teammate');
    for (const group of JEV_ENTITY_GROUPS) {
      if (teammateMoved) report.skipped[group] = JEV_TEAMMATE_CHANGED_REASON;
      else if (groupsNow[group].applyRefusal) report.skipped[group] = groupsNow[group].applyRefusal ?? undefined;
      else note(group, applyGroup(group));
    }
    setLastAll(report.applied);
    return report;
  }, [applyGroup, applyModel, applyTeammate]);

  const undoAll = useCallback(() => {
    for (const target of lastAll) if (view.current.applied[target]) undo(target);
    setLastAll([]);
  }, [lastAll, undo]);

  /* ------------------------------------------------------------ spawn fields */

  const toSpawnFields = useCallback((): JevSpawnFields => {
    const fields: JevSpawnFields = {};
    /* A group Jev was asked about that failed or is still answering, and that
       the person never applied, says so if it ends up on its defaults. An
       applied group is ordinary edits now: its reason is its own. */
    const reasons: JevSpawnFields['defaultReasons'] = {};
    for (const group of JEV_ENTITY_GROUPS) {
      if (applied[group]) continue;
      const status = groups[group].status;
      if (status === 'asking') reasons[group] = 'jev-pending';
      else if (status === 'failed') reasons[group] = 'jev-failed';
    }
    if (Object.keys(reasons).length > 0) fields.defaultReasons = reasons;
    // The run is linked for cost even without a selection (design §3.1 step 7).
    if (asked) fields.jevRunId = runId as EntityId;
    return fields;
  }, [applied, groups, asked, runId]);

  return {
    runId,
    groups,
    state,
    run,
    askRefusal,
    ask,
    retry,
    contextIndex,
    entity,
    toggle,
    tickRefusal,
    teammatePick,
    teammateRefusal,
    modelRefusal,
    modelMatches,
    applied,
    applyGroup,
    applyTeammate,
    applyModel,
    applyAll,
    undo,
    undoAll,
    toSpawnFields,
    jevMode: false,
    launchNote: null,
    ticked: { memory: ticks.memories, skill: ticks.skills },
    reset,
  };
}
