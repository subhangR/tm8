/**
 * W11-migrate, THE DRY-RUN REPORT (plan 01a0d9eb §3 W11 steps 1, 2 and 4; K13,
 * accepted as decision 38).
 *
 * Before 231 a folder could be granted to several spaces; 7 folders on the prod
 * node are granted to two. The split gives each folder ONE owning space and the
 * other space either its own clone or nothing. This file is the part that
 * decides and reports; it never writes:
 *
 *   loadW11Evidence   one read of the node: every (folder, space) grant of a
 *                     folder granted more than once, with its sessions, chats
 *                     and worktrees, counted over a window ending at `asOf`;
 *   buildW11Report    per folder: the owning space by `pickOwningSpace` (the
 *                     K13 seam), and clone-or-unlink for every other space;
 *   realRunRefusals   the two refusals a real run must honour: no owner-
 *                     confirmed table for the folder, or a live session in
 *                     either space.
 *
 * THE REAL RUN IS NOT HERE. It clones folders and re-points rows, and it runs
 * only after the owner confirms each folder from this report. Nothing in this
 * file changes a row.
 *
 * Activity (K13 "most activity in the last 30 days"; the plan's unlink rule
 * says "no sessions or chats on the project in 30 days", so the same two
 * sources count): work sessions CREATED in the window, plus chats whose last
 * message (or, with none, whose creation) falls in the window. A session is on
 * the folder by `work_sessions.project_id`, in the space of its entity. A chat
 * is on the folder by `chats.project_id`, or by a `cwd` at or under the
 * folder's path (chats on the prod node carry cwd and no project_id).
 */
import { pickOwningSpace } from './owning-space.js';

export const DEFAULT_WINDOW_DAYS = 30;

/** One (folder, space) grant of a folder that is granted to more than one space. */
export interface W11Evidence {
  folderId: string;
  folderName: string;
  workingDir: string;
  spaceId: string;
  spaceName: string;
  spaceCreatedAt: string;
  spaceCreatedBy: string | null;
  sessions: number;
  sessionsInWindow: number;
  liveSessions: number;
  lastSessionAt: string | null;
  chats: number;
  chatsInWindow: number;
  lastChatAt: string | null;
  worktrees: number;
  activeWorktrees: number;
  /** Branches of this space's worktrees on the folder: what a clone carries over. */
  worktreeBranches: string[];
}

export interface W11SpaceRow extends W11Evidence {
  activity: number;
  /** Owner: 'keep'. Other: 'clone' when it was active in the window, else 'unlink'. */
  action: 'keep' | 'clone' | 'unlink';
}

export interface W11ProjectRow {
  folderId: string;
  folderName: string;
  workingDir: string;
  owningSpaceId: string;
  /** True when the top activity is shared, so the tie-break decided. */
  tie: boolean;
  spaces: W11SpaceRow[];
  liveSessions: number;
}

export interface W11Report {
  asOf: string;
  windowDays: number;
  /** The identity whose spaces win a tie (K13 "your personal/first space"). */
  personalIdentity: string | null;
  projects: W11ProjectRow[];
}

/**
 * Evidence for every folder granted to more than one space. $1 = asOf, $2 =
 * window in days. Read-only; needs a role that sees every space (the node's
 * migration role), since the report spans spaces.
 */
