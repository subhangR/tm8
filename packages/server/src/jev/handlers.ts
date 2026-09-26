/**
 * `launch.suggest` — THE one registration of Jev's launch-sheet advice
 * (design 01a0cb80 §5.1). UI only: no CLI verb, and nothing on the spawn path
 * ever calls it.
 *
 * One request, in three steps:
 *   1. READ, in the caller's transaction: membership, the subject (once), and
 *      the candidates of each requested group — under RLS, so Jev is never
 *      shown what the caller cannot read.
 *   2. ASK, outside any transaction (a Jev call can take seconds and must not
 *      hold a connection): every requested group at once. Groups are
 *      independent — one failing never touches another. The one ordering
 *      (launch card v3, Decision 7): when the strip is ranked for Jev's own
 *      top teammate, memories, skills and references are read and asked
 *      once the teammates group has answered, for that teammate.
 *   3. RECORD, in the caller's transaction: the run's id-only suggestions, one
 *      `jev_calls` row per Jev call (failures included, `requestId` makes a
 *      retry free), and the run's running total, which is what `run` returns.
 *
 * WHOSE KEY is decided per request (`advisor.ts`): the caller's own TypeSafe
 * key from Settings → agent credentials, else the node's `TYPESAFE_API_KEY`.
 * Neither is an ANSWER, not an error: every requested group is `failed:
 * no_key` and the response is still 200, so the UI can say the key is missing
 * and Launch is unaffected.
 *
 * THE TICKS FILL A BUDGET (design 01a0d348 §10 Q5). Each group's budget and
 * floor come from the Interaction Profile the launch would pin
 * (`contextBudgets` / `contextFloors`), else the node defaults
 * (`BYTE_BUDGETS`, `CONTEXT_FLOOR_DEFAULTS`); every ranked row carries its
 * `promptBytes`, measured with spawn's serializers (`measure.ts`), and whether
 * the launch would render `<context_index>` decides what those bytes are.
 */
import {
  CONTEXT_FLOOR_DEFAULTS,
  LaunchSuggestInputSchema,
  type EntitySuggestion,
  type JevGroupResult,
  type JevSkipReason,
  type LaunchSuggestGroup,
  type LaunchSuggestResult,
  type ModelSuggestion,
  type TeammateSuggestion,
} from '@tm8/contract';

import { contextBudgetsFrom, contextFloorsFrom, contextIndexSwitch } from '@tm8/execution';
import { BYTE_BUDGETS, contextGroupFrameBytes } from '@tm8/prompt';

