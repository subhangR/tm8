import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_MAX_OUTPUT_BYTES, type ToolDefinition } from '@tm8/contract';
import { OutputBuffer } from '../pty/OutputBuffer.js';
import type { PtyHostService } from '../pty/PtyHostService.js';
import type { FrameSink, Logger } from '../pty/types.js';
import { shellQuote } from '../spawn/manifest.js';
import { composeShellEnv } from '../shell/shell-env.js';
import { resolveLoginShell } from '../shell/ShellSessionLauncher.js';
import { redactToolOutput } from './output.js';
import type { ResolvedToolInputs } from './inputs.js';

export interface ToolExit {
  exitCode: number | null;
  state: 'exited' | 'timed_out' | 'killed';
  outputTail: string;
}
export interface ToolLaunchRequest {
  sessionId: string;
  toolId: string;
  toolVersion: number;
  definition: ToolDefinition;
  inputs: ResolvedToolInputs;
  cwd: string;
  keepOpen: boolean;
  token?: string;
  /** Called before spawning so even an instant process exit has captured claims. */
  onReady?: () => void;
  recordExit: (exit: ToolExit) => Promise<void>;
  revokeToken: () => Promise<void>;
  /** Explicit cleanup must also record the PTY's process ending. */
  closePty?: () => Promise<void>;
}
export interface ToolSessionLauncherOptions {
  pty: PtyHostService;
  dataDir: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  pollMs?: number;
}

/** Retry only the idempotent exit write; cleanup, revocation and redaction run once. */
async function recordExitWithRetry(record: ToolLaunchRequest['recordExit'], exit: ToolExit, deadline: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await record(exit); return; }
    catch (error) {
      if (attempt === 2) throw error;
      const backoff = 100 * 2 ** attempt;
      if (Date.now() + backoff >= deadline) throw error;
      await delay(backoff);
      if (Date.now() >= deadline) throw error;
    }
  }
}

/** A server-generated wrapper; no input value is interpolated into shell code. */
export function toolWrapper(request: Pick<ToolLaunchRequest, 'definition' | 'toolVersion' | 'cwd' | 'keepOpen'>,
  runDir: string, shell: string, secretKeys: readonly string[]): string {
  const script = join(runDir, request.definition.runtime === 'bash' ? 'tool.sh' : 'tool.py');
  const interpreter = request.definition.runtime === 'bash'
    ? `/bin/bash --noprofile --norc ${shellQuote(script)}` : `/usr/bin/python3 -I ${shellQuote(script)}`;
  const label = `${request.definition.name} v${request.toolVersion}`;
  const names = request.definition.inputs.map(input => `${input.name}${input.type === 'secret' ? '=[masked]' : ''}`).join(', ');
  // Unset before the follow-on shell's rc files execute. Use the server-resolved
  // shell, never an input's SHELL. Credentials mode stays off for the retained shell.
  const clean = [...new Set([...secretKeys, 'TM8_AGENT_TOKEN', 'TM8_SESSION_ID'])].map(key => `-u ${shellQuote(key)}`).join(' ');
  return `#!/bin/bash
printf '%s\\n' ${shellQuote(`── ${label} · inputs: ${names} ──`)}
start=$(/bin/date +%s)
cd -- ${shellQuote(request.cwd)}
if [ "$?" -eq 0 ]; then
  /usr/bin/timeout --foreground -k 10 ${request.definition.timeoutSeconds} ${interpreter}
  code=$?
else
  code=125
fi
at=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"exit":%s,"at":"%s"}\\n' "$code" "$at" > ${shellQuote(join(runDir, 'status.tmp'))}
/bin/mv -- ${shellQuote(join(runDir, 'status.tmp'))} ${shellQuote(join(runDir, 'status'))}
end=$(/bin/date +%s)
printf '\\n%s exited %s in %ss%s\\n' ${shellQuote(`── ${label}`)} "$code" "$((end-start))" ${shellQuote(request.keepOpen ? ' ── (shell is still open; exit to close)' : ' ──')}
${request.keepOpen ? `exec /usr/bin/env ${clean} ${shellQuote(shell)} -i` : 'exit "$code"'}
`;
}

/** Keeps tool completion separate from the lifetime of the interactive PTY. */
export class ToolSessionLauncher {
  private readonly live = new Map<string, { check: () => Promise<void>; stop: () => void }>();
  constructor(private readonly options: ToolSessionLauncherOptions) {}