export const W11_EVIDENCE_SQL = `
with shared as (
  select project_id from public.space_projects group by project_id having count(*) > 1
), win as (
  select $1::timestamptz as as_of, $1::timestamptz - make_interval(days => $2::int) as since
), grants as (
  select sp.project_id, sp.space_id, p.name folder_name, p.working_dir
    from public.space_projects sp
    join shared using (project_id)
    join public.projects p on p.id = sp.project_id
), sess as (
  select g.project_id, g.space_id,
         count(*) total,
         count(*) filter (where ws.created_at > win.since and ws.created_at <= win.as_of) in_window,
         count(*) filter (where ws.status in ('spawning', 'running', 'idle')) live,
         max(ws.created_at) last_at
    from grants g
    cross join win
    join public.work_sessions ws on ws.project_id = g.project_id
    join public.entities e on e.id = ws.entity_id and e.space_id = g.space_id
   group by g.project_id, g.space_id
), cht as (
  select g.project_id, g.space_id,
         count(*) total,
         count(*) filter (where coalesce(m.last_at, c.created_at) > win.since
                            and coalesce(m.last_at, c.created_at) <= win.as_of) in_window,
         max(coalesce(m.last_at, c.created_at)) last_at
    from grants g
    cross join win
    join public.chats c
      on c.space_id = g.space_id
     and (c.project_id = g.project_id
          or c.cwd = g.working_dir
          or c.cwd like replace(replace(replace(g.working_dir, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%')
    left join lateral (
      select max(msg.created_at) last_at from public.messages msg
       where msg.anchor_id = c.entity_id and msg.created_at <= win.as_of
    ) m on true
   group by g.project_id, g.space_id
), wt as (
  select g.project_id, g.space_id,
         count(*) total,
         count(*) filter (where w.status = 'active') active,
         array_agg(w.branch order by w.branch) branches
    from grants g
    join public.worktrees w on w.project_id = g.project_id
    join public.entities e on e.id = w.entity_id
   where coalesce(w.space_id, e.space_id) = g.space_id
   group by g.project_id, g.space_id
)
select g.project_id::text folder_id, g.folder_name, g.working_dir,
       s.id::text space_id, s.name space_name, s.created_at space_created_at,
       s.created_by_identity space_created_by,
       coalesce(sess.total, 0)::int sessions, coalesce(sess.in_window, 0)::int sessions_in_window,
       coalesce(sess.live, 0)::int live_sessions, sess.last_at last_session_at,
       coalesce(cht.total, 0)::int chats, coalesce(cht.in_window, 0)::int chats_in_window,
       cht.last_at last_chat_at,
       coalesce(wt.total, 0)::int worktrees, coalesce(wt.active, 0)::int active_worktrees,
       coalesce(wt.branches, '{}') worktree_branches
  from grants g
  join public.spaces s on s.id = g.space_id
  left join sess on sess.project_id = g.project_id and sess.space_id = g.space_id
  left join cht on cht.project_id = g.project_id and cht.space_id = g.space_id
  left join wt on wt.project_id = g.project_id and wt.space_id = g.space_id
 order by g.folder_name, g.project_id, s.created_at, s.id`;

/** The node owner (002's single `is_owner` row): K13's default tie-break identity. */
export const NODE_OWNER_SQL = 'select identity_id from public.accounts where is_owner limit 1';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null
    : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export async function loadW11Evidence(client: Queryable, asOf: string, windowDays = DEFAULT_WINDOW_DAYS): Promise<W11Evidence[]> {
  const { rows } = await client.query(W11_EVIDENCE_SQL, [asOf, windowDays]);
  return rows.map((r) => ({
    folderId: String(r.folder_id),
    folderName: String(r.folder_name),
    workingDir: String(r.working_dir),
    spaceId: String(r.space_id),
    spaceName: String(r.space_name),
    spaceCreatedAt: iso(r.space_created_at)!,
    spaceCreatedBy: r.space_created_by === null ? null : String(r.space_created_by),
    sessions: Number(r.sessions),
    sessionsInWindow: Number(r.sessions_in_window),
    liveSessions: Number(r.live_sessions),
    lastSessionAt: iso(r.last_session_at),
    chats: Number(r.chats),
    chatsInWindow: Number(r.chats_in_window),
    lastChatAt: iso(r.last_chat_at),
    worktrees: Number(r.worktrees),
    activeWorktrees: Number(r.active_worktrees),
    worktreeBranches: (r.worktree_branches as string[] | null) ?? [],
  }));
}

export async function loadNodeOwnerIdentity(client: Queryable): Promise<string | null> {
  const { rows } = await client.query(NODE_OWNER_SQL);
  return rows[0] ? String(rows[0].identity_id) : null;
}

/**
 * Pure. Groups the evidence by folder, picks each folder's owning space with
 * `pickOwningSpace`, and marks every other space clone (active in the window)
 * or unlink (idle in the window).
 */
export function buildW11Report(args: {
  evidence: readonly W11Evidence[];
  personalIdentity: string | null;
  asOf: string;
  windowDays?: number;
}): W11Report {
  const byFolder = new Map<string, W11Evidence[]>();
  for (const row of args.evidence) {
    const rows = byFolder.get(row.folderId) ?? [];
    rows.push(row);
    byFolder.set(row.folderId, rows);
  }
  const projects: W11ProjectRow[] = [];
  for (const rows of byFolder.values()) {
    const activityOf = (r: W11Evidence) => r.sessionsInWindow + r.chatsInWindow;
    const owningSpaceId = pickOwningSpace(rows.map((r) => ({
      spaceId: r.spaceId,
      activity30d: activityOf(r),
      createdByOwner: args.personalIdentity !== null && r.spaceCreatedBy === args.personalIdentity,
      createdAt: r.spaceCreatedAt,
    })))!;
    const top = Math.max(...rows.map(activityOf));
    const spaces = rows.map((r): W11SpaceRow => ({
      ...r,
      activity: activityOf(r),
      action: r.spaceId === owningSpaceId ? 'keep' : activityOf(r) > 0 ? 'clone' : 'unlink',
    }));
    projects.push({
      folderId: rows[0]!.folderId,
      folderName: rows[0]!.folderName,
      workingDir: rows[0]!.workingDir,
      owningSpaceId,
      tie: rows.filter((r) => activityOf(r) === top).length > 1,
      spaces,
      liveSessions: rows.reduce((n, r) => n + r.liveSessions, 0),
    });
  }
  projects.sort((a, b) => a.folderName.localeCompare(b.folderName) || a.folderId.localeCompare(b.folderId));
  return {
    asOf: args.asOf,
    windowDays: args.windowDays ?? DEFAULT_WINDOW_DAYS,
    personalIdentity: args.personalIdentity,
    projects,
  };
}

