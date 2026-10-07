/**
 * EDGE FAMILIES — which section of the Links tab a relation is drawn under.
 *
 * The verb (`edge-verbs.ts`) says what one edge MEANS; the family says what a
 * reader is LOOKING FOR when they open Links: the work around this entity, the
 * code that ships it, the files it made or reads, the people on it, and — last,
 * folded by default — the sessions and system bookkeeping that record where it
 * came from. Grouping by family is what lets "Depends on" stop looking like
 * "Talked with".
 *
 * A family is a property of (type, direction), not of the type alone: a
 * session's OUTGOING `working_on` is the task it is doing (work), while a
 * task's INCOMING `working_on` is the sessions that ran on it (provenance).
 *
 * EVERY VERB ROW HAS A FAMILY. `edge-families.test.ts` holds these keys to
 * `EDGE_VERBS`, which is itself held to the migrations, so a new edge type
 * cannot land in a section by accident.
 */
import type { EdgeDirection } from './edge-verbs';

export type EdgeFamily = 'work' | 'code' | 'files' | 'people' | 'sessions';

/** Section order, top to bottom. Blocking is drawn above all of them. */
export const EDGE_FAMILY_ORDER: readonly EdgeFamily[] = ['work', 'code', 'files', 'people', 'sessions'];

export const EDGE_FAMILY_LABEL: Readonly<Record<EdgeFamily, string>> = {
  work: 'Work',
  code: 'Code',
  files: 'Files & docs',
  people: 'People',
  sessions: 'Sessions & provenance',
};

type FamilyRow = EdgeFamily | { out: EdgeFamily; in: EdgeFamily };

export const EDGE_FAMILIES: Readonly<Record<string, FamilyRow>> = {
  about: 'work',
  anchored_to: 'sessions',
  approval_requested_from: 'people',
  approved_by: 'people',
  assigned_to: 'people',
  attached_to: 'files',
  authored_from: 'sessions',
  based_on: 'files',
  completed_by: 'people',
  contains: 'work',
  controls: 'people',
  consumes: 'files',
  copy_of: 'files',
  created_in: 'sessions',
  defaults_to_profile: 'sessions',
  depends_on: 'work',
  derived_from: 'work',
  dislikes: 'people',
  dispatched_by: 'sessions',
  disputes: 'files',
  drives: 'sessions',
  equips: 'sessions',
  follows_up: 'work',
  has_member: 'people',
  in_project: 'work',
  in_worktree: 'work',
  likes: 'people',
  member_of: 'people',
  messaged: 'sessions',
  mounts: 'sessions',
  participates_in: { out: 'sessions', in: 'people' },
  produces: 'files',
  pulled: 'people',
  relates_to: 'work',
  remembers: 'files',
  runs_in: 'sessions',
  runs_on: 'sessions',
  selected_profile: 'sessions',
  shared_into: 'sessions',
  snapshot_of: 'sessions',
  stars: 'people',
  supersedes: 'files',
  tracks: 'code',
  triggered_by: 'work',
  verifies: 'files',
  visible_to: 'people',
  working_on: { out: 'work', in: 'sessions' },
};

/** The family for one direction of one type. An unknown type reads as work. */
export function edgeFamily(type: string, direction: EdgeDirection): EdgeFamily {
  const row = EDGE_FAMILIES[type];
  if (!row) return 'work';
  if (typeof row === 'string') return row;
  return direction === 'outgoing' ? row.out : row.in;
}