  async launch(request: ToolLaunchRequest): Promise<{ sessionId: string; cwd: string; reused: boolean }> {
    if (this.options.pty.hasSession(request.sessionId)) return { sessionId: request.sessionId, cwd: request.cwd, reused: true };
    const deadline = Date.now() + request.definition.timeoutSeconds * 1000;
    const runDir = join(this.options.dataDir, 'tool-runs', request.sessionId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700);
    const sourceFile = join(runDir, request.definition.runtime === 'bash' ? 'tool.sh' : 'tool.py');
    const shell = resolveLoginShell(this.options.env ?? process.env);
    await writeFile(sourceFile, request.definition.source, { mode: 0o600 });
    await writeFile(join(runDir, 'run'), toolWrapper(request, runDir, shell, request.inputs.secretEnvKeys), { mode: 0o700 });
    const env = {
      ...composeShellEnv({ shell: '/bin/bash', parentEnv: this.options.env ?? process.env, baseUrl: this.options.baseUrl }),
      ...request.inputs.env,
      TM8_TOOL: request.definition.name, TM8_TOOL_SESSION: request.sessionId, TM8_RUN_DIR: runDir,
      TM8_SESSION_ID: request.sessionId, TM8_CREDENTIALS_MODE: 'off',
      ...(request.token ? { TM8_AGENT_TOKEN: request.token } : {}),
    };
    // Keep extra context before the persisted 64 KiB, so a literal straddling
    // the tail boundary can still be redacted BEFORE truncation.
    const secretValues = [...request.inputs.secretValues, ...(request.token ? [request.token] : [])];
    const contextBytes = Math.max(4096, ...secretValues.map(value => Buffer.byteLength(value)));
    const output = new OutputBuffer(TOOL_MAX_OUTPUT_BYTES + contextBytes * 2);
    let settled = false, checking = false, watcher: FSWatcher | undefined;
    let killProcessGroup = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      watcher?.close(); this.options.pty.removeSubscriber(request.sessionId, sink);
      this.live.delete(request.sessionId);
    };
    const settle = async (exit: number | null, state: ToolExit['state']) => {
      if (settled) return;
      settled = true;
      // The wrapper writes status just before exiting. Let node-pty deliver
      // that exit to the ordinary process writer before cleaning up children:
      // pty.kill() removes the entry and suppresses its late exit callback.
      if (!request.keepOpen) await this.options.pty.waitForBootSettlement(request.sessionId, 1000);
      const replay = this.options.pty.getReplay(request.sessionId, output.totalBytes);
      if (replay) output.append(replay.data);
      const outputTail = redactToolOutput(output.replayFrom(-1).data.toString('utf8'), secretValues);
      // timeout --foreground leaves background jobs in the PTY group. Closed
      // runs kill that group even when its leader already exited. Keep-open runs
      // preserve shell/jobs until explicit tab closure; only the new shell's
      // environment is scrubbed, so existing jobs can still hold secret envs.
      try {
        if (!request.keepOpen) {
          try {
            if (this.options.pty.hasSession(request.sessionId)) {
              if (request.closePty) await request.closePty();
              else this.options.pty.kill(request.sessionId);
            }
          } finally { killProcessGroup(); }
        }
      } catch (error) {
        this.options.logger?.error('Tool process group cleanup failed', error instanceof Error ? error : new Error(String(error)), { sessionId: request.sessionId });
      } finally {
        // Cleanup failure must never skip token revocation or outcome capture.
        try {
          try { await request.revokeToken(); }
          finally { await recordExitWithRetry(request.recordExit, { exitCode: exit, state, outputTail },
            deadline); }
        } finally {
          try { stop(); }
          finally { secretValues.fill(''); }
        }
      }
    };
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        let status: { exit?: unknown } | undefined;
        try { status = JSON.parse(await readFile(join(runDir, 'status'), 'utf8')) as { exit?: unknown }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (Number.isInteger(status?.exit) && (status!.exit as number) >= 0 && (status!.exit as number) <= 255) {
          // Outcome is self-reported (outcome_source='self'): the script can
          // write its status file, and exits 124/137 are indistinguishable from
          // timeout's codes. They are completion evidence, not host attestation.
          const exit = status!.exit as number;
          await settle(exit, exit === 124 || exit === 137 ? 'timed_out' : 'exited');
        } else if (!this.options.pty.hasSession(request.sessionId)) await settle(null, 'killed');
      } catch (error) {
        this.options.logger?.error('Tool completion could not be persisted', error instanceof Error ? error : new Error(String(error)), { sessionId: request.sessionId });
        // Status-read failures retry on the next poll; settled runs release all
        // watchers even when persistence fails. DB lifecycle/startup repair
        // remains the backstop for an unavailable completion write.
      } finally { checking = false; }
    };
    const sink: FrameSink = {
      readyState: 1,
      send: data => { if (Buffer.isBuffer(data)) output.append(data); },
      close: () => { void check(); },
    };
    request.onReady?.();
    const { reused } = this.options.pty.spawnIfAbsent({ sessionId: request.sessionId,
      command: `exec /bin/bash --noprofile --norc ${shellQuote(join(runDir, 'run'))}`, cwd: request.cwd, env });
    killProcessGroup = this.options.pty.captureProcessGroupKiller(request.sessionId);
    const initial = this.options.pty.getReplay(request.sessionId, -1);
    if (initial) output.append(initial.data);
    this.options.pty.addSubscriber(request.sessionId, sink);
    this.live.set(request.sessionId, { check, stop });
    timer = setInterval(() => { void check(); }, this.options.pollMs ?? 100);
    timer.unref();
    try { watcher = watch(runDir, () => { void check(); }); watcher.unref(); } catch { /* polling is the fallback */ }
    return { sessionId: request.sessionId, cwd: request.cwd, reused };
  }
  /** Explicit termination removes PTYs without a node-pty exit callback. */
  async checkExit(sessionId: string): Promise<void> { await this.live.get(sessionId)?.check(); }
  async close(): Promise<void> { await Promise.all([...this.live.values()].map(run => run.check())); }
}
