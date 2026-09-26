#!/usr/bin/env node
// Run ONE SLICE of the context eval on ONE dev node, appending a row per lane.
//
//   node lanes.mjs --slice c1 --node 4621 --out results/<run>.jsonl
//     [--reps 2] [--models sonnet5,haiku45] [--only fee,stress30] [--families needle,memory]
//     [--concurrency auto|1|2] [--load-max 80] [--timeout-min 25] [--dry-run]
//
// A slice is one ARM (c1 lean, c2 index-derived, c3 index-authored, c4
// inherit); the node must be registered under that arm (dev-node.sh up ...
// ARM=<arm>) and its fixture built (fixture.mjs --node <port>). Lanes run in
// an INTERLEAVED order (model alternates first, then task, then rep) so no
// cell owns a time window. Concurrency follows the host load, read before
// every start: 2 lanes when the 1-min load is under 40, 1 at 40-80, none above
// 80 (the lane waits, and the row records how long). `--load-max N` (or
// CTX_EVAL_LOAD_MAX=N) lowers the ceiling for a shared box: above N nothing
// starts, and at most one lane runs from min(40, N) up (utho: --load-max 12
// --concurrency 1).
//
// Every lane runs on a FRESH COPY of its template task (title, content with
// every criterion unticked, edges re-created in the recorded order): a
// template never carries a closeout. The row keeps taskId + templateTaskId.
//
// multiturn family: at the lane's first idle a change request is posted to
// the session (delivered through the node's delivery worker), the lane runs
// again to idle, is terminated, RESUMED (`session resume`), and waited to idle
// once more. The row's `turn` records each step; the rubric scores the
// injected change's checks and whether the resume relaunched.

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { devCli } from '../context-measure/dev-cli.mjs';
import { lanePid, laneCli, load1, nativeSessionId, sh, sleep, transcriptFor, uptime } from '../context-measure/lane.mjs';
import { laneSuccess } from '../context-measure/success.mjs';
import { measureRow } from './measure-row.mjs';
import { RUBRIC_ITEMS } from './fixture-data.mjs';
import { nodeRecord } from './node-registry.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
export const SLICES = { c1: 'lean', c2: 'index-derived', c3: 'index-authored', c4: 'inherit' };
export const MODELS = { sonnet5: 'Sonnet 5 Teammate', haiku45: 'Haiku 4.5 Teammate', opus55: 'Opus 5.5 1M Teammate' };
const IDLE_SECONDS = 45;
const NO_TRANSCRIPT_MS = 120_000;
const LOAD_TIERS = { two: 40, one: 80 };
// The fixture repo's `main` carries exactly these commits (dev-node.sh, fixture.mjs).
// Every lane branches from it, so a lane that merged its work into `main` would
// hand every later lane a solved base: the slice stops scheduling instead.
const FIXTURE_COMMITS = ['ledger-lite fixture', 'fixture skills'];

/**
 * Claude Code keys auto-memory to the PROJECT root (the node's fixture repo),
 * not the lane's worktree: `~/.claude/projects/<slug of the repo>/memory/`. A
 * lane that writes there has its notes loaded into every later lane's first
 * request on the node (decision D11; C3 msg 01a0d994-59e7). Before EVERY spawn
 * the dir must be absent or empty; otherwise it is MOVED (never deleted) to
 * `<dataDir>/evidence/memory-<ts>/` and the next row records it.
 */
