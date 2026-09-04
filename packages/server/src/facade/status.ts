/**
 * The ONE narrowing of the status columns — shared by the read path and the
 * event path, because they used to disagree.
 *
 * ## Why this file exists at all
 *
 * `tasks.work_status` is `text` on the wire out of Postgres. Two places turn it
 * into the contract's `WorkStatus`, and until now they did it differently:
 *
 *   * `events/projector.ts` raised `WorkStatusDriftError` on an unrecognised
 *     value (phase 0), and
 *   * `facade/entity-read.ts` wrote `(row.work_status ?? 'open') as WorkStatus`
 *     — an UNCHECKED cast, so a drifted value flowed straight into the DTO and
 *     out to a client that had been promised a closed union.
 *
 * So the same task could arrive over the socket as a 500 and over the REST read
 * as a lie, and nothing in either file said the other existed. Sharing the
 * narrowing is what makes "the projector mirrors the read path" a fact the
 * compiler holds rather than a comment two authors have to remember.
 *
 * ## The posture: LOUD, and no fallback — in BOTH paths
 *
 * A fallback cannot distinguish "a status we do not know YET" from "a status
 * that does not exist". Picking `open` for either was the phase-0 bug, and it
 * gets strictly worse now that a later phase makes statuses user-defined. When
 * that phase lands, WIDEN WHAT THESE FUNCTIONS ACCEPT. Never restore a default.
 *
 * The blast radius of raising on the read path is real and is the point: both
 * columns carry a DDL CHECK, so the only way to reach either error is a
 * migration that widened the database without the contract following. That is
 * an operator's bug, and an operator's bug that 500s gets fixed in an hour
 * where one that silently rewrites every affected row's status gets found in a
 * quarter, by a customer.
 */
import type { StatusCategory, WorkSessionStatus, WorkStatus } from '@tm8/contract';

/**
 * `satisfies`, not a bare `as const`: this list is what `narrowWorkStatus()`
 * accepts, so a contract that adds a status while this list stands still would
 * make the new value a fatal drift error. The `satisfies` catches a value that
 * is NOT in the contract; the `Exhaustive` check below catches a contract value
 * missing HERE. Together they pin the list to `WorkStatus` in both directions.
 */
export const WORK_STATUSES = [
  'open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled',
] as const satisfies readonly WorkStatus[];

/** Compile error if `WorkStatus` gains an arm `WORK_STATUSES` does not list. */
type _WorkStatusesAreExhaustive = Exclude<WorkStatus, (typeof WORK_STATUSES)[number]> extends never
  ? true
  : ['WORK_STATUSES is missing a WorkStatus arm', Exclude<WorkStatus, (typeof WORK_STATUSES)[number]>];
const _workStatusesAreExhaustive: _WorkStatusesAreExhaustive = true;
void _workStatusesAreExhaustive;

/** Same two-directional pin, for the closed four. */
export const STATUS_CATEGORIES = [
  'to_do', 'in_progress', 'done', 'cancelled',
] as const satisfies readonly StatusCategory[];

/** Compile error if `StatusCategory` gains an arm `STATUS_CATEGORIES` omits. */
type _CategoriesAreExhaustive = Exclude<StatusCategory, (typeof STATUS_CATEGORIES)[number]> extends never
  ? true
  : ['STATUS_CATEGORIES is missing a StatusCategory arm', Exclude<StatusCategory, (typeof STATUS_CATEGORIES)[number]>];
const _categoriesAreExhaustive: _CategoriesAreExhaustive = true;
void _categoriesAreExhaustive;

/**
 * The RULED status → category mapping, as TypeScript.
 *
 * This is a MIRROR of `internal.work_status_category()` in
 * `db/migrations/147_entity_status_category.sql`, which is the real writer —
 * the column is maintained by a trigger, not by this constant, and nothing in
 * the server calls this to populate a DTO. It is here because the mapping is a
 * product decision that deserves to be readable from the code that consumes
 * its results, and because a test can hold the two copies against each other.
 *
 * The two judgement calls, ruled by the owner: `pulled → to_do` (claimed is not
 * started) and `blocked → in_progress` (started, and stuck is not un-started).
 *
 * `Record<WorkStatus, …>` is load-bearing: a new status arm fails to compile
 * here until someone decides which bucket it belongs to, which is exactly the
 * decision that must not be made by a `default:`.
 */
export const WORK_STATUS_CATEGORY: Record<WorkStatus, StatusCategory> = {
  open: 'to_do',
  pulled: 'to_do',
  working: 'in_progress',
  in_review: 'in_progress',
  blocked: 'in_progress',
  done: 'done',
  cancelled: 'cancelled',
};

