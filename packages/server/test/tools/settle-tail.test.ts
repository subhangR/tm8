/**
 * The stored tail of a tool run holds every output byte once and the exit
 * footer once. Driven by a fake host that keeps PtyHostService's one relevant
 * habit: output lands in the ring synchronously but reaches subscribers only on
 * the next flush, and getReplay/addSubscriber flush BEFORE they slice — so a
 * settle that reads its own byte count first, then asks for a replay from it,
 * receives the flushed frame twice (PR-G, transcript 10-keepopen-dup).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OutputBuffer, ToolSessionLauncher, toolWrapper, type FrameSink, type PtyHostService, type ToolExit,
} from '@tm8/execution';
import type { ToolDefinition } from '@tm8/contract';

vi.setConfig({ testTimeout: 15000 });

type ExitInfo = { exitCode: number | null; signal: null };

/** Enough of PtyHostService for the launcher. `emit` is the PTY producing bytes. */
class CoalescingHost {
  readonly ring = new OutputBuffer();
  private readonly subscribers = new Set<FrameSink>();
  private readonly waiters: Array<(exit: ExitInfo) => void> = [];
  private pending: Buffer[] = [];
  /** No PTY until spawnIfAbsent: launch() treats a live session as a reattach and spawns nothing. */
  private present = false;
  private exit: ExitInfo = { exitCode: null, signal: null };
  /** True while the launcher sits in waitForBootSettlement with the PTY still live. */
  waiting = false;

  hasSession(): boolean { return this.present; }
  spawnIfAbsent(): { reused: boolean } { this.present = true; return { reused: false }; }
  captureProcessGroupKiller(): () => void { return () => {}; }
  kill(): void { this.present = false; this.subscribers.clear(); }
  /** Bytes land in the ring at once; subscribers see them on the next flush (the coalescing window). */
  emit(text: string): void {
    const chunk = Buffer.from(text, 'utf8');
    this.ring.append(chunk);
    this.pending.push(chunk);
  }
  /** The wrapper's final `exit`: PtyHostService.onExit flushes the tail, closes subscribers and removes the entry. */
  exited(exitCode: number): void {
    this.exit = { exitCode, signal: null };
    this.flush();
    for (const sink of this.subscribers) sink.close();
    this.subscribers.clear();
    this.present = false;
    for (const resolve of this.waiters.splice(0)) resolve(this.exit);
  }
  getReplay(_id: string, fromOffset: number) {
    if (!this.present) return null;
    this.flush();
    return this.ring.replayFrom(fromOffset);
  }
  addSubscriber(_id: string, sink: FrameSink): boolean {
    if (!this.present) return false;
    this.flush();
    this.subscribers.add(sink);
    return true;
  }
  removeSubscriber(_id: string, sink: FrameSink): void { this.subscribers.delete(sink); }
  waitForBootSettlement(_id: string, settleMs: number): Promise<ExitInfo | null> {
    if (!this.present) return Promise.resolve(this.exit);
    this.waiting = true;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting = false; resolve(null); }, settleMs);
      this.waiters.push(exit => { clearTimeout(timer); this.waiting = false; resolve(exit); });
    });
  }
  private flush(): void {
    if (this.pending.length === 0) return;
    const frame = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending);
    this.pending = [];
    for (const sink of this.subscribers) sink.send(frame);
  }
}

const definition: ToolDefinition = { name: 'settle-probe', description: '', help: '', runtime: 'bash', source: 'exit 0',
  inputs: [], tm8Access: 'none', timeoutSeconds: 10 };