export const memoryDirFor = (repo, home = homedir()) => join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
export function guardMemoryDir(repo, dataDir, { home = homedir(), now = new Date() } = {}) {
  const dir = memoryDirFor(repo, home);
  if (!existsSync(dir)) return { memoryDirState: 'absent' };
  const files = readdirSync(dir);
  if (!files.length) return { memoryDirState: 'empty' };
  const to = join(dataDir, 'evidence', `memory-${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(join(dataDir, 'evidence'), { recursive: true });
  cpSync(dir, to, { recursive: true }); // copy then remove: ~/.claude and <dataDir> may sit on different volumes
  rmSync(dir, { recursive: true, force: true });
  return { memoryDirState: 'moved', memoryDirMovedAt: now.toISOString(), memoryDirMovedFiles: files, memoryDirMovedTo: to };
}

/** `git log --format='%h %s'` lines on the fixture repo's main that no fixture step made. */
export function foreignMainCommits(lines) {
  return lines.filter((l) => l && !FIXTURE_COMMITS.includes(l.slice(l.indexOf(' ') + 1)));
}


/** Interleaved plan: for each rep, for each task key, the models alternate (starting model rotates per key). */
export function planSlice({ keys, models, reps }) {
  const plan = [];
  for (let rep = 1; rep <= reps; rep++) {
    keys.forEach((taskKey, k) => {
      const order = k % 2 === 0 ? models : [...models].reverse();
      for (const model of order) plan.push({ model, taskKey, rep });
    });
  }
  return plan;
}

/** The load tiers, with the ceiling lowered to `loadMax` when one is given. */
export function loadTiers(loadMax) {
  if (loadMax == null || loadMax === '') return LOAD_TIERS;
  const n = Number(loadMax);
  if (!(n > 0)) throw new Error(`--load-max ${loadMax} is not a positive number`);
  return { two: Math.min(LOAD_TIERS.two, n), one: Math.min(LOAD_TIERS.one, n) };
}

/** How many lanes may run at this load: 2 under 40, 1 at 40..80, 0 above 80 (or the given tiers). */
export function allowedConcurrency(load, max = 2, tiers = LOAD_TIERS) {
  if (!Number.isFinite(load)) throw new Error(`unreadable load ${load}`);
  if (load > tiers.one) return 0;
  if (load >= tiers.two) return Math.min(1, max);
  return max;
}

/** Deterministic per-family rubric from the judged pieces. */
export function rubricFor(family, { success, turn, checkResults }) {
  const items = RUBRIC_ITEMS[family];
  if (!items) throw new Error(`no rubric for family ${family}`);
  const byExpr = new Map((checkResults ?? []).map((c) => [c.expr, c.pass]));
  const pass = {
    committed: !!success?.committed,
    checks: !!success && success.checks.total > 0 ? (checkResults ?? []).filter((c) => c.set === 'base').every((c) => c.pass) : false,
    closeout: !!success?.closeout,
    ticked: !!success?.ticked,
    aliasCheck: (checkResults ?? []).some((c) => c.set === 'alias') && (checkResults ?? []).filter((c) => c.set === 'alias').every((c) => c.pass),
    turnChecks: (checkResults ?? []).some((c) => c.set === 'turn') && (checkResults ?? []).filter((c) => c.set === 'turn').every((c) => c.pass),
    resumed: !!turn?.resumed,
  };
  void byExpr;
  const scored = items.map((name) => ({ name, pass: !!pass[name] }));
  return { family, items: scored, score: scored.filter((s) => s.pass).length / scored.length, judge: 'deterministic' };
}

function copyTask(tm8, tpl) {
  const idOf = (r) => r.id ?? r.entity?.id ?? r.data?.id;
  const content = { description: tpl.content.description, acceptanceCriteria: (tpl.content.acceptanceCriteria ?? []).map((c) => ({ ...c, done: false })) };
  const id = idOf(tm8('entity', 'create', 'task', tpl.title, '--content', JSON.stringify(content)));
  for (const e of tpl.edges) tm8('edge', 'create', e.src === 'TASK' ? id : e.src, e.type, e.dst === 'TASK' ? id : e.dst);
  return id;
}

function sessionStatus(tm8, id) {
  return tm8('entity', 'get', id).state?.status;
}

/** Wait until the session has run and then sat idle for IDLE_SECONDS (or ended). Returns {ended, sawRunning}. */
async function waitIdle(tm8, sessionId, worktree, getNative, deadline, { needTranscript = true } = {}) {
  let idleSince = null;
  let sawRunning = false;
  const t0 = Date.now();
  while (Date.now() < deadline) {
    await sleep(5_000);
    const status = sessionStatus(tm8, sessionId);
    if (status === 'running') sawRunning = true;
    if (['done', 'exited', 'failed', 'terminated', 'crashed'].includes(status)) return { ended: status, sawRunning };
    let transcript = null;
    try {
      transcript = worktree && transcriptFor(worktree, getNative());
    } catch {
      transcript = null;
    }
    // A lane that writes no transcript is stuck before its first request (the
    // workspace-trust prompt, task 01a0d79e). Fail it fast, never idle to the timeout.
    if (needTranscript && Date.now() - t0 > NO_TRANSCRIPT_MS && !transcript) return { ended: 'no-transcript', sawRunning };
    if (status === 'idle' && sawRunning && (transcript || !needTranscript)) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_SECONDS * 1000) return { ended: 'idle', sawRunning };
    } else idleSince = null;
  }
  return { ended: 'timeout', sawRunning };
}

/** A row's identity; `base` is the fixture repo's `main` sha the lane branched from. */
function newRow({ node, nodeFx, cell, slice, fixtureVersion, base }) {
  const tpl = nodeFx.tasks[cell.taskKey];
  return {
    schema: 'context-eval.row.v1', slice, arm: node.arm, node: { port: node.port, db: node.db, env: node.env }, buildSha: node.buildSha, fixtureVersion,
    model: cell.model, teammateId: node.teammates[MODELS[cell.model]], family: tpl.family, taskKey: cell.taskKey, rep: cell.rep,
    templateTaskId: tpl.templateId, taskId: null, sessionId: null, worktree: null, base,
    startedAt: null, endedAt: null, ended: null, wallSeconds: null, uptimeStart: null, uptimeEnd: null, loadAtStart: null, waitedSeconds: cell.waitedSeconds ?? 0,
    laneTm8: null, turn: null,
    ...(cell.memoryGuard ?? {}),
  };
}

async function runLane({ node, nodeFx, tm8, cell, slice, out, timeoutMin, fixtureVersion }) {
  const tpl = nodeFx.tasks[cell.taskKey];
  const teammateId = node.teammates[MODELS[cell.model]];
  const tag = `${slice}/${cell.model}/${cell.taskKey}#${cell.rep}`;
  const base = sh('git', ['-C', node.repo, 'rev-parse', 'main']);
  const row = newRow({ node, nodeFx, cell, slice, fixtureVersion, base });
  const finish = (extra) => {
    Object.assign(row, extra);
    appendFileSync(out, JSON.stringify(row) + '\n');
    return row;
  };
  try {
    row.taskId = copyTask(tm8, tpl);
  } catch (e) {
    console.error(`${tag} task copy failed: ${String(e.stderr ?? e.message).trim()}`);
    return finish({ ended: 'copy-error', excluded: { reason: `task copy failed: ${String(e.stderr ?? e.message).trim().slice(0, 300)}`, by: 'auto' } });
  }
  row.startedAt = new Date().toISOString();
  row.uptimeStart = uptime();
  row.loadAtStart = Number(row.uptimeStart.split(/[\s,]+/)[0]);
  let spawn;
  try {
    spawn = tm8('session', 'spawn', '--teammate', teammateId, '--task', row.taskId, '--launch-project', node.projectId, '--workdir', 'worktree', '--base-ref', 'main', '--mode', 'worker', '--access-mode', 'fullAccess');
  } catch (e) {
    console.error(`${tag} spawn failed: ${String(e.stderr ?? e.message).trim()}`);
    return finish({ endedAt: new Date().toISOString(), uptimeEnd: uptime(), ended: 'spawn-error', excluded: { reason: `spawn failed: ${String(e.stderr ?? e.message).trim().slice(0, 300)}`, by: 'auto' } });
  }
  row.sessionId = spawn.id;
  row.worktree = spawn.workdir?.path ?? null;
  console.error(`${tag} session ${row.sessionId} load ${row.uptimeStart}`);
  const deadline = Date.now() + timeoutMin * 60_000;
  let pid = null;
  let nativeId = null;
  const getNative = () => {
    if (!pid) {
      pid = lanePid(row.sessionId);
      if (pid) {
        row.laneTm8 = laneCli(pid);
        // A resumed lane runs `--resume <id>`, not `--session-id`: keep the id we had.
        nativeId = nativeSessionId(pid) ?? nativeId;
      }
    }
    return nativeId;
  };
  let wait = await waitIdle(tm8, row.sessionId, row.worktree, getNative, deadline);
  row.ended = wait.ended;
  if (tpl.turn && wait.ended === 'idle') {
    const turn = { injectedAt: null, ranAfterInject: false, afterInject: null, terminatedAt: null, resumedAt: null, resumed: false, afterResume: null };
    try {
      tm8('message', 'send', '--to', row.sessionId, tpl.turn.message);
      turn.injectedAt = new Date().toISOString();
      const w2 = await waitIdle(tm8, row.sessionId, row.worktree, getNative, deadline, { needTranscript: false });
      turn.ranAfterInject = w2.sawRunning;
      turn.afterInject = w2.ended;
      try {
        tm8('session', 'terminate', row.sessionId, '--yes');
      } catch (e) {
        console.error(`${tag} terminate before resume: ${String(e.stderr ?? e.message).trim()}`);
      }
      turn.terminatedAt = new Date().toISOString();
      await sleep(5_000);
      try {
        tm8('session', 'resume', row.sessionId);
        turn.resumedAt = new Date().toISOString();
        pid = null; // the resumed lane is a new process
        const w3 = await waitIdle(tm8, row.sessionId, row.worktree, getNative, deadline, { needTranscript: false });
        turn.afterResume = w3.ended;
        turn.resumed = w3.sawRunning || w3.ended === 'idle' || w3.ended === 'done';
      } catch (e) {
        turn.afterResume = `resume-failed: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`;
      }
    } catch (e) {
      turn.afterInject = `inject-failed: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`;
    }
    row.turn = turn;
    row.ended = turn.afterResume ?? row.ended;
  }
  row.endedAt = new Date().toISOString();
  row.uptimeEnd = uptime();
  row.wallSeconds = Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000);
  try {
    tm8('session', 'terminate', row.sessionId, '--yes');
  } catch (e) {
    console.error(`${tag} terminate: ${String(e.stderr ?? e.message).trim()}`);
  }
  await sleep(2_000);

  // Measure (context-measure's classifier) + components + judge.
  let measured = null;
  let measureError = null;
  let startFailure = null;
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(node.dataDir, 'manifests', `${row.sessionId}.json`), 'utf8'));
    const transcript = row.worktree && transcriptFor(row.worktree, getNative());
    if (!transcript) throw new Error(`no transcript for ${row.worktree} (native ${nativeId})`);
    row.transcript = transcript;
    const noLinks = tpl.linkedIds.length === 0 && !(manifest.context?.entries ?? []).some((e) => e.group === 'references') && !manifest.context?.groups?.references?.unread;
    if (!tpl.linkedIds.length && !noLinks) throw new Error(`task ${cell.taskKey} has no linked ids, so no absent-from-index miss could be counted`);
    measured = measureRow({ manifest, transcriptText: readFileSync(transcript, 'utf8'), transcriptPath: transcript, tpl, taskKey: cell.taskKey });
  } catch (e) {
    measureError = String(e.message ?? e);
    startFailure = e.startFailure ?? null;
  }
  let success = null;
  let checkResults = null;
  let judgeError = null;
  try {
    const sets = [...tpl.checks.map((c) => ({ expr: c[0], want: c[1], set: 'base' })), ...((tpl.turn?.checks ?? []).map((c) => ({ expr: c[0], want: c[1], set: 'turn' })))];
    if (tpl.family === 'memory') for (const s of sets) if (/\w+2\(/.test(s.expr)) s.set = 'alias';
    success = await laneSuccess({ taskKey: cell.taskKey, worktree: row.worktree, base, taskId: row.taskId, actor: teammateId, since: row.startedAt, until: new Date().toISOString(), tm8, checks: sets.map((s) => [s.expr, s.want]), allowNoChecks: tpl.family === 'replica' });
    const failed = new Set((success.checks?.failures ?? []).map((f) => f.expr));
    checkResults = sets.map((s) => ({ ...s, pass: success.committed && !failed.has(s.expr) && !(success.checks?.failures ?? []).some((f) => f.error) }));
  } catch (e) {
    judgeError = String(e.message ?? e);
  }
  const rubric = judgeError ? null : rubricFor(tpl.family, { success, turn: row.turn, checkResults });
  const excluded = row.ended === 'no-transcript'
    ? { reason: 'start failure: no transcript within 120s (workspace-trust hang, task 01a0d79e)', by: 'auto' }
    : startFailure ? { reason: `start failure: ${startFailure.reason}`, by: 'auto' } : undefined;
  if (startFailure) row.ended = startFailure.ended;
  const done = finish({ ...measured, ...(measureError ? { measureError } : {}), success, checkResults, rubric, ...(judgeError ? { judgeError } : {}), ...(excluded ? { excluded } : {}) });
  console.error(`${tag} ${done.ended} ${done.wallSeconds}s first=${measured?.firstRequestTokens ?? '-'} entryMiss=${measured?.miss?.entry?.count ?? '-'} score=${rubric?.score?.toFixed(2) ?? '-'} $${measured?.costUsd?.toFixed(3) ?? '-'}${measureError ? ` NOT MEASURED: ${measureError}` : ''}${excluded ? ` EXCLUDED: ${excluded.reason}` : ''}`);
  return done;
}

