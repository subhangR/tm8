/**
 * W11-repoint, THE DRY RUN of migration 245 (plan 01a0d9eb W11; owner step 2,
 * after W11-migrate's real run).
 *
 * 245 re-points chats, work_sessions and worktrees at the space's project
 * entity and DROPS their folder column project_id. That drop is irreversible,
 * so the owner runs this first: it counts, applies 245's own text inside a
 * transaction, counts again and ROLLS BACK. Nothing it does survives.
 *
 *   loadRepointCounts    one read: per table, the project columns' shape and
 *                        every row 245's CHECKs would refuse (with ids);
 *   dryRunRepoint        begin -> before -> 245 -> after -> rollback; a
 *                        refusal is 245's own preflight message, verbatim;
 *   formatRepointReport  the before/after table the PR and the RUNBOOK quote.
 *
 * The counts never name project_id unless the column is still there, so the
 * same read serves both sides of the migration.
 */

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Folder id -> owning space id: W11-migrate's owner-confirmed table (#856's shape). */
export type W11ConfirmedTable = Readonly<Record<string, string>>;

export interface RepointViolator {
  id: string;
  sessionKind: string;
  workdirMode: string;
}

export interface SharedFolder {
  folderId: string;
  folderName: string;
  spaces: number;
  /** The owner-confirmed space for this folder, or null when the table has none. */
  confirmedSpaceId: string | null;
}

export interface RepointCounts {
  /** False once 245 has dropped the folder columns. */
  folderColumns: boolean;
  chats: { total: number; byMode: Record<string, number>; withEntity: number; violators: string[] };
  worktrees: { total: number; withEntity: number; withSpace: number; residue: number };
  workSessions: {
    byMode: Record<string, number>;
    projectWithEntity: number;
    /** Rows the fallback CHECK refuses, by kind/mode. */
    violators: RepointViolator[];
  };
  /** Rows with a folder whose entity is missing or stands for another folder. */
  residue: { chats: number; workSessions: number; worktrees: number } | null;
  entityBranchCollisions: number;
  multiEntityPairs: number;
  sharedFolders: SharedFolder[];
  /**
   * internal.node_policy 'project_folders' (234, decision 29), or null for no
   * row. Only 'shared' skips 245's sharing refusal; it is written by the
   * server at boot from its gate posture, so read it before applying 245.
   */
  projectFoldersPolicy: string | null;
}

const num = (value: unknown): number => Number(value ?? 0);

async function byMode(client: Queryable, table: 'chats' | 'work_sessions'): Promise<Record<string, number>> {
  const { rows } = await client.query(
    `select workdir_mode mode, count(*)::int n from public.${table} group by 1 order by 1`);
  return Object.fromEntries(rows.map((r) => [String(r.mode), num(r.n)]));
}

export async function loadRepointCounts(client: Queryable, confirmed: W11ConfirmedTable | null = null): Promise<RepointCounts> {
  const folderColumns = num((await client.query(
    `select count(*)::int n from information_schema.columns
      where table_schema = 'public' and column_name = 'project_id'
        and table_name in ('chats', 'work_sessions', 'worktrees')`)).rows[0]?.n) === 3;

  const chat = (await client.query(
    `select count(*)::int total,
            count(*) filter (where project_entity_id is not null)::int with_entity,
            coalesce(array_agg(entity_id::text order by entity_id) filter (
              where not ((workdir_mode = 'scratch' and project_entity_id is null)
                      or (workdir_mode <> 'scratch' and project_entity_id is not null))), '{}') violators
       from public.chats`)).rows[0] ?? {};

  const wt = (await client.query(
    `select count(*)::int total,
            count(*) filter (where project_entity_id is not null)::int with_entity,
            count(*) filter (where space_id is not null)::int with_space
       from public.worktrees`)).rows[0] ?? {};

  const wsProject = (await client.query(
    `select count(*) filter (where workdir_mode = 'project' and project_entity_id is not null)::int n
       from public.work_sessions`)).rows[0] ?? {};

  // The CHECK 245 adds, evaluated before it exists.
  const violators = (await client.query(
    `select entity_id::text id, session_kind, workdir_mode from public.work_sessions
      where not (session_kind = 'credential' or workdir_mode in ('scratch', 'container')
                 or project_entity_id is not null)
      order by entity_id`)).rows.map((r) => ({
    id: String(r.id), sessionKind: String(r.session_kind), workdirMode: String(r.workdir_mode),
  }));

  let residue: RepointCounts['residue'] = null;
  if (folderColumns) {
    const r = (await client.query(
      `select
         (select count(*) from public.chats c
           where c.project_id is not null and not exists (
             select 1 from public.project_links l where l.project_entity_id = c.project_entity_id
                and l.space_id = c.space_id and l.project_id = c.project_id))::int chats,
         (select count(*) from public.work_sessions ws join public.entities e on e.id = ws.entity_id
           where ws.project_id is not null and not exists (
             select 1 from public.project_links l where l.project_entity_id = ws.project_entity_id
                and l.space_id = e.space_id and l.project_id = ws.project_id))::int work_sessions,
         (select count(*) from public.worktrees w
           where not exists (
             select 1 from public.project_links l where l.project_entity_id = w.project_entity_id
                and l.space_id = w.space_id and l.project_id = w.project_id))::int worktrees`)).rows[0] ?? {};
    residue = { chats: num(r.chats), workSessions: num(r.work_sessions), worktrees: num(r.worktrees) };
  }

  const collisions = (await client.query(
    `select count(*)::int n from (select 1 from public.worktrees
       group by project_entity_id, branch having count(*) > 1) d`)).rows[0] ?? {};
  const pairs = (await client.query(
    `select count(*)::int n from (select 1 from public.project_links
       group by space_id, project_id having count(*) > 1) d`)).rows[0] ?? {};
  const policy = (await client.query(
    `select value from internal.node_policy where key = 'project_folders'`)).rows[0];
  const shared = (await client.query(
    `select sp.project_id::text folder_id, p.name folder_name, count(*)::int spaces
       from public.space_projects sp join public.projects p on p.id = sp.project_id
      group by sp.project_id, p.name having count(*) > 1
      order by sp.project_id`)).rows;

  return {
    folderColumns,
    chats: {
      total: num(chat.total), byMode: await byMode(client, 'chats'),
      withEntity: num(chat.with_entity), violators: (chat.violators as string[] | undefined) ?? [],
    },
    worktrees: {
      total: num(wt.total), withEntity: num(wt.with_entity), withSpace: num(wt.with_space),
      residue: residue?.worktrees ?? 0,
    },
    workSessions: { byMode: await byMode(client, 'work_sessions'), projectWithEntity: num(wsProject.n), violators },
    residue,
    entityBranchCollisions: num(collisions.n),
    multiEntityPairs: num(pairs.n),
    sharedFolders: shared.map((r) => ({
      folderId: String(r.folder_id), folderName: String(r.folder_name), spaces: num(r.spaces),
      confirmedSpaceId: confirmed?.[String(r.folder_id)] ?? null,
    })),
    projectFoldersPolicy: policy ? String(policy.value) : null,
  };
}

