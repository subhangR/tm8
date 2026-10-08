/** External resource deadline; only descendants of the runner spawned here are eligible. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function identity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], startTicks: fields[19] };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function signalOwned(entry, signal) {
  const current = await identity(entry.pid);
  if (current?.startTicks !== entry.startTicks || current.state === 'Z') return false;
  try { process.kill(entry.pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function captureStoppedTree(pid) {
  const entry = await identity(pid); if (!entry || entry.state === 'Z') return [];
  await signalOwned(entry, 'SIGSTOP'); // Prevent another descendant being created while capturing ownership.
  let children;
  try { children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; children = ''; }
  return [entry, ...(await Promise.all(children.trim().split(/\s+/).filter(Boolean)
    .map(child => captureStoppedTree(Number(child))))).flat()];
}
export async function runOwnedWindow(command, args, {
  deadlineEpochMs, reserveMs = 5_000, graceMs = 3_000, cwd, env = process.env, stdio = 'inherit',
} = {}) {
  if (!Number.isFinite(deadlineEpochMs) || deadlineEpochMs <= Date.now() + reserveMs) {
    throw new Error('Set an agreed future GAME_STORAGE_WINDOW_END with time reserved for cleanup');
  }
  const runner = spawn(command, args, { cwd, env, stdio });
  let deadlineReached = false, cleanup;
  const timer = setTimeout(() => {
    deadlineReached = true;
    cleanup = (async () => {
      const captured = await captureStoppedTree(runner.pid);
      for (const entry of captured) { await signalOwned(entry, 'SIGTERM'); await signalOwned(entry, 'SIGCONT'); }
      await new Promise(resolve => setTimeout(resolve, graceMs));
      const forcedStoppedPids = [];
      for (const entry of captured) if (await signalOwned(entry, 'SIGKILL')) forcedStoppedPids.push(entry.pid);
      await new Promise(resolve => setTimeout(resolve, 100));
      const survivors = [];
      for (const entry of captured) {
        const current = await identity(entry.pid);
        if (current?.startTicks === entry.startTicks && current.state !== 'Z') survivors.push(entry.pid);
      }
      return { capturedOwnedPids: captured.map(entry => entry.pid), forcedStoppedPids, survivors };
    })();
  }, deadlineEpochMs - reserveMs - Date.now());
  try {
    const [exitCode, signal] = await once(runner, 'exit');
    return { runnerPid: runner.pid, deadlineReached, exitCode, signal,
      ...(cleanup ? await cleanup : {}), closedAt: new Date().toISOString(),
      windowEnd: new Date(deadlineEpochMs).toISOString(), reserveMs };
  } finally { clearTimeout(timer); }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const { repoRoot, runRoot } = await import('./game-storage-node.mjs');
  const receipt = await runOwnedWindow(process.execPath, [`${repoRoot}/tools/rigs/game-storage-check.mjs`], {
    deadlineEpochMs: Date.parse(process.env.GAME_STORAGE_WINDOW_END ?? ''), cwd: repoRoot,
  });
  await mkdir(runRoot, { recursive: true });
  await writeFile(`${runRoot}/window-closure.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ stage: 'owned resource window closed', ...receipt }));
  process.exitCode = receipt.deadlineReached ? 124 : receipt.exitCode ?? 1;
}
