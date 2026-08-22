/**
 * The desktop profile: tm8-server running as the forked child of an Electron
 * shell, owning its own Postgres.
 *
 * This is deliberately a thin adapter and not a second server bootstrap. The
 * `.app` forks the *same* `packages/server/dist/index.js` the server install
 * runs (`deploy/prod/run-server.sh`), because the moment the desktop app has
 * its own entry point the two shapes start to drift and every bug becomes two
 * bugs. Everything desktop-specific is here, behind one environment flag.
 *
 * What `TM8_DESKTOP=1` turns on:
 *
 *  - `ensureSidecar()` — the first production construction of `SidecarManager`.
 *    Until now the only caller in the repo was a live test.
 *  - a socket-only Postgres profile (`listen_addresses = ''`), so the port
 *    number names a file inside a 0700 data dir and cannot collide with the
 *    developer's own cluster on 5442.
 *  - both database URLs derived from that socket: the app pool as `tm8_app`
 *    and the delivery pool as `tm8_delivery_worker`. The second one is the
 *    whole reason this app bundles a real Postgres — `verifyDeliveryPrincipal`
 *    requires a genuine second *login*, which PGlite cannot provide.
 *  - an ephemeral HTTP port, reported back to the shell over IPC.
 *
 * It grants no new capability to the renderer: there is no IPC spawn surface
 * here and the UI is loaded over ordinary same-origin HTTP (AM-7/T-D24).
 */

import { createHash } from 'node:crypto';

import { loadConfig, type ServerConfig } from './http/config.js';
import { socketConnectionUrl } from './sidecar/migrate.js';
import { ensureSidecar, type SidecarManager } from './sidecar/manager.js';

/** Role the delivery pool must AUTHENTICATE as — `facade/services/w2/execution.ts`. */
export const DELIVERY_ROLE = 'tm8_delivery_worker';

export function isDesktopProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['TM8_DESKTOP']?.trim() === '1';
}

/** What the shell is told, and the only vocabulary its status line needs. */
export type DesktopPhase =
  | 'starting'
  | 'database'
  | 'migrations'
  | 'server'
  | 'ready'
  | 'failed'
  | 'stopping';

export interface DesktopMessage {
  readonly type: 'tm8:desktop';
  readonly phase: DesktopPhase;
  readonly message: string;
  readonly url?: string;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Report to the Electron parent. A no-op when there is no IPC channel, so the
 * same code path runs unchanged under a bare `node dist/index.js`.
 */
export function report(msg: Omit<DesktopMessage, 'type'>): void {
  process.send?.({ type: 'tm8:desktop', ...msg } satisfies DesktopMessage);
}

/**
 * Boot Postgres and publish the two DSNs the rest of `bootstrap()` reads out of
 * the environment.
 *
 * The URLs are published into `process.env` rather than threaded through
 * `BootstrapOptions` because that is where `loadConfig()` and the delivery
 * wiring already look for them; inventing a second way to say the same thing
 * would mean two places to get it wrong.
 */
export async function bootDesktopSidecar(): Promise<SidecarManager> {
  report({ phase: 'database', message: 'Starting your local database…' });

  const sidecar = await ensureSidecar({
    logger: {
      info: (m) => {
        console.log(`[sidecar] ${m}`);
        // `migrations: applying …` is the one line worth ~2.4 s of a user's
        // attention, so it is the one that changes the status text.
        if (m.startsWith('migrations:')) {
          report({ phase: 'migrations', message: 'Preparing your workspace…' });
        }
      },
      warn: (m, detail) => console.warn(`[sidecar] ${m}${detail ? `\n${String(detail)}` : ''}`),
      error: (m, detail) => console.error(`[sidecar] ${m}${detail ? `\n${String(detail)}` : ''}`),
      debug: () => undefined,
    },
  });

  const cfg = sidecar.config;
  process.env['TM8_DATABASE_URL'] ??= socketConnectionUrl(cfg, cfg.appRole);
  process.env['TM8_DELIVERY_DATABASE_URL'] ??= socketConnectionUrl(cfg, DELIVERY_ROLE);

  console.log(
    `desktop: postgres ${cfg.pgMajor} on ${cfg.socketDir}/.s.PGSQL.${cfg.pgPort} ` +
      `(socket-only: listen_addresses=${JSON.stringify(cfg.listenAddresses)})`,
  );
  return sidecar;
}

/**
 * Ask the kernel for a free loopback port and give it straight back.
 *
 * WHY NOT JUST `port: 0`. Leaving the port as 0 and reading the real one off
 * the listening socket is the obvious move, and it is wrong here, because
 * `config.port` is read by things that run BEFORE `server.listen()` and capture
 * their value eagerly:
 *
 *   - `execution-handlers.ts` builds `SpawnService`'s `baseUrl` and `nodeId`
 *     from it at wiring time. With port 0 every agent this node spawns is
 *     handed `TM8_BASE_URL=http://127.0.0.1:0` and is deaf to the graph —
 *     measured: the agent's first act was to report "the tm8 server isn't
 *     responding", and it could not send a single message.
 *   - `main.ts` builds the chat runtime's `baseUrl` the same way.
 *   - `loadConfig` derives the app's own allowed origins from it.
 *
 * A concrete port makes all of them true at once. The bind/close/rebind window
 * is microseconds inside a single process, and the kernel does not immediately
 * re-issue an ephemeral port it has just handed out — a far better trade than
 * three subsystems holding a port number that was never real.
 */
async function reserveEphemeralPort(host: string): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('tm8: could not reserve a loopback port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Server config for the desktop shell: a real, free, unpredictable HTTP port.
 *
 * `loadConfig` refuses `TM8_PORT=0` on purpose — an operator who asks for port
 * 0 has asked for an address they cannot then find. That refusal is right and
 * is left intact. `TM8_PORT=0` from the shell means "pick one for me", and it
 * is resolved to a number here, before `loadConfig` derives anything from it.
 */
export async function desktopServerConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const requested = env['TM8_PORT']?.trim();
  if (requested !== undefined && requested !== '' && requested !== '0') return loadConfig(env);

  const host = env['TM8_BIND']?.trim() || '127.0.0.1';
  const port = await reserveEphemeralPort(host);
  return loadConfig({ ...env, TM8_PORT: String(port) });
}

/**
 * A node identity that survives a relaunch.
 *
 * `createExecutionRuntime` defaults `nodeId` to `<host>:<port>`, which is
 * stable for a server install on a fixed port and CHANGES EVERY LAUNCH for a
 * desktop app on an ephemeral one. That is not cosmetic — `nodeId` is the key
 * for two pieces of cleanup that only ever run against *this* node's own rows:
 *
 *   - `worktree_allocations.node_id` is NOT NULL because, in SpawnService's own
 *     words, "an allocation nobody owns is one nobody reconciles, which is a
 *     leaked checkout". A node that renames itself on every launch abandons
 *     every checkout it ever made.
 *   - `reconcileNodeGhosts` retires sessions this node left behind when it
 *     died. Under a new identity there is nothing to retire, so a `kill -9`
 *     leaves sessions marked running for ever.
 *
 * The data directory is the thing that actually persists here, so derive from
 * it: stable across launches, distinct for a second install pointed elsewhere,
 * and no extra state file that could disagree with reality.
 */
export function desktopNodeId(dataDir: string): string {
  return `tm8-desktop:${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}`;
}