/**
 * The RULED `work_sessions.status` → category mapping, as TypeScript.
 *
 * A MIRROR of `internal.session_status_category()` in
 * `db/migrations/155_session_status_category.sql`, which is the real writer —
 * the column is maintained by that migration's bridge trigger, not by this
 * constant, and nothing in the server calls this to populate a DTO. It is here
 * for the reason `WORK_STATUS_CATEGORY` is: the mapping is a product decision
 * that deserves to be readable from the code that consumes its results, and a
 * test can hold the two copies against each other.
 *
 * The two members that are not the obvious guess, both ruled:
 *
 *   `spawning → to_do`  — 147's `pulled → to_do` ("claimed is not started")
 *     applied to the same shape of fact, and the thing that makes
 *     `public.session_resume` a legal `done → to_do` REOPEN. Under
 *     `spawning → in_progress` a resume would be `done → in_progress`, which
 *     `internal.category_transition_allowed` refuses outright.
 *   `failed → done`     — the client's existing ruling, mirrored rather than
 *     made here (`SESSION_STATE_CONTROL` in the UI registry): failure is a
 *     runtime fact that gets a badge, and the run did reach its end. Nobody
 *     cancelled it. NO session status maps to `cancelled`, which is honest
 *     rather than an omission — nothing in the session lifecycle is a
 *     cancellation, and `terminate` produces `exited`.
 *
 * `Record<WorkSessionStatus, …>` is load-bearing for the same reason it is
 * above: a new status arm fails to compile until someone decides which bucket
 * it belongs to.
 */
export const SESSION_STATUS_CATEGORY: Record<WorkSessionStatus, StatusCategory> = {
  spawning: 'to_do',
  running: 'in_progress',
  idle: 'in_progress',
  exited: 'done',
  failed: 'done',
};

/**
 * Thrown when `tasks.work_status` holds a value the contract's `WorkStatus`
 * does not name.
 *
 * Deliberately fatal, for the same reason `EntityKindDriftError` is: the only
 * way to reach it is drift between the database and the frozen contract. The
 * column carries a DDL CHECK, so an unrecognised value means a migration has
 * widened the set without the contract following — an operator's bug, not a
 * runtime state.
 *
 * Until this existed the value went through `oneOf(..., 'open')` on the event
 * path and a bare `as WorkStatus` on the read path, and an unrecognised status
 * arrived at the client as `open` or as a lie about the union. That is data
 * corruption attributed to everything except its cause.
 */
export class WorkStatusDriftError extends Error {
  constructor(status: string, entityId: string) {
    super(
      `database contains task work_status '${status}' (entity ${entityId}) which is not in the frozen contract — ` +
        `db/migrations tasks.work_status has drifted from @tm8/contract WorkStatus`,
    );
    this.name = 'WorkStatusDriftError';
  }
}

/**
 * Thrown when `entities.status_category` holds a value outside the closed four.
 *
 * The category union is closed FOREVER — that is the design's whole bargain in
 * exchange for statuses being open — so unlike a status, an unknown category
 * can never be "one we have not heard of yet". It can only be a migration that
 * broke the bargain, and the DDL CHECK on the column means even that takes two
 * deliberate steps. Raising is the only honest reading.
 */
export class StatusCategoryDriftError extends Error {
  constructor(category: string, entityId: string) {
    super(
      `database contains entity status_category '${category}' (entity ${entityId}) which is not one of the closed four — ` +
        `db/migrations entities.status_category has drifted from @tm8/contract StatusCategory`,
    );
    this.name = 'StatusCategoryDriftError';
  }
}

/**
 * Narrow a raw `work_status` to the contract's `WorkStatus`, loudly.
 *
 * NULL is NOT drift — it is the "detail table did not join" case (the row is
 * not a task), and `open` is the value the migration declares for a fresh task.
 * A non-null string outside the union is the drift case and raises.
 */
export function narrowWorkStatus(raw: unknown, entityId: string): WorkStatus {
  if (raw === null || raw === undefined) return 'open';
  if (typeof raw === 'string' && (WORK_STATUSES as readonly string[]).includes(raw)) {
    return raw as WorkStatus;
  }
  throw new WorkStatusDriftError(String(raw), entityId);
}

/**
 * Narrow a raw `status_category` to the closed four, loudly — or to `undefined`
 * when the entity genuinely has no status.
 *
 * `undefined`, NOT a default: absence is a fact about the entity ("no workflow
 * position") and it is the honest answer for every non-task kind in this phase.
 * The contract's `EntitySummary.category` is optional for exactly this reason,
 * so the caller omits the key rather than inventing a bucket. Defaulting to
 * `to_do` here would file twenty kinds of row under a tab nobody put them in —
 * the same shape of lie the `open` fallback was.
 */
export function narrowStatusCategory(raw: unknown, entityId: string): StatusCategory | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string' && (STATUS_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as StatusCategory;
  }
  throw new StatusCategoryDriftError(String(raw), entityId);
}

/**
 * The category fragment of an `EntitySummary`, ready to spread.
 *
 * A spread rather than an assignment because the key must be ABSENT, not
 * `undefined`, when there is no status: `EntitySummarySchema` is `.strict()`
 * and the difference is visible to `Object.keys`, to a JSON body, and to the
 * event feed's structural equality checks.
 */
export function categoryFragment(raw: unknown, entityId: string): { category?: StatusCategory } {
  const category = narrowStatusCategory(raw, entityId);
  return category === undefined ? {} : { category };
}