async function main() {
  const slice = arg('slice');
  const explicitArm = arg('arm');
  const arm = explicitArm ?? SLICES[slice];
  const port = Number(arg('node'));
  const out = arg('out');
  if (!arm || !port || !out) throw new Error('usage: node lanes.mjs --slice c1..c4 (or --arm <arm>) --node <port> --out results/<run>.jsonl');
  const node = nodeRecord(port);
  if (node.arm !== arm) throw new Error(`node ${port} is registered under arm ${node.arm}, slice ${slice ?? '-'} needs ${arm}: dev-node.sh up ... ARM=${arm}`);
  const nodeFxPath = new URL(`./fixtures/node-${port}.json`, import.meta.url);
  const nodeFx = JSON.parse(readFileSync(nodeFxPath, 'utf8'));
  const fx = JSON.parse(readFileSync(new URL('./fixtures/fixture-v2.json', import.meta.url), 'utf8'));
  if (nodeFx.contentHash !== fx.contentHash) throw new Error(`fixtures/node-${port}.json was built from hash ${nodeFx.contentHash}, fixture-v2.json is ${fx.contentHash}: node fixture.mjs --node ${port}`);
  if (nodeFx.authoredHeaders !== (arm === 'index-authored')) throw new Error(`node ${port} fixture has authoredHeaders=${nodeFx.authoredHeaders}, arm ${arm} needs ${arm === 'index-authored'}: rebuild on a fresh node`);
  const models = (arg('models') ?? 'sonnet5,haiku45').split(',').filter(Boolean);
  for (const m of models) {
    if (!MODELS[m]) throw new Error(`unknown model key ${m}; known: ${Object.keys(MODELS).join(', ')}`);
    if (!node.teammates[MODELS[m]]) throw new Error(`node ${port} has no teammate "${MODELS[m]}" (catalog seeding needs TM8_LAUNCH_BOOTSTRAP=1 and a space)`);
  }
  let keys = Object.keys(nodeFx.tasks);
  if (arg('only')) keys = arg('only').split(',').filter((k) => keys.includes(k));
  if (arg('families')) {
    const fams = arg('families').split(',');
    keys = keys.filter((k) => fams.includes(nodeFx.tasks[k].family));
  }
  if (!keys.length) throw new Error('no task keys selected');
  const reps = Number(arg('reps') ?? 2);
  const plan = planSlice({ keys, models, reps });
  const maxConc = arg('concurrency', 'auto') === 'auto' ? 2 : Number(arg('concurrency'));
  const timeoutMin = Number(arg('timeout-min') ?? 25);
  const tiers = loadTiers(arg('load-max') ?? process.env.CTX_EVAL_LOAD_MAX);
  const fixtureVersion = { schemaVersion: fx.schemaVersion, contentHash: fx.contentHash };
  console.error(`slice ${slice ?? explicitArm} arm ${arm} node ${port} build ${node.buildSha}: ${plan.length} lanes (${models.join(',')} × ${keys.length} tasks × ${reps} reps), max ${maxConc} concurrent, load tiers ${tiers.two}/${tiers.one}, out ${out}`);
  if (process.argv.includes('--dry-run')) {
    for (const c of plan) console.log(`${c.model}\t${c.taskKey}\t${c.rep}`);
    return;
  }
  process.env.TM8_CLI = node.cli;
  process.env.TM8_SPACE_ID = node.spaceId;
  const tm8 = devCli();
  const running = new Set();
  let i = 0;
  while (i < plan.length || running.size) {
    const load = load1();
    const allowed = allowedConcurrency(load, maxConc, tiers);
    if (i < plan.length && running.size < allowed) {
      const foreign = foreignMainCommits(sh('git', ['-C', node.repo, 'log', '--format=%h %s', 'main']).split('\n'));
      if (foreign.length) {
        const base = sh('git', ['-C', node.repo, 'rev-parse', 'main']);
        const reason = `fixture-repo-contaminated: ${node.repo} main ${base.slice(0, 12)} carries non-fixture commit(s) ${foreign.slice(0, 3).join(' | ')}; a lane merged into main, so this lane would have started solved`;
        const left = plan.slice(i);
        console.error(`\n${'!'.repeat(72)}\nSTOPPING SLICE: ${reason}\nwriting ${left.length} excluded row(s) for the lanes not run; reset main to the fixture commit and re-run them with --only\n${'!'.repeat(72)}\n`);
        for (const cell of left) {
          const row = newRow({ node, nodeFx, cell, slice: slice ?? explicitArm, fixtureVersion, base });
          appendFileSync(out, JSON.stringify({ ...row, ended: 'not-run', excluded: { reason, by: 'auto', at: new Date().toISOString() } }) + '\n');
        }
        process.exitCode = 1;
        i = plan.length;
        continue;
      }
      const cell = plan[i++];
      cell.memoryGuard = guardMemoryDir(node.repo, node.dataDir);
      if (cell.memoryGuard.memoryDirState === 'moved') {
        console.error(`\n${'!'.repeat(72)}\nAUTO-MEMORY GUARD: ${memoryDirFor(node.repo)} held ${cell.memoryGuard.memoryDirMovedFiles.join(', ')}: a lane wrote Claude auto-memory, which would load into every later lane. MOVED to ${cell.memoryGuard.memoryDirMovedTo}; rows started since the write are contaminated (report.mjs flags them).\n${'!'.repeat(72)}\n`);
      }
      const p = runLane({ node, nodeFx, tm8, cell, slice: slice ?? explicitArm, out, timeoutMin, fixtureVersion }).catch((e) => console.error(`lane ${cell.model}/${cell.taskKey}#${cell.rep} crashed: ${e.stack ?? e}`)).finally(() => running.delete(p));
      running.add(p);
      await sleep(3_000);
      continue;
    }
    // Only a LOAD wait counts: waiting for a free slot at full concurrency is the plan.
    if (i < plan.length && allowed <= running.size && allowed < maxConc) {
      plan[i].waitedSeconds = (plan[i].waitedSeconds ?? 0) + 20;
      if (allowed === 0) console.error(`load ${load} > ${tiers.one}: waiting (${plan[i].model}/${plan[i].taskKey}#${plan[i].rep} waited ${plan[i].waitedSeconds}s)`);
    }
    await sleep(20_000);
  }
  console.error('slice done');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