import type { DbClaims } from '../db/types.js';
import { claimsFor, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { fail } from '../http/errors.js';
import { resolveInteractionProfileForLaunch } from '../profiles/w2-profile-resolver.js';
import {
  hasSubjectText,
  loadMemories,
  loadReferences,
  loadSkills,
  loadSubject,
  loadTeammates,
  requireTeammate,
  type CandidateSet,
} from './candidates.js';
import { runGroup, ZERO_COST, type FillRule, type GroupRun } from './groups.js';
import type { JevAdvisorPort, JevAdvisorResolver } from './port.js';
import { insertCalls, runTotals, storedSuggestion, upsertRun } from './store.js';

type AnyGroupRun = GroupRun<ModelSuggestion | TeammateSuggestion | EntitySuggestion>;
type RankGroup = Exclude<LaunchSuggestGroup, 'model'>;
/** The launch strip: the groups ranked for one teammate (Decision 7). */
type StripGroup = 'memories' | 'skills' | 'references';
const STRIP_GROUPS: ReadonlySet<LaunchSuggestGroup> = new Set<LaunchSuggestGroup>(['memories', 'skills', 'references']);

export interface JevHandlerOptions {
  /**
   * Picks the advisor for each request from the caller's claims — production
   * wires `createJevAdvisorResolver`. Wins over `advisor` when both are given.
   */
  resolveAdvisor?: JevAdvisorResolver;
  /** One fixed advisor for every caller (tests). Null or absent: every group answers `no_key`. */
  advisor?: JevAdvisorPort | null;
  /**
   * The resolved Interaction Profile SNAPSHOT a launch would pin (its
   * `draft` carries `contextIndex`, `contextBudgets`, `contextFloors`).
   * Default: `resolveInteractionProfileForLaunch`, the resolver spawn uses. A
   * profile that cannot be resolved is the node defaults, never a refusal.
   */
  resolveProfile?: (claims: DbClaims, input: { spaceId: string; teamMemberId: string | null; interactionProfileId: string | null }) => Promise<unknown>;
  /** The node env whose `TM8_CONTEXT_INDEX` outranks the profile (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The budget and floor of each group Jev ranks, and whether the launch renders `<context_index>`. */
export interface GroupRules {
  contextIndex: boolean;
  rules: Record<RankGroup, FillRule>;
}

/**
 * Each group's fill rule for one launch (§10 Q5). Memories: their budget and
 * the index group's frame (every memory is an index entry, launch card v3),
 * and a critical memory always fits. Skills: the profile's cap,
 * charged with the index's group frame; none of their own otherwise (they
 * take what the prompt has left), and none while the index is off, because
 * the `<skills>` trim ignores it. References: their sub-cap and frame; none
 * while the index is off (they are not in the prompt). Teammates: a floor,
 * and the profile's `contextBudgets.teammates` while the index is on.
 */
export function groupRules(env: Readonly<Record<string, string | undefined>>, profileSnapshot: unknown): GroupRules {
  const contextIndex = contextIndexSwitch(env, profileSnapshot).on;
  const budgets = contextBudgetsFrom(profileSnapshot);
  const floors = { ...CONTEXT_FLOOR_DEFAULTS, ...contextFloorsFrom(profileSnapshot) };
  const frame = (group: 'memories' | 'skills' | 'references') => (count: number) => contextGroupFrameBytes(group, count);
  return {
    contextIndex,
    rules: {
      memories: { budget: budgets.memories ?? BYTE_BUDGETS.memoryInjection, floor: floors.memories, criticalAlwaysFits: true, frameBytes: frame('memories') },
      skills: contextIndex
        ? { budget: budgets.skills ?? null, floor: floors.skills, frameBytes: frame('skills') }
        : { budget: null, floor: floors.skills },
      references: contextIndex
        ? { budget: budgets.references ?? BYTE_BUDGETS.referenceIndex, floor: floors.references, frameBytes: frame('references') }
        : { budget: null, floor: floors.references },
      // A worker's teammates share the references cap unless the profile
      // gives them their own; none while the index is off (not in the prompt).
      teammates: { budget: contextIndex ? budgets.teammates ?? null : null, floor: floors.teammates },
    },
  };
}

const skipped = (reason: JevSkipReason): AnyGroupRun =>
  ({ result: { status: 'skipped', reason, cost: { ...ZERO_COST } }, calls: [] });

export function registerJevHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: JevHandlerOptions = {},
): void {
  const fixed = options.advisor ?? null;
  const resolveAdvisor: JevAdvisorResolver = options.resolveAdvisor ?? (async () => fixed);
  const resolveProfile = options.resolveProfile
    ?? (async (claims: DbClaims, input: { spaceId: string; teamMemberId: string | null; interactionProfileId: string | null }) =>
      (await resolveInteractionProfileForLaunch(deps.db, claims, input)).snapshot);
  const env = options.env ?? process.env;

  registry.register('launch.suggest', async (ctx) => {
    const input = LaunchSuggestInputSchema.parse(ctx.body);
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx);
    // THIS caller's advisor: their key, else the node's, else null (no_key).
    const advisor = await resolveAdvisor(claims);
    // The profile the launch would pin decides the budgets, floors and index
    // switch. Unresolvable (no such profile, a teammate not yet readable) is
    // the node's defaults: advice is never refused over a budget.
    const rulesFor = async (teamMemberId: string | null): Promise<GroupRules> => {
      let profileSnapshot: unknown = null;
      try {
        profileSnapshot = await resolveProfile(claims, {
          spaceId,
          teamMemberId,
          interactionProfileId: input.interactionProfileId ?? null,
        });
      } catch {
        profileSnapshot = null;
      }
      return groupRules(env, profileSnapshot);
    };
    const fixedRules = await rulesFor(input.teamMemberId ?? null);

    // WHOSE STRIP (launch card v3, Decision 7). Jev's top teammate is
    // auto-applied by the UI, so memories, skills and references are ranked
    // for it — asked AFTER the teammates group has answered — when the card's
    // teammate is not fixed. Anything else ranks for `teamMemberId`.
    const wantsTeammates = input.groups.includes('teammates');
    const rankForSuggested = wantsTeammates && (input.rankForSuggestedTeammate ?? input.teamMemberId === undefined);
    const stripGroups = input.groups.filter((group): group is StripGroup => STRIP_GROUPS.has(group));

    // 1. READ — the subject, the fixed teammate and the teammate pool.
    const head = await deps.db.tx(claims, async (q) => {
      const member = (await q.query<{ ok: boolean }>(
        'select internal.is_space_member($1::uuid) as ok', [spaceId],
      ))[0]?.ok === true;
      if (!member) throw fail('forbidden', 'you are not a member of this space');

      const subject = await loadSubject(q, spaceId, input.subjectId, input.draft);
      const teammate = input.teamMemberId ? await requireTeammate(q, spaceId, input.teamMemberId) : null;
      const measure = { contextIndex: fixedRules.contextIndex, agentTool: input.agentTool ?? teammate?.agentTool ?? 'claude-code' };
      const text = hasSubjectText(subject.subject);
      const teammates = advisor && text && wantsTeammates ? await loadTeammates(q, spaceId, measure) : undefined;
      return { ...subject, text, teammates, teammateTool: teammate?.agentTool ?? null };
    });

    // The strip's candidates, for one teammate, in the caller's transaction.
    const readStrip = (teamMemberId: string | null, contextIndex: boolean, knownTool: string | null) =>
      deps.db.tx(claims, async (q) => {
        const skips: Partial<Record<LaunchSuggestGroup, JevSkipReason>> = {};
        const sets: Partial<Record<RankGroup, CandidateSet>> = {};
        // Without a client every group is `no_key`; there is nothing to load for.
        if (!advisor) return { skips, sets };
        const tool = teamMemberId === null
          ? null
          : teamMemberId === input.teamMemberId ? knownTool : (await requireTeammate(q, spaceId, teamMemberId)).agentTool;
        const measure = { contextIndex, agentTool: input.agentTool ?? tool ?? 'claude-code' };
        for (const group of stripGroups) {
          if (!head.text) { skips[group] = 'no_subject_text'; continue; }
          if (group === 'references') sets.references = await loadReferences(q, spaceId, head.taskId, head.parentTaskId, measure);
          else if (!teamMemberId) skips[group] = 'no_teammate';
          else {
            sets[group] = group === 'memories'
              ? await loadMemories(q, spaceId, teamMemberId, head.taskId)
              : await loadSkills(q, spaceId, teamMemberId, head.taskId, measure);
          }
        }
        return { skips, sets };
      });

    // 2. ASK — the model and teammates groups at once; the strip with them
    // unless it waits for Jev's top teammate.
    const ask = (group: LaunchSuggestGroup, plan: { skips: Partial<Record<LaunchSuggestGroup, JevSkipReason>>; sets: Partial<Record<RankGroup, CandidateSet>> }, rules: GroupRules['rules']): Promise<AnyGroupRun> => {
      const skip = plan.skips[group];
      if (skip) return Promise.resolve(skipped(skip));
      return group === 'model'
        ? runGroup(advisor, 'model', null, head.subject)
        : runGroup(advisor, group as 'memories', plan.sets[group] ?? { items: [], considered: 0, total: 0 }, head.subject, rules[group]);
    };
    const settle = (promise: Promise<AnyGroupRun>): Promise<AnyGroupRun> => promise.catch(
      // runGroup never rejects; this keeps the promise honest if it ever did.
      (): AnyGroupRun => ({ result: { status: 'failed', reason: 'network', cost: { ...ZERO_COST } }, calls: [] }),
    );
    const headPlan = {
      skips: advisor && !head.text ? Object.fromEntries(input.groups.map((g) => [g, 'no_subject_text' as const])) : {},
      sets: head.teammates ? { teammates: head.teammates } : {},
    };
    // A fixed teammate: the strip is read up front, and every group is asked at once.
    const fixedPlan = !rankForSuggested && stripGroups.length > 0
      ? await readStrip(input.teamMemberId ?? null, fixedRules.contextIndex, head.teammateTool)
      : null;
    const headRuns = new Map<LaunchSuggestGroup, Promise<AnyGroupRun>>(input.groups
      .filter((group) => !STRIP_GROUPS.has(group))
      .map((group) => [group, settle(ask(group, headPlan, fixedRules.rules))]));

    let rankedFor: string | null = input.teamMemberId ?? null;
    if (rankForSuggested) {
      const teammates = (await headRuns.get('teammates')!).result;
      const top = teammates.status === 'ok' ? (teammates.value as TeammateSuggestion).items.find((item) => item.suggested) : undefined;
      if (top) rankedFor = top.entityId;
    }
    const stripRules = rankedFor === (input.teamMemberId ?? null) ? fixedRules : await rulesFor(rankedFor);
    const stripPlan = fixedPlan ?? (stripGroups.length > 0
      ? await readStrip(rankedFor, stripRules.contextIndex, head.teammateTool)
      : { skips: {}, sets: {} });
    const stripRuns = new Map<LaunchSuggestGroup, Promise<AnyGroupRun>>(stripGroups
      .map((group) => [group, settle(ask(group, stripPlan, stripRules.rules))]));
    const runs = new Map<LaunchSuggestGroup, AnyGroupRun>();
    for (const group of input.groups) runs.set(group, await (headRuns.get(group) ?? stripRuns.get(group))!);
    const contextIndex = stripRules.contextIndex;

    // 3. RECORD.
    return deps.db.tx(claims, async (q): Promise<LaunchSuggestResult> => {
      const suggestions: Record<string, unknown> = {};
      for (const [group, run] of runs) suggestions[group] = storedSuggestion(group, input.requestId, run.result);
      await upsertRun(q, { runId: input.runId, spaceId, subjectId: input.subjectId, suggestions });
      for (const [group, run] of runs) {
        await insertCalls(q, input.runId, input.requestId, group, 0, run.calls);
      }
      const groups: LaunchSuggestResult['groups'] = {};
      for (const [group, run] of runs) {
        (groups as Record<LaunchSuggestGroup, JevGroupResult<unknown>>)[group] = run.result;
      }
      return {
        runId: input.runId,
        groups,
        contextIndex: contextIndex ? 'on' : 'off',
        rankedForTeamMemberId: rankedFor,
        run: await runTotals(q, input.runId),
      };
    });
  });
}
