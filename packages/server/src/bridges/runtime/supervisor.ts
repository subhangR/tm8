/**
 * The connector runtime's sidecar, from the node's side (BRIDGE-ENTITY-DESIGN
 * §2.5): the node mints the runtime's `bridge_runtime` session when it starts
 * the sidecar (the 105 `agent_runtime` precedent), writes the bearer to a
 * 0600 file the runtime re-reads on every call (`TM8_BRIDGE_RUNTIME_TOKEN_FILE`,
 * runtime-main.ts), and re-mints it before half its life is spent. Each mint
 * revokes the previous token of the same label, so one sidecar holds one.
 *
 * Starting the process itself is optional: given a command, the supervisor
 * spawns it with the token file in its environment and restarts it with
 * backoff when it exits; without one, the deployment runs the runtime and
 * this only keeps the token file fresh.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Db, DbClaims } from '../../db/types.js';
import { SESSION_TTL_MS, issueBridgeRuntimeSession } from '../../identity/pg-auth.js';

export interface BridgeRuntimeSupervisorOptions {
  readonly db: Db;
  /** The node owner's claims (a node admin): the only caller the mint admits. */
  readonly ownerClaims: () => Promise<DbClaims>;
  readonly tokenFile: string;
  /** e.g. 'whatsapp-runtime'; the session label, one live token per label. */
  readonly label: string;
  /** Optional: the sidecar to run, e.g. ['node', '--import', 'tsx', 'src/runtime-main.ts']. */
  readonly command?: { file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  readonly serverUrl?: string;
  readonly log?: (line: string) => void;
}

/** Writes the token atomically, readable by the owner only. */
export async function writeTokenFile(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export class BridgeRuntimeSupervisor {
  private child: ChildProcess | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private stopping = false;
  private restarts = 0;
  sessionId: string | null = null;

  constructor(private readonly o: BridgeRuntimeSupervisorOptions) {}

  /** Mints a fresh session and writes it; answers the session id. */
  async mint(): Promise<string> {
    const issued = await issueBridgeRuntimeSession(this.o.db, await this.o.ownerClaims(), this.o.label);
    await writeTokenFile(this.o.tokenFile, issued.token);
    this.sessionId = issued.sessionId;
    return issued.sessionId;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.mint();
    this.refresh = setInterval(() => {
      void this.mint().catch((err) => this.o.log?.(`[bridges] runtime token re-mint failed: ${(err as Error).message}`));
    }, Math.floor(SESSION_TTL_MS.bridge_runtime / 2));
    this.refresh.unref();
    if (this.o.command) this.launch();
  }

  private launch(): void {
    const cmd = this.o.command!;
    const child = spawn(cmd.file, [...cmd.args], {
      cwd: cmd.cwd,
      env: {
        ...process.env,
        ...cmd.env,
        TM8_BRIDGE_RUNTIME_TOKEN_FILE: this.o.tokenFile,
        ...(this.o.serverUrl ? { TM8_SERVER_URL: this.o.serverUrl } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    this.child = child;
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.restarts++, 6));
      this.o.log?.(`[bridges] runtime exited (${signal ?? code}); restarting in ${delay} ms`);
      // A restart is a fresh start: a fresh session (§2.5), then the process.
      setTimeout(() => {
        if (this.stopping) return;
        void this.mint().then(() => this.launch(),
          (err) => this.o.log?.(`[bridges] runtime restart mint failed: ${(err as Error).message}`));
      }, delay).unref();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
