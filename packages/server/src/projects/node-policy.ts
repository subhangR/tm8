/**
 * Decision 29 — may one folder be linked into several spaces on this node?
 *
 * Only on a node whose gate is closed to everyone but this machine: a
 * `single` node with no public origin, no extra hostnames, no extra origins,
 * and no preview reachable by a non-loopback name. Everywhere else a folder
 * belongs to one space (decision 28).
 *
 * The answer lives in `internal.node_policy` (234), a table `tm8_app` has no
 * grant on. The server writes it once at boot through the OWNER role, before
 * it serves anything; the guard trigger and `create_space_project` read it
 * through `internal.project_folders_shared()`. Any value other than `'shared'`,
 * or no row at all, means one space per folder — so a boot that cannot write
 * the row refuses to start rather than leave a previous posture's row behind.
 */
import pg from 'pg';
import { isLoopback, type ServerConfig } from '../http/config.js';

export type GatePosture = 'loopback' | 'open';

/** The node's gate posture, from config alone. */
export function gatePosture(
  config: Pick<ServerConfig, 'nodeMode' | 'publicOrigin' | 'extraAllowedHostnames' | 'allowedOrigins' | 'preview'>,
): GatePosture {
  if ((config.nodeMode ?? 'single') !== 'single') return 'open';
  if (config.publicOrigin) return 'open';
  if ((config.extraAllowedHostnames ?? []).length > 0) return 'open';
  if ((config.allowedOrigins ?? []).length > 0) return 'open';
  if (config.preview && !isLoopback(config.preview.host)) return 'open';
  return 'loopback';
}

export const PROJECT_FOLDERS_POLICY_KEY = 'project_folders';

/** The `internal.node_policy` value a posture writes. Only `'shared'` shares. */
export function projectFoldersPolicy(posture: GatePosture): 'shared' | 'one_space' {
  return posture === 'loopback' ? 'shared' : 'one_space';
}

/**
 * Upsert the node's project-folders policy as the owner role. Its own client,
 * not the claims pool: every `Db.tx` drops to `tm8_app`, which is exactly the
 * role this table refuses. Throws on failure; the caller must not serve.
 */
export async function writeNodePolicy(databaseUrl: string, posture: GatePosture): Promise<'shared' | 'one_space'> {
  const value = projectFoldersPolicy(posture);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into internal.node_policy (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [PROJECT_FOLDERS_POLICY_KEY, value],
    );
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** The index a 'one_space' node should carry (234's DDL; built by #874's migration). */
export const ONE_SPACE_INDEX = 'space_projects_one_space_per_folder';

/**
 * True when `public.space_projects` lacks the one-space-per-folder unique
 * index. Boot asks only on a 'one_space' node and WARNS, never refuses: the
 * migration that builds it skips (NOTICE) on a node that had no policy row
 * yet, and refuses while a folder is still granted to two spaces — both leave
 * the index missing with the migration recorded as applied. The guard trigger
 * still enforces new grants; this makes the missing index visible.
 */
export async function oneSpaceIndexMissing(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ missing: boolean }>(
      `select not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = $1) as missing`,
      [ONE_SPACE_INDEX],
    );
    return rows[0]?.missing === true;
  } finally {
    await client.end();
  }
}
