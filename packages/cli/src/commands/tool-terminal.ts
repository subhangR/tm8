import { PTY_GRANT_PROTOCOL_PREFIX, PTY_WS_PROTOCOL, type ToolRun } from '@tm8/contract';
import { ApiError, InterruptedError } from '../errors.js';
import { CliError, EXIT_USAGE, type ExitCode, type ToolExitCode } from '../exit.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { resolveMutationId } from '../mutation.js';
import type { CommandContext } from '../run.js';
import { grantSocketUrl, type StreamAttachGrantDto } from './session.js';

export function toolRunExitCode(run: ToolRun): ExitCode {
  const code = run.exitCode ?? (run.state === 'timed_out' ? 124 : run.state === 'killed' ? 137 : null);
  if (code === null || !Number.isInteger(code) || code < 0 || code > 255) {
    throw new CliError('The finished tool run has no valid process exit code', 10);
  }
  return code as ToolExitCode;
}

/** Stored run state is authoritative, including when a keep-open shell is still live. */
export async function attachToolRun(cmd: CommandContext, sessionId: string, keepOpen: boolean): Promise<ExitCode> {
  const client = clientFor({ ...cmd.ctx, fresh: true });
  const getRun = (): Promise<ToolRun> => observedInvoke(client, 'tools.runs.get', { params: { sessionId } });
  const finished = (run: ToolRun): ExitCode => {
    if (run.outputTail) cmd.out.bytes(Buffer.from(run.outputTail));
    return toolRunExitCode(run);
  };
  let run = await getRun();
  // Fast scripts can end before a socket grant is requested. Their bounded,
  // redacted stored tail and recorded exit status remain readable.
  if (run.state !== 'running') return finished(run);
  let grant: StreamAttachGrantDto;
  try {
    grant = await observedInvoke(client, 'execution.streams.attach', { params: { id: sessionId }, body: {
      mode: 'drive',
      clientMutationId: resolveMutationId(undefined),
      ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}),
    } });
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'invariant_violation')) {
      run = await getRun();
      if (run.state !== 'running') return finished(run);
    }
    throw error;
  }
  const Ctor = globalThis.WebSocket;
  if (!Ctor) throw new CliError('This Node build has no WebSocket; use --detach and `tm8 tool run-show`', EXIT_USAGE);
  if (typeof grant.token !== 'string' || !grant.token || typeof grant.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
    throw new CliError('The PTY attach grant is invalid or expired', EXIT_USAGE);
  }
  const socket = new Ctor(grantSocketUrl(cmd, grant), [PTY_WS_PROTOCOL, `${PTY_GRANT_PROTOCOL_PREFIX}${grant.token}`]);
  socket.binaryType = 'arraybuffer';
  return new Promise<ExitCode>((resolve, reject) => {
    let settled = false, checking = false, closedPending = false, rawChanged = false, receivedOutput = false, timer: ReturnType<typeof setInterval> | undefined;
    const drive = grant.mode === 'drive';
    const wasRaw = process.stdin.isRaw, wasPaused = process.stdin.isPaused();
    const forward = (chunk: Buffer): void => { if (socket.readyState === 1) socket.send(chunk); };
    const resize = (): void => {
      if (drive && socket.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));
    };
    const done = (code?: ExitCode, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (drive) {
        process.stdin.off('data', forward); process.stdout.off('resize', resize);
        if (rawChanged) process.stdin.setRawMode(wasRaw);
        if (wasPaused) process.stdin.pause();
      }
      socket.close();
      if (error) reject(error); else resolve(code!);
    };
    const check = async (closed = false): Promise<void> => {
      if (settled) return;
      if (checking) { closedPending ||= closed; return; }
      checking = true;
      try {
        // The wrapper's status watcher can finish just after the PTY closes.
        for (let attempt = 0; attempt < (closed ? 20 : 1); attempt++) {
          const current = await getRun();
          if (settled) return;
          if (current.state !== 'running') {
            if (closed || keepOpen) {
              if (!receivedOutput && current.outputTail) cmd.out.bytes(Buffer.from(current.outputTail));
              done(toolRunExitCode(current));
            }
            return;
          }
          if (closed) await new Promise<void>(resolve => setTimeout(resolve, 100));
        }
        if (closed) done(undefined, new InterruptedError('Tool terminal closed before its exit status was recorded; inspect `tm8 tool run-show`'));
      } catch (error) { done(undefined, error); }
      finally {
        checking = false;
        if (closedPending && !settled) { closedPending = false; void check(true); }
      }
    };
    socket.addEventListener('open', () => {
      if (socket.protocol !== PTY_WS_PROTOCOL) { done(undefined, new CliError('Unexpected PTY subprotocol', 10)); return; }
      if (drive) {
        if (process.stdin.isTTY && process.stdout.isTTY) { process.stdin.setRawMode(true); rawChanged = true; }
        process.stdin.on('data', forward); process.stdin.resume(); process.stdout.on('resize', resize); resize();
      }
      if (keepOpen) timer = setInterval(() => { void check(); }, 250);
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (settled) return;
      if (typeof event.data !== 'string') {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        receivedOutput ||= bytes.byteLength > 0;
        cmd.out.bytes(bytes); return;
      }
      let control: { type?: string };
      try {
        control = JSON.parse(event.data) as { type?: string };
        if (!control || typeof control !== 'object' || typeof control.type !== 'string') throw new Error('invalid control');
      }
      catch { done(undefined, new CliError('Invalid PTY control frame', 10)); return; }
      if (control.type === 'exit') { clearInterval(timer); void check(true); }
    });
    socket.addEventListener('error', () => { /* The close event settles against stored run state. */ });
    socket.addEventListener('close', () => { clearInterval(timer); void check(true); });
  });
}
