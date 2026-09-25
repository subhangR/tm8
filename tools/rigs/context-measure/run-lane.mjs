#!/usr/bin/env node
// Run ONE measured lane on the dev node and append its row to results.jsonl.
//
//   TM8_CLI=… node run-lane.mjs --arm <label> --task-key <key> --rep <n> \
//     --fixture fixture.json --teammate <id> --project <id> --repo <fixture repo> \
//     --data-dir <dev node data dir> --out results.jsonl [--launch-only]
//
// A lane is: reset the task (untick criteria, back to open) → spawn a worker
// in a fresh worktree → wait until the lane goes idle (or, with
// --launch-only, until its first API response is on disk) → terminate →
// measure (measure.mjs) + judge (success.mjs). `uptime` is recorded at the
// start and at the end: host load corrupts timing, and a row carries it.
// The lane's `tm8` is resolved from the lane process's own PATH, so a row
// proves which CLI build the agent actually ran.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { measureLane } from './measure.mjs';
import { laneSuccess } from './success.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const CLI = process.env.TM8_CLI;
const fixture = JSON.parse(readFileSync(arg('fixture'), 'utf8'));
const taskKey = arg('task-key');
const task = fixture.tasks[taskKey];
const launchOnly = process.argv.includes('--launch-only');
const IDLE_SECONDS = 45;
const TIMEOUT_MS = Number(arg('timeout-min') ?? 25) * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts }).trim();
const tm8 = (...a) => JSON.parse(sh(CLI, [...a, '--format', 'json']));
const uptime = () => sh('uptime', []).replace(/.*load averages?:\s*/, '');

function resetTask(id) {
  const t = tm8('entity', 'get', id, '--full');
  const done = (t.content?.acceptanceCriteria ?? []).filter((c) => c.done).map((c) => c.id);
  if (done.length) tm8('task', 'tick', id, ...done, '--untick', '--expect-version', String(t.version));
  const status = t.state?.status ?? t.status;
  if (status && status !== 'open') {
    try {
      tm8('task', 'transition', id, 'open');
    } catch (e) {
      console.error(`reset: transition ${status} -> open refused: ${String(e.stderr ?? e.message).trim()}`);
    }
  }
}

function lanePid(sessionId) {
  for (const pid of sh('pgrep', ['-f', 'claude'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) {
    try {
      if (sh('ps', ['eww', '-p', pid]).includes(`TM8_SESSION_ID=${sessionId}`)) return pid;
    } catch {
      /* exited */
    }
  }
  return null;
}

function laneCli(pid) {
  const env = sh('ps', ['eww', '-p', pid]).split(/\s+/).find((w) => w.startsWith('PATH='));
  const path = env ? env.slice(5) : '';
  const bin = sh('/bin/sh', ['-c', 'command -v tm8 || true'], { env: { PATH: path } });
  let version = null;
  try {
    version = sh(bin, ['--version'], { env: { PATH: path, HOME: homedir() } });
  } catch {
    version = null;
  }
  return { bin, version };
}

function transcriptFor(worktree, nativeId) {
  const slug = worktree.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', slug);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const pick = nativeId && files.includes(`${nativeId}.jsonl`) ? `${nativeId}.jsonl` : files[0];
  return pick ? join(dir, pick) : null;
}

const base = sh('git', ['-C', arg('repo'), 'rev-parse', 'main']);
resetTask(task.id);
const startedAt = new Date().toISOString();
const uptimeStart = uptime();
const spawn = tm8(
  'session', 'spawn', '--teammate', arg('teammate'), '--task', task.id, '--launch-project', arg('project'),
  '--workdir', 'worktree', '--base-ref', 'main', '--mode', 'worker', '--access-mode', 'fullAccess',
);
const sessionId = spawn.id;
const worktree = spawn.workdir?.path;
console.error(`${arg('arm')} ${taskKey}#${arg('rep')} session ${sessionId} load ${uptimeStart}`);

let pid = null;
let cli = null;
let nativeId = null;
let idleSince = null;
let sawRunning = false;
let ended = 'timeout';
const t0 = Date.now();
while (Date.now() - t0 < TIMEOUT_MS) {
  // Launch-only polls fast: a replica's lane must not get far past turn 1.
  await sleep(launchOnly ? 1_000 : 5_000);
  if (!pid) {
    pid = lanePid(sessionId);
    if (pid) {
      cli = laneCli(pid);
      nativeId = /--session-id\s+(\S+)/.exec(sh('ps', ['-o', 'command=', '-p', pid]))?.[1] ?? null;
    }
  }
  if (launchOnly) {
    const f = worktree && transcriptFor(worktree, nativeId);
    if (f && readFileSync(f, 'utf8').includes('"type":"assistant"')) {
      ended = 'first-response';
      break;
    }
    continue;
  }
  const status = tm8('entity', 'get', sessionId).state?.status;
  if (status === 'running') sawRunning = true;
  if (['done', 'exited', 'failed', 'terminated', 'crashed'].includes(status)) {
    ended = status;
    break;
  }
  if (status === 'idle' && sawRunning) {
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= IDLE_SECONDS * 1000) {
      ended = 'idle';
      break;
    }
  } else {
    idleSince = null;
  }
}
const endedAt = new Date().toISOString();
const uptimeEnd = uptime();
try {
  tm8('session', 'terminate', sessionId, '--yes');
} catch (e) {
  console.error(`terminate: ${String(e.stderr ?? e.message).trim()}`);
}
await sleep(2_000);

const manifest = JSON.parse(readFileSync(join(arg('data-dir'), 'manifests', `${sessionId}.json`), 'utf8'));
const transcript = worktree && transcriptFor(worktree, nativeId);
const linked = Array.isArray(task.links)
  ? task.links.map((l) => l.copy)
  : [task.needleId, task.fileId, ...(task.stress ? fixture.distractors.map((d) => d.id) : [])].filter(Boolean);
const measured = transcript ? measureLane({ manifest, transcriptLines: readFileSync(transcript, 'utf8').split('\n'), linked }) : null;
if (measured) {
  measured.needleOpened = task.needleId ? measured.reads.some((r) => r.id === task.needleId) : null;
  measured.needleMissed = task.needleId ? task.needleId in measured.miss.ids : null;
  delete measured.reads;
}
const success = launchOnly
  ? null
  : await laneSuccess({ taskKey, worktree, base, taskId: task.id, actor: arg('teammate'), since: startedAt, until: new Date().toISOString(), cli: CLI });

const row = {
  arm: arg('arm'), taskKey, rep: Number(arg('rep')), sessionId, worktree, base, transcript,
  startedAt, endedAt, ended, wallSeconds: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
  uptimeStart, uptimeEnd, laneTm8: cli, ...measured, success,
};
appendFileSync(arg('out'), JSON.stringify(row) + '\n');
console.error(`${arg('arm')} ${taskKey}#${arg('rep')} ${ended} ${row.wallSeconds}s first=${measured?.firstRequestTokens} tm8=${measured?.system?.tm8Bytes} ok=${success?.success}`);
