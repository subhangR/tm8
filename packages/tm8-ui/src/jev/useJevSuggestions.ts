import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollabError,
  LAUNCH_SUGGEST_GROUPS,
  type EntityId,
  type EntitySuggestion,
  type JevCost,
  type JevFailure,
  type JevGroupResult,
  type JevSkipReason,
  type LaunchSuggestDraft,
  type LaunchSuggestGroup,
  type LaunchSuggestInput,
  type ModelSuggestion,
  type SpawnSelectionDefaultReason,
  type SpawnSelectionGroup,
  type TeammateSuggestion,
} from '@tm8/contract';

import { MEMORY_IDS_MAX } from '../domain/memory';
import type { GroupOutcome } from '../domain/launch-selection';
import type { JevPort } from './port';

/**
 * useJevSuggestions — the one hook behind ✦ Ask Jev on LaunchSheet AND the Run
 * popup (design 01a0cb80 §3, §7.5). Both surfaces render the same state, send
 * the same request and spread the same `toSpawnFields()` into their launch.
 *
 * WHAT IT OWNS:
 *   · `runId`, minted once per mount — one sheet or popup is one run, and every
 *     press or re-ask while it stays open is costed to it.
 *   · a state per group (model, teammates, memories, skills), independently:
 *     one group failing never touches another, and each can be retried alone.
 *   · the tick state for memories and skills, seeded from Jev's `suggested`.
 *   · the staleness check, the run's cost total, and `toSpawnFields()`.
 *
 * WHAT IT NEVER DOES: apply anything by itself. Jev only suggests (rule 1): the
 * model is applied by a click, the teammate by a click, and the ticks reach
 * spawn only through the surface's own Launch.
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
}

export type JevGroups = { [G in LaunchSuggestGroup]: JevGroupState<JevGroupValues[G]> };

export type JevOverallState = 'idle' | 'asking' | 'ready' | 'stale' | 'unavailable';

/** Memories and skills are the two ticked kinds. */
export type JevTickKind = 'memory' | 'skill';

/** The two groups Jev ticks, as `SpawnSelection` names them. */
export type JevTickedGroup = Extract<SpawnSelectionGroup, 'memories' | 'skills'>;
const JEV_TICKED_GROUPS: readonly JevTickedGroup[] = ['memories', 'skills'];

export interface JevSpawnFields {
  /**
   * In Jev mode, Jev's outcome for each ticked group: its exact set, or its
   * defaults and why. These REPLACE the sheet's own outcome for those groups
   * (`composeSelection`'s override).
   */
  groups?: Partial<Record<JevTickedGroup, GroupOutcome>>;
  /** Out of Jev mode: why a group that ends up on its defaults got there, when Jev failed or is pending. */
  defaultReasons?: Partial<Record<JevTickedGroup, SpawnSelectionDefaultReason>>;
  jevRunId?: EntityId;
}

export interface JevSuggestions {
  runId: string;
  groups: JevGroups;
  state: JevOverallState;
  /** The whole run's cost, from the latest answer. Null until one arrives. */
  run: JevCost | null;
  /** Why Ask Jev cannot be pressed on this surface; null when it can. */
  askRefusal: string | null;
  /** `ask()` sends all four groups; `ask(groups)` a subset. */
  ask(groups?: readonly LaunchSuggestGroup[]): void;
  retry(group: LaunchSuggestGroup): void;
  /** Ticked ids, in Jev's ranking order. */
  ticked: { readonly memory: readonly string[]; readonly skill: readonly string[] };
  /** Returns the refusal reason when the tick is refused (the 32-memory limit). */
  toggle(kind: JevTickKind, id: string): string | null;
  /** The last refused tick, so a checklist can say why at the row. */
  tickRefusal: { kind: JevTickKind; id: string; reason: string } | null;
  /** Leaves Jev mode and clears the ticks; Launch goes out as it would without Jev. */
  reset(): void;
  /** True while the memory and skill sections show Jev's checklists. */
  jevMode: boolean;
  /** In Jev mode but the ticks will NOT be sent, and why. Null otherwise. */
  launchNote: string | null;
  toSpawnFields(): JevSpawnFields;
}

/** Every group said `no_key`: neither this member nor this node has a TypeSafe key. */
export const JEV_UNAVAILABLE_COPY = 'Ask Jev needs a TypeSafe key, and none is saved for you.';
export const JEV_ADD_KEY_COPY = 'Add yours in Settings → Agent credentials';
export const JEV_UNWIRED_REASON = 'Jev isn’t wired on this surface, so there is nobody to ask.';
export const MEMORY_LIMIT_REASON =
  `A launch carries at most ${String(MEMORY_IDS_MAX)} memories — untick one before ticking another.`;

