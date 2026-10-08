/** External resource deadline; only descendants of the runner spawned here are eligible. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, readdir, open } from 'node:fs/promises';
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
async function captureStoppedTree(pid, seen = new Set()) {
  if (seen.has(pid)) return [];
  seen.add(pid);
  const entry = await identity(pid); if (!entry || entry.state === 'Z') return [];
  await signalOwned(entry, 'SIGSTOP'); // Prevent another descendant being created while capturing ownership.
  let threads;
  try { threads = await readdir(`/proc/${pid}/task`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; threads = []; }
  const lists = await Promise.all(threads.map(async tid => {
    try { return await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
  }));
  const children = new Set(lists.flatMap(list => list.trim().split(/\s+/).filter(Boolean).map(Number)));
  return [entry, ...(await Promise.all([...children].map(child => captureStoppedTree(child, seen)))).flat()];
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
  const probe = process.env.GAME_STORAGE_DIAGNOSTIC_PROBE === '1';
  const diagnostics = probe || process.env.GAME_STORAGE_BROWSER_DIAGNOSTICS === '1';
  let stderr, receipt;
  try {
    if (diagnostics) {
      await mkdir(runRoot, { recursive: true });
      stderr = await open(`${runRoot}/browser-stderr.log`, 'ax', 0o600);
    }
    receipt = await runOwnedWindow(process.execPath,
      [`${repoRoot}/tools/rigs/game-storage-${probe ? 'browser-probe' : 'check'}.mjs`], {
        deadlineEpochMs: Date.parse(process.env.GAME_STORAGE_WINDOW_END ?? ''), cwd: repoRoot,
        ...(diagnostics ? { env: { ...process.env, DEBUG: 'pw:browser*', GAME_STORAGE_BROWSER_DIAGNOSTICS: '1' },
          stdio: ['ignore', 'inherit', stderr.fd] } : {}),
      });
  } finally { await stderr?.close(); }
  await mkdir(runRoot, { recursive: true });
  await writeFile(`${runRoot}/window-closure.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ stage: 'owned resource window closed', ...receipt }));
  process.exitCode = receipt.deadlineReached ? 124 : receipt.exitCode ?? 1;
}