export interface RepointDryRun {
  before: RepointCounts;
  /** Null when 245 refused. */
  after: RepointCounts | null;
  /** 245's refusal, verbatim (message, then detail), or null when it applied. */
  refusal: string | null;
}

/**
 * Applies `migrationSql` between two reads and rolls everything back. The
 * client must be able to `set role tm8_graph_owner` (the migration's own
 * role switch), i.e. the owner connection `db/migrate.mjs` uses.
 */
export async function dryRunRepoint(client: Queryable, migrationSql: string, confirmed: W11ConfirmedTable | null = null): Promise<RepointDryRun> {
  await client.query('begin');
  try {
    const before = await loadRepointCounts(client, confirmed);
    await client.query('savepoint w11_repoint');
    try {
      await client.query(migrationSql);
    } catch (err) {
      await client.query('rollback to savepoint w11_repoint');
      const e = err as { message?: string; detail?: string };
      return { before, after: null, refusal: [e.message ?? String(err), e.detail].filter(Boolean).join('\n') };
    }
    await client.query('reset role');
    return { before, after: await loadRepointCounts(client, confirmed), refusal: null };
  } finally {
    await client.query('rollback');
  }
}

const modes = (m: Record<string, number>): string =>
  Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

function side(c: RepointCounts): string[] {
  const kinds = new Map<string, number>();
  for (const v of c.workSessions.violators) {
    const key = `${v.sessionKind}/${v.workdirMode}`;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  return [
    `project_id columns present   ${c.folderColumns ? 'yes' : 'no (dropped)'}`,
    `chats                        ${c.chats.total} (${modes(c.chats.byMode)}); with entity ${c.chats.withEntity}; CHECK violators ${c.chats.violators.length}`,
    `worktrees                    ${c.worktrees.total}; with entity ${c.worktrees.withEntity}; with space ${c.worktrees.withSpace}`,
    `work_sessions                ${modes(c.workSessions.byMode)}`,
    `  project with entity        ${c.workSessions.projectWithEntity}`,
    `  CHECK violators            ${c.workSessions.violators.length}${kinds.size ? ` (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
    `residue (chats/ws/worktrees) ${c.residue ? `${c.residue.chats}/${c.residue.workSessions}/${c.residue.worktrees}` : 'n/a (no folder columns)'}`,
    `(entity, branch) collisions  ${c.entityBranchCollisions}`,
    `(space, folder) > 1 entity   ${c.multiEntityPairs}`,
    `folders in > 1 space         ${c.sharedFolders.length}`,
    `node_policy project_folders  ${c.projectFoldersPolicy ?? 'no row'} (sharing refusal ${c.projectFoldersPolicy === 'shared' ? 'SKIPPED' : 'enforced'})`,
  ];
}

export function formatRepointReport(run: RepointDryRun): string {
  const out = ['# W11-repoint dry run (migration 245; rolled back)', '', '## Before', ...side(run.before)];
  if (run.before.sharedFolders.length > 0) {
    out.push('', '### Folders granted to more than one space');
    for (const f of run.before.sharedFolders) {
      out.push(`- ${f.folderId} "${f.folderName}": ${f.spaces} spaces; confirmed owner ${f.confirmedSpaceId ?? 'NONE'}`);
    }
  }
  if (run.before.workSessions.violators.length > 0) {
    out.push('', '### work_sessions the CHECK refuses');
    for (const v of run.before.workSessions.violators) out.push(`- ${v.id} (${v.sessionKind}/${v.workdirMode})`);
  }
  if (run.refusal !== null) {
    out.push('', '## 245 REFUSED', run.refusal);
  } else if (run.after !== null) {
    out.push('', '## After (inside the transaction, then rolled back)', ...side(run.after));
  }
  return out.join('\n');
}