const HEADER = '── settle-probe v1 · inputs:  ──\r\n';
const LINES = ['OK 200 http://127.0.0.1/a\r\n', 'OK 200 http://127.0.0.1/b\r\n', 'OK 200 http://127.0.0.1/c\r\n'];
const footer = (keepOpen: boolean) => `\r\n── settle-probe v1 exited 0 in 0s ──${keepOpen ? ' (shell is still open; exit to close)' : ''}\r\n`;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function launch(keepOpen: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-tool-settle-')); dirs.push(dir);
  const host = new CoalescingHost(), sessionId = randomUUID();
  const recordExit = vi.fn(async (_exit: ToolExit) => {}), revokeToken = vi.fn(async () => {});
  const launcher = new ToolSessionLauncher({ pty: host as unknown as PtyHostService, dataDir: dir, baseUrl: 'http://127.0.0.1:4610', pollMs: 20,
    env: { PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/bash' } });
  await launcher.launch({ sessionId, toolId: randomUUID(), toolVersion: 1, definition, cwd: dir, keepOpen, recordExit, revokeToken,
    inputs: { env: {}, values: {}, secretEnvKeys: [], secretValues: [], credentialIds: [] } });
  const runDir = join(dir, 'tool-runs', sessionId);
  /** The wrapper's order after the fix: footer to the PTY, then status.tmp renamed to status. */
  const finish = async (exitCode = 0) => {
    host.emit(HEADER);
    for (const line of LINES) host.emit(line);
    host.emit(footer(keepOpen));
    await writeFile(join(runDir, 'status.tmp'), JSON.stringify({ exit: exitCode, at: new Date().toISOString() }));
    await rename(join(runDir, 'status.tmp'), join(runDir, 'status'));
  };
  const recorded = async () => {
    await vi.waitFor(() => expect(recordExit).toHaveBeenCalledTimes(1), { timeout: 5000 });
    return recordExit.mock.calls[0]![0];
  };
  return { host, launcher, recordExit, revokeToken, finish, recorded };
}

function expectEachOnce(tail: string, keepOpen: boolean) {
  expect(count(tail, HEADER)).toBe(1);
  for (const line of LINES) expect(count(tail, line), line).toBe(1);
  expect(count(tail, 'exited 0 in')).toBe(1);
  expect(tail.endsWith(footer(keepOpen))).toBe(true);
}

describe('tool run tail at settle', () => {
  it('a keep-open run stores every line and the footer once while the frame is still coalesced', async () => {
    const run = await launch(true);
    await run.finish();
    const exit = await run.recorded();
    expect(exit).toMatchObject({ exitCode: 0, state: 'exited' });
    expectEachOnce(exit.outputTail, true);
    expect(Buffer.byteLength(exit.outputTail)).toBe(run.host.ring.totalBytes);
    expect(run.host.hasSession()).toBe(true);
    expect(run.revokeToken).toHaveBeenCalledTimes(1);
  });
  it('a keep-open tail ends with the footer even when the retained shell already started', async () => {
    const run = await launch(true);
    await run.finish();
    // The exec'd shell's first bytes reach the ring before settle reads it (2 of 5 runs on a dev slot).
    run.host.emit('\x1b[?2004htm8@host:/data/tool-workspaces/id_x/run$ ');
    const exit = await run.recorded();
    expectEachOnce(exit.outputTail, true);
    expect(exit.outputTail).not.toContain('tool-workspaces');
  });
  it('a closed run whose status is observed while the PTY is live stores the tail once after the exit', async () => {
    const run = await launch(false);
    await run.finish(0);
    await vi.waitFor(() => expect(run.host.waiting).toBe(true), { timeout: 5000 });
    run.host.exited(0);
    const exit = await run.recorded();
    expect(exit).toMatchObject({ exitCode: 0, state: 'exited' });
    expectEachOnce(exit.outputTail, false);
    expect(Buffer.byteLength(exit.outputTail)).toBe(run.host.ring.totalBytes);
    expect(run.host.hasSession()).toBe(false);
  });
  it('a closed run whose PTY exited before its status was observed stores the tail once', async () => {
    const run = await launch(false);
    await run.finish(0);
    run.host.exited(0);
    const exit = await run.recorded();
    expect(exit).toMatchObject({ exitCode: 0, state: 'exited' });
    expectEachOnce(exit.outputTail, false);
    expect(Buffer.byteLength(exit.outputTail)).toBe(run.host.ring.totalBytes);
  });
  it('the wrapper prints the exit footer before the status file exists, keep-open or closed', () => {
    for (const keepOpen of [true, false]) {
      const script = toolWrapper({ definition, toolVersion: 1, cwd: '/tmp', keepOpen }, '/run', '/bin/bash', []);
      const printed = script.indexOf("exited %s in %ss"), written = script.indexOf('status.tmp');
      expect(printed).toBeGreaterThan(-1);
      expect(written).toBeGreaterThan(-1);
      expect(printed).toBeLessThan(written);
      // The footer and the status write stay ahead of the hand-off to the retained shell or the exit.
      expect(written).toBeLessThan(script.indexOf(keepOpen ? 'exec /usr/bin/env' : 'exit "$code"'));
    }
  });
});
