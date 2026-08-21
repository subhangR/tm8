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
 * Server config for the desktop shell: an ephemeral HTTP port.
 *
 * `loadConfig` refuses `TM8_PORT=0` on purpose — an operator who asks for port
 * 0 has asked for an address they cannot then find. That refusal is right and
 * is left intact; the desktop app instead uses the substitution seam the test
 * harnesses already use (`main.ts`'s preview-port comment), because here the
 * address *is* discoverable: the child reports it over IPC.
 */
export function desktopServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const requested = env['TM8_PORT']?.trim();
  const ephemeral = requested === undefined || requested === '' || requested === '0';
  if (!ephemeral) return loadConfig(env);

  const withoutPort: NodeJS.ProcessEnv = { ...env };
  delete withoutPort['TM8_PORT'];
  return { ...loadConfig(withoutPort), port: 0 };
}
