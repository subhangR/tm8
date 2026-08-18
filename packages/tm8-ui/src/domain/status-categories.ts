/**
 * The TRANSITIONAL bridge between the closed category union and the task
 * `workStatus` vocabulary, client-side — registry-adjacent DATA in the same
 * D18 sense as `HOME_RAIL_KINDS`: it names vocabulary members, so it lives in
 * `domain/` where kind vocabulary is legal, and nowhere else.
 *
 * WHY IT MAY EXIST AT ALL, given that the program is retiring exactly this
 * kind of inline bucketing (rulings addendum §5 lists six it deletes): this
 * is the WRITE direction, not the read direction. Reads always use the
 * server-computed `EntitySummary.category`; what a client cannot avoid until
 * phase 5 re-keys writes to workflow-state ids is choosing WHICH settable
 * status a category-level action means. The primary answer is the kind's
 * workflow (default state of the category — see board-v2's `categoryDropFor`);
 * this map is only the fallback for spaces whose kinds resolve to the
 * display-named global default workflow, whose state names are nobody's
 * settable vocabulary.
 *
 * The members mirror migration 149's category defaults (`open` and `done` are
 * their categories' `is_default` states; `working`/`cancelled` the ruled
 * canonical members). DELETE THIS FILE when phase 5 lands status ids on the
 * write path.
 */
import type { StatusCategory } from '@tm8/contract';

export const CATEGORY_DEFAULT_STATUS: Readonly<Partial<Record<StatusCategory, string>>> = {
  to_do: 'open',
  in_progress: 'working',
  done: 'done',
  cancelled: 'cancelled',
};
