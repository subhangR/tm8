/**
 * The session host registry over migration 250's node-admin RPCs (task
 * 01a0db31, design doc 01a0db5e R5). Rows are this node's: every call carries
 * `nodeId`, and the table itself is unreadable to tm8_app — the controller
 * token in it drives every agent its host holds.
 */
import { join } from 'node:path';
import { NODE_BOOT_ID, SessionHostPool, type SessionHostRegistry, type SessionHostRow } from '@tm8/execution';
import type { Db, DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';

export interface DbSessionHostRegistryDeps {
  db: Db;
  /** A node admin (the loopback owner): every RPC requires one. */
  claims: DbClaims;
  nodeId: string;
  /** The pool's data dir; host sockets live in `<dataDir>/session-host/`. */
  dataDir: string;
}

export function createDbSessionHostRegistry(deps: DbSessionHostRegistryDeps): SessionHostRegistry {
  const { db, claims, nodeId } = deps;
  return {
    nodeId,
    async list() {
      return (await db.rpc<SessionHostRow[] | null>(claims, 'session_host_list', [nodeId])) ?? [];
    },
    async insert(row) {
      await db.rpc(claims, 'session_host_insert', [nodeId, row.generation, row.socketPath, row.token, row.pid]);
    },
    async setPid(generation, pid) {
      await db.rpc(claims, 'session_host_set_pid', [nodeId, generation, pid]);
    },
    async remove(generation) {
      await db.rpc(claims, 'session_host_remove', [nodeId, generation]);
    },
    async ownerOf(generation) {
      // By socket path: it is unique per data dir, where the generation is
      // shared by every node on the same build.
      const socketPath = join(deps.dataDir, 'session-host', `${generation}.sock`);
      return (await db.rpc<string | null>(claims, 'session_host_owner_of', [socketPath])) ?? null;
    },
  };
}

/**
 * Open this node's session hosts: reattach to the ones a previous process left
 * (the registry says where), retire dead ones, start this build's host.
 *
 * Returns undefined — and the node runs its agents in-process — only when the
 * registry itself is unreachable; that is said loudly on stderr, because every
 * agent started until the next boot will die with this process.
 */
export async function openSessionHosts(
  db: Db,
  owner: () => Promise<LoopbackOwner>,
  nodeId: string,
  dataDir: string,
): Promise<SessionHostPool | undefined> {
  try {
    const o = await owner();
    const registry = createDbSessionHostRegistry({
      db,
      claims: { identityId: o.identityId, nodeAdmin: o.isNodeAdmin },
      nodeId,
      dataDir,
    });
    return await SessionHostPool.open({
      dataDir,
      registry,
      serverBootId: NODE_BOOT_ID,
      logger: consoleLogger,
    });
  } catch (error) {
    console.error(
      '  session host: UNAVAILABLE — agents started by this process will not survive a restart:',
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

const consoleLogger = {
  info: (message: string, fields?: Record<string, unknown>) => console.log(`[session-host] ${message}`, fields ?? {}),
  warn: (message: string, fields?: Record<string, unknown>) => console.warn(`[session-host] ${message}`, fields ?? {}),
  debug: () => {},
  error: (message: string, error?: Error, fields?: Record<string, unknown>) =>
    console.error(`[session-host] ${message}`, error?.message ?? '', fields ?? {}),
};