/** The owner-confirmed table: folder id -> owning space id. */
export type W11ConfirmedTable = Readonly<Record<string, string>>;

export type W11Refusal =
  | { code: 'no_confirmed_table' }
  | { code: 'folder_not_confirmed'; folderId: string }
  | { code: 'confirmed_space_not_granted'; folderId: string; spaceId: string }
  | { code: 'live_sessions'; folderId: string; liveSessions: number };

/**
 * What a real run must refuse, per plan step 4 and K13's confirmation: with no
 * table it refuses outright; otherwise every folder it would split needs a
 * confirmed owning space that is one of its grants, and no live session in
 * any of its spaces. Empty means a real run may proceed for every folder.
 */
export function realRunRefusals(report: W11Report, confirmed: W11ConfirmedTable | null): W11Refusal[] {
  if (confirmed === null) return [{ code: 'no_confirmed_table' }];
  const refusals: W11Refusal[] = [];
  for (const project of report.projects) {
    const spaceId = confirmed[project.folderId];
    if (spaceId === undefined) refusals.push({ code: 'folder_not_confirmed', folderId: project.folderId });
    else if (!project.spaces.some((s) => s.spaceId === spaceId)) {
      refusals.push({ code: 'confirmed_space_not_granted', folderId: project.folderId, spaceId });
    }
    if (project.liveSessions > 0) {
      refusals.push({ code: 'live_sessions', folderId: project.folderId, liveSessions: project.liveSessions });
    }
  }
  return refusals;
}

const day = (value: string | null): string => (value ? value.slice(0, 10) : '—');

/** Markdown: one table row per folder, then the per-space evidence. */
export function formatW11Report(report: W11Report): string {
  const nameOf = (project: W11ProjectRow, spaceId: string) =>
    project.spaces.find((s) => s.spaceId === spaceId)?.spaceName ?? spaceId;
  const lines = [
    `W11-migrate dry run — ${report.projects.length} folder(s) granted to more than one space`,
    `as of ${report.asOf}; window ${report.windowDays} days; ties go to spaces created by ${report.personalIdentity ?? '(none)'}`,
    '',
    '| Folder | Proposed owner | Decided by | Other space(s) | Live sessions (real run) |',
    '|---|---|---|---|---|',
  ];
  for (const p of report.projects) {
    const owner = p.spaces.find((s) => s.spaceId === p.owningSpaceId)!;
    const others = p.spaces.filter((s) => s.spaceId !== p.owningSpaceId)
      .map((s) => `${s.spaceName} → ${s.action}${s.action === 'clone' ? ` (${s.worktreeBranches.length} branch(es))` : ''}`)
      .join('; ');
    lines.push(`| ${p.folderName} \`${p.workingDir}\` | ${nameOf(p, p.owningSpaceId)} | `
      + `${p.tie ? `tie at ${owner.activity} → tie-break` : `activity ${owner.activity}`} | ${others} | `
      + `${p.liveSessions > 0 ? `${p.liveSessions} → REFUSE until stopped` : '0'} |`);
  }
  lines.push('', '| Folder | Space | Space id | Activity | Sessions (window/total/live, last) | Chats (window/total, last) | Worktrees (active/total) |',
    '|---|---|---|---|---|---|---|');
  for (const p of report.projects) {
    for (const s of p.spaces) {
      lines.push(`| ${p.folderName} | ${s.spaceName}${s.spaceId === p.owningSpaceId ? ' (owner)' : ''} | \`${s.spaceId}\` | ${s.activity} | `
        + `${s.sessionsInWindow}/${s.sessions}/${s.liveSessions}, ${day(s.lastSessionAt)} | `
        + `${s.chatsInWindow}/${s.chats}, ${day(s.lastChatAt)} | ${s.activeWorktrees}/${s.worktrees} |`);
    }
  }
  return lines.join('\n');
}