const IDLE: JevGroups = {
  model: { status: 'idle' },
  teammates: { status: 'idle' },
  memories: { status: 'idle' },
  skills: { status: 'idle' },
};

const ZERO_COST: JevCost = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 };

/** The groups a teammate change invalidates: both are ranked FOR the teammate. */
const TEAMMATE_DEPENDENT: readonly LaunchSuggestGroup[] = ['memories', 'skills'];

const GROUP_WORD: Record<LaunchSuggestGroup, string> = {
  model: 'Model',
  teammates: 'Teammates',
  memories: 'Memories',
  skills: 'Skills',
};

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

/** Suggested ids in ranking order; memories stop at the spawn limit. */
function seed(result: EntitySuggestion, kind: JevTickKind): string[] {
  const ids = [...result.items]
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.suggested)
    .map((item) => item.entityId);
  return kind === 'memory' ? ids.slice(0, MEMORY_IDS_MAX) : ids;
}

function usable(group: JevGroupState<EntitySuggestion>): boolean {
  return group.status === 'ok' || group.status === 'skipped';
}

export function useJevSuggestions(args: {
  port?: JevPort | null;
  spaceId: string;
  subjectId: string;
  /** The teammate the launch runs as; memories and skills are ranked for it. */
  teammateId?: string | null;
  /** The Run popup's LIVE title and description. Absent: the saved subject. */
  draft?: LaunchSuggestDraft;
}): JevSuggestions {
  const { port, spaceId, subjectId, teammateId, draft } = args;

  // One run per mount. `useState`'s initializer runs once, so this is stable.
  const [runId] = useState(newJevId);
  const [groups, setGroups] = useState<JevGroups>(IDLE);
  const [run, setRun] = useState<JevCost | null>(null);
  const [asked, setAsked] = useState(false);
  const [askedDraft, setAskedDraft] = useState('');
  const [memoryTicks, setMemoryTicks] = useState<string[]>([]);
  const [skillTicks, setSkillTicks] = useState<string[]>([]);
  const [entered, setEntered] = useState(false);
  const [tickRefusal, setTickRefusal] = useState<JevSuggestions['tickRefusal']>(null);

  /* The request inputs, read at ASK time rather than captured: a press sends
     what the surface shows at that moment, and `ask` stays referentially stable
     so the teammate effect below does not re-fire on every render. */
  const live = useRef({ port, spaceId, subjectId, teammateId, draft });
  live.current = { port, spaceId, subjectId, teammateId, draft };

  /* Which request each group's answer must come from. A slower, older answer
     that lands after a re-ask is dropped per group, never merged over the new. */
  const latest = useRef<Partial<Record<LaunchSuggestGroup, string>>>({});
  const mounted = useRef(true);
  /* Reset is a decision the viewer made: a later automatic re-ask (a teammate
     change) must not quietly put the checklists back. Only a press does. */
  const resetDone = useRef(false);
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
    const { port: p, spaceId: space, subjectId: subject, teammateId: teammate, draft: text } = live.current;
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
    };

    setAsked(true);
    setAskedDraft(draftKey(text));
    setGroups((current) => {
      const next = { ...current };
      for (const group of list) (next as Record<string, unknown>)[group] = { status: 'asking' };
      return next;
    });

    const settle = (answer: (group: LaunchSuggestGroup) => JevGroupResult<unknown> | undefined) => {
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
      const memories = results.get('memories');
      const skills = results.get('skills');
      if (memories?.status === 'ok') setMemoryTicks(seed(memories.value as EntitySuggestion, 'memory'));
      else if (memories) setMemoryTicks([]);
      if (skills?.status === 'ok') setSkillTicks(seed(skills.value as EntitySuggestion, 'skill'));
      else if (skills) setSkillTicks([]);
      if (!resetDone.current && (memories?.status === 'ok' || skills?.status === 'ok')) setEntered(true);
      setTickRefusal(null);
    };

    p.suggest(space, input).then(
      (result) => {
        if (!mounted.current) return;
        // `run` is the server's running total; the larger answer is the later one.
        setRun((current) => (current && current.calls > result.run.calls ? current : result.run));
        settle((group) => result.groups[group] as JevGroupResult<unknown> | undefined);
      },
      (error: unknown) => {
        const reason = failureOf(error);
        settle(() => ({ status: 'failed', reason, cost: ZERO_COST }));
      },
    );
  }, [runId]);

  /* A PRESS (unlike the automatic teammate re-ask) is the viewer asking for
     suggestions again, so it lifts a Reset. */
  const press = useCallback((requested?: readonly LaunchSuggestGroup[]) => {
    resetDone.current = false;
    ask(requested);
  }, [ask]);

  const retry = useCallback((group: LaunchSuggestGroup) => {
    resetDone.current = false;
    ask([group]);
  }, [ask]);

  /* TEAMMATE CHANGE after an answer re-asks memories and skills — both are
     ranked FOR the teammate — in the same run, with a new requestId. Model and
     teammates do not depend on the teammate and are left alone. Before any
     answer there is nothing to refresh, so nothing is sent. */
  const lastTeammate = useRef(teammateId);
  const dependentAsked = groups.memories.status !== 'idle' || groups.skills.status !== 'idle';
  useEffect(() => {
    if (lastTeammate.current === teammateId) return;
    lastTeammate.current = teammateId;
    if (dependentAsked && !resetDone.current) ask(TEAMMATE_DEPENDENT);
  }, [teammateId, dependentAsked, ask]);

  const toggle = useCallback((kind: JevTickKind, id: string): string | null => {
    if (kind === 'skill') {
      setSkillTicks((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
      setTickRefusal(null);
      return null;
    }
    if (!memoryTicks.includes(id) && memoryTicks.length >= MEMORY_IDS_MAX) {
      setTickRefusal({ kind, id, reason: MEMORY_LIMIT_REASON });
      return MEMORY_LIMIT_REASON;
    }
    setMemoryTicks((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    setTickRefusal(null);
    return null;
  }, [memoryTicks]);

  const reset = useCallback(() => {
    resetDone.current = true;
    setEntered(false);
    setMemoryTicks([]);
    setSkillTicks([]);
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

  /* PER-GROUP SEND (design 01a0d348 §5.2, I9 — replaces the 2026-09-23
     "both sets or nothing" ruling). In Jev mode each of memories and skills is
     decided ON ITS OWN: an answered group is its exact set, a group that was
     SKIPPED (no candidates) truthfully has none and sends `[]`, and a group
     that failed or is still answering is OMITTED — the node loads that
     group's defaults and records why (`jev-failed` / `jev-pending`). Nothing
     is ever sent as `[]` for a group whose set is unknown: that would strip
     every default it carries without anyone choosing it. */
  const outcomeOf = useCallback((group: JevTickedGroup): GroupOutcome => {
    const state = groups[group];
    if (state.status === 'ok') return { send: [...(group === 'memories' ? memoryTicks : skillTicks)] };
    if (state.status === 'skipped') return { send: [] };
    if (state.status === 'asking') return { omit: 'jev-pending' };
    if (state.status === 'failed') return { omit: 'jev-failed' };
    return { omit: 'not-asked' };
  }, [groups, memoryTicks, skillTicks]);

  const launchNote = useMemo<string | null>(() => {
    if (!entered) return null;
    const blocking = JEV_TICKED_GROUPS.filter((group) => !usable(groups[group]));
    if (blocking.length === 0) return null;
    const words = blocking.map((group) => GROUP_WORD[group]).join(' and ');
    if (blocking.some((group) => groups[group].status === 'asking')) {
      return `Jev is still answering ${words.toLowerCase()} — Launch now sends the defaults for ${blocking.length === 1 ? 'that group' : 'those groups'}.`;
    }
    const failed = blocking.map((group) => {
      const g = groups[group];
      return g.status === 'failed' ? `${GROUP_WORD[group]} failed (${g.reason})` : `${GROUP_WORD[group]} not asked`;
    }).join(' · ');
    const rest = blocking.length < JEV_TICKED_GROUPS.length ? '; your other ticks still go' : '';
    return `${failed} — Launch sends the defaults for ${blocking.length === 1 ? 'that group' : 'those groups'}${rest}. Retry to launch with Jev’s ticks.`;
  }, [entered, groups]);

  const toSpawnFields = useCallback((): JevSpawnFields => {
    const fields: JevSpawnFields = {};
    if (entered) {
      fields.groups = { memories: outcomeOf('memories'), skills: outcomeOf('skills') };
    } else {
      /* Out of Jev mode the sheet's own ticks decide, but a group Jev failed
         or is still answering says so if it ends up on its defaults. */
      const reasons: JevSpawnFields['defaultReasons'] = {};
      for (const group of JEV_TICKED_GROUPS) {
        const outcome = outcomeOf(group);
        if ('omit' in outcome && outcome.omit !== 'not-asked') reasons[group] = outcome.omit;
      }
      if (Object.keys(reasons).length > 0) fields.defaultReasons = reasons;
    }
    // The run is linked for cost even without a selection (design §3.1 step 7).
    if (asked) fields.jevRunId = runId as EntityId;
    return fields;
  }, [entered, outcomeOf, asked, runId]);

  return {
    runId,
    groups,
    state,
    run,
    askRefusal,
    ask: press,
    retry,
    ticked: { memory: memoryTicks, skill: skillTicks },
    toggle,
    tickRefusal,
    reset,
    jevMode: entered,
    launchNote,
    toSpawnFields,
  };
}
