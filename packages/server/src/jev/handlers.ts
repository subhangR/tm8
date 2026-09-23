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
 *      hold a connection): every requested group at once, `Promise.allSettled`.
 *      Groups are independent — one failing never touches another.
 *   3. RECORD, in the caller's transaction: the run's id-only suggestions, one
 *      `jev_calls` row per Jev call (failures included, `requestId` makes a
 *      retry free), and the run's running total, which is what `run` returns.
 *
 * No client configured (no `TYPESAFE_API_KEY`) is an ANSWER, not an error:
 * every requested group is `failed: no_key` and the response is still 200, so
 * the UI can say "Jev isn't configured" and Launch is unaffected.
 */
import {
  LaunchSuggestInputSchema,
  type EntitySuggestion,
  type JevGroupResult,
  type JevSkipReason,
  type LaunchSuggestGroup,
  type LaunchSuggestResult,
  type ModelSuggestion,
  type TeammateSuggestion,
} from '@tm8/contract';

import { claimsFor, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { fail } from '../http/errors.js';
import {
  hasSubjectText,
  loadMemories,
  loadSkills,
  loadSubject,
  loadTeammates,
  requireTeammate,
  type CandidateSet,
} from './candidates.js';
import { runGroup, ZERO_COST, type GroupRun } from './groups.js';
import type { JevAdvisorPort } from './port.js';
import { insertCalls, runTotals, storedSuggestion, upsertRun } from './store.js';

type AnyGroupRun = GroupRun<ModelSuggestion | TeammateSuggestion | EntitySuggestion>;
type RankGroup = Exclude<LaunchSuggestGroup, 'model'>;

export interface JevHandlerOptions {
  /** Built ONCE at startup (`jevAdvisorFromEnv`). Null or absent: every group answers `no_key`. */
  advisor?: JevAdvisorPort | null;
}

const skipped = (reason: JevSkipReason): AnyGroupRun =>
  ({ result: { status: 'skipped', reason, cost: { ...ZERO_COST } }, calls: [] });

export function registerJevHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: JevHandlerOptions = {},
): void {
  const advisor = options.advisor ?? null;

  registry.register('launch.suggest', async (ctx) => {
    const input = LaunchSuggestInputSchema.parse(ctx.body);
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const owner = await deps.owner();
    const claims = claimsFor(owner, ctx);

    // 1. READ.
    const plan = await deps.db.tx(claims, async (q) => {
      const member = (await q.query<{ ok: boolean }>(
        'select internal.is_space_member($1::uuid) as ok', [spaceId],
      ))[0]?.ok === true;
      if (!member) throw fail('forbidden', 'you are not a member of this space');

      const { subject, taskId } = await loadSubject(q, spaceId, input.subjectId, input.draft);
      if (input.teamMemberId) await requireTeammate(q, spaceId, input.teamMemberId);

      const skips: Partial<Record<LaunchSuggestGroup, JevSkipReason>> = {};
      const sets: Partial<Record<RankGroup, CandidateSet>> = {};
      // Without a client every group is `no_key`; there is nothing to load for.
      if (advisor) {
        const text = hasSubjectText(subject);
        for (const group of input.groups) {
          if (!text) { skips[group] = 'no_subject_text'; continue; }
          if (group === 'teammates') sets.teammates = await loadTeammates(q, spaceId);
          if (group === 'memories' || group === 'skills') {
            if (!input.teamMemberId) { skips[group] = 'no_teammate'; continue; }
            sets[group] = group === 'memories'
              ? await loadMemories(q, spaceId, input.teamMemberId, taskId)
              : await loadSkills(q, spaceId, input.teamMemberId);
          }
        }
      }
      return { subject, skips, sets };
    });

    // 2. ASK — all requested groups in flight at once.
    const settled = await Promise.allSettled(input.groups.map((group): Promise<AnyGroupRun> => {
      const skip = plan.skips[group];
      if (skip) return Promise.resolve(skipped(skip));
      return group === 'model'
        ? runGroup(advisor, 'model', null, plan.subject)
        : runGroup(advisor, group as 'memories', plan.sets[group] ?? { items: [], considered: 0, total: 0 }, plan.subject);
    }));
    const runs = new Map<LaunchSuggestGroup, AnyGroupRun>(input.groups.map((group, i) => {
      const outcome = settled[i]!;
      // runGroup never rejects; this keeps the promise honest if it ever did.
      return [group, outcome.status === 'fulfilled'
        ? outcome.value
        : { result: { status: 'failed', reason: 'network', cost: { ...ZERO_COST } }, calls: [] }];
    }));

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
      return { runId: input.runId, groups, run: await runTotals(q, input.runId) };
    });
  });
}
