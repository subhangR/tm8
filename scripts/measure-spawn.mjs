#!/usr/bin/env node
/**
 * measure-spawn — where a launch's time goes, phase by phase, on a dev slot.
 *
 * CONTRACT
 *   Input:  a running tm8-server (TM8_BASE_URL, default http://127.0.0.1:4610)
 *           started with a stand-in agent (TM8_AGENT_CMD=echo-agent, or a fake
 *           `claude` first on its PATH); flags below.
 *   Does:   creates one throwaway space, teammate, trusted project and Git
 *           repository, then launches N sessions per mode, ONE AT A TIME, and
 *           terminates each once it is running (or has failed).
 *   Output: per mode, p50 / p90 / max of
 *             request→response   the `execution.spawn` HTTP round trip
 *             request→running    until the row reads `running` (polled)
 *             request→<phase>    until the row's `bootPhase` reached each phase
 *                                (servers that record boot phases)
 *             each server phase  `timings.phases` from the response, and, with
 *                                --server-log, the boot's own phases from the
 *                                `SpawnService: spawn timings` line
 *           with the node's load average printed beside every table, because
 *           on a shared node the absolute numbers mean little without it.
 *   Never:  run against production. Ports 7777, 17777 and 17778 are refused.
 *
 * Usage:
 *   TM8_BASE_URL=http://127.0.0.1:4691 node scripts/measure-spawn.mjs \
 *     [--n 10] [--modes scratch,worktree] [--files 500] \
 *     [--server-log /tmp/server.log] [--json out.json] [--label before]
 *
 * Dependency-free (node >= 22 global fetch), like scripts/smoke-loop.mjs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const BASE = (process.env.TM8_BASE_URL || 'http://127.0.0.1:4610').replace(/\/$/, '');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const N = Number.parseInt(flag('n', '10'), 10);
const MODES = flag('modes', 'scratch,worktree').split(',').map((m) => m.trim()).filter(Boolean);
const FILES = Number.parseInt(flag('files', '500'), 10);
const SERVER_LOG = flag('server-log', null);
const JSON_OUT = flag('json', null);
const LABEL = flag('label', 'run');
const RUNNING_TIMEOUT_MS = 180_000;
// Gentle on purpose: every poll is a full entity read on the server being
// measured, and a tight loop slows the very boot it times. The instants come
// from the row (startedAt, bootPhaseAt), not from when a poll noticed them.
const POLL_MS = 500;
const BOOT_PHASES = ['admitted', 'lane', 'briefing', 'agent', 'live'];

if (/:(7777|17777|17778)(\/|$)/.test(BASE)) {
  console.error(`refusing to measure against ${BASE}: that is a production port`);
  process.exit(2);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const cmid = (label) => `measure-${RUN_ID}-${label}-${(seq += 1)}`;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = parsed?.error;
    throw new Error(`${method} ${path} → HTTP ${res.status} ${e ? `${e.code}: ${e.message}` : text.slice(0, 300)}`);
  }
  return parsed?.data;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { n: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted.at(-1) ?? NaN };
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1).padStart(9) : '        -');
const load = () => loadavg().map((l) => l.toFixed(1)).join(' / ');

function git(cwd, ...argv) {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with FILES small files, so a worktree checkout costs something real. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), `tm8-measure-${RUN_ID}-`));
  git(dir, 'init', '-q', '-b', 'main');
  for (let i = 0; i < FILES; i += 1) {
    const sub = join(dir, `pkg${String(i % 20).padStart(2, '0')}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `file${i}.ts`), `export const value${i} = ${i};\n`.repeat(40));
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=measure@tm8', '-c', 'user.name=measure', 'commit', '-q', '-m', 'measure fixture');
  return dir;
}

/** The fields this script reads off a work-session read, whatever the server's age. */
function sessionState(entity) {
  const state = entity?.state ?? entity?.entity?.state ?? {};
  return {
    status: state.status ?? null,
    bootPhase: state.bootPhase ?? null,
    bootPhaseAt: state.bootPhaseAt ?? null,
    startedAt: state.startedAt ?? null,
  };
}

/** ms from the request to a row timestamp, on the same clock (dev slot: one machine). */
const sinceRequest = (iso, wall0) => (iso ? Date.parse(iso) - wall0 : NaN);

async function waitUntilSettled(sessionId, t0, wall0) {
  const reached = {};
  for (;;) {
    const entity = await call('GET', `/v2/entities/${sessionId}`);
    const now = performance.now() - t0;
    const { status, bootPhase, bootPhaseAt, startedAt } = sessionState(entity);
    if (bootPhase && reached[bootPhase] === undefined) {
      // The row stamps when it reached a phase; a phase skipped between two
      // polls is never stamped and stays absent.
      reached[bootPhase] = Number.isFinite(sinceRequest(bootPhaseAt, wall0)) ? sinceRequest(bootPhaseAt, wall0) : now;
    }
    if (status === 'running' || status === 'idle') {
      const at = sinceRequest(startedAt, wall0);
      return { outcome: 'running', runningMs: Number.isFinite(at) ? at : now, reached };
    }
    if (status === 'failed' || status === 'exited' || bootPhase === 'failed') {
      return { outcome: 'failed', runningMs: NaN, reached, entity };
    }
    if (now > RUNNING_TIMEOUT_MS) return { outcome: 'timeout', runningMs: NaN, reached };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** `SpawnService: spawn timings` lines for these sessions, from the server's own log. */
function bootTimingsFromLog(sessionIds) {
  if (!SERVER_LOG) return new Map();
  const wanted = new Set(sessionIds);
  const found = new Map();
  for (const line of readFileSync(SERVER_LOG, 'utf8').split('\n')) {
    if (!line.includes('SpawnService: spawn timings')) continue;
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const fields = JSON.parse(line.slice(start));
      const record = fields.fields ?? fields;
      if (record.sessionId && wanted.has(record.sessionId)) found.set(record.sessionId, record);
    } catch {
      // A line this script cannot parse is a line it does not count.
    }
  }
  return found;
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log(`  ${'metric'.padEnd(46)}      p50       p90       max   n`);
  for (const [name, values] of rows) {
    const s = stats(values);
    if (s.n === 0) continue;
    console.log(`  ${name.padEnd(46)}${fmt(s.p50)} ${fmt(s.p90)} ${fmt(s.max)}  ${String(s.n).padStart(2)}`);
  }
}

// ---------------------------------------------------------------------------

const health = await (await fetch(`${BASE}/health`)).json().catch(() => null);
if (!health?.ok) {
  console.error(`no healthy tm8-server at ${BASE}`);
  process.exit(1);
}
console.log(`measure-spawn [${LABEL}] → ${BASE} · run ${RUN_ID} · n=${N} per mode · modes ${MODES.join(', ')}`);
console.log(`node load (1/5/15 min) at start: ${load()}`);

const space = await call('POST', '/v2/spaces', { name: `Measure ${RUN_ID}`, clientMutationId: cmid('space') });
const spaceId = space?.id ?? space?.space?.id;
const repo = makeRepo();
const project = await call('POST', '/v2/projects', {
  name: `Measure ${RUN_ID}`, workingDir: repo, trust: 'trusted', clientMutationId: cmid('project'),
});
const projectId = project?.id ?? project?.project?.id;
await call('POST', `/v2/spaces/${spaceId}/projects`, { projectId, clientMutationId: cmid('link') });
const member = await call('POST', '/v2/entities', {
  spaceId, kind: 'team_member', title: 'Measure Agent',
  content: { model: 'claude-sonnet-5', agentTool: 'claude-code', mode: 'worker' },
  clientMutationId: cmid('member'),
});
const teamMemberId = member?.id ?? member?.entity?.id;
console.log(`space ${spaceId} · project ${projectId} (${FILES} files at ${repo}) · teammate ${teamMemberId}`);

const report = { label: LABEL, base: BASE, runId: RUN_ID, n: N, files: FILES, loadStart: loadavg(), modes: {} };

for (const mode of MODES) {
  const loadBefore = load();
  const samples = [];
  for (let i = 0; i < N; i += 1) {
    const task = await call('POST', '/v2/entities', {
      spaceId, kind: 'task', title: `Measure ${mode} ${i + 1}`, clientMutationId: cmid('task'),
    });
    const taskId = task?.id ?? task?.entity?.id;
    const body = {
      spaceId,
      teamMemberId,
      taskIds: [taskId],
      mode: 'worker',
      clientMutationId: cmid(`spawn-${mode}`),
      ...(mode === 'scratch' ? { workdir: { mode: 'scratch' } } : { projectId, workdir: { mode } }),
    };
    const t0 = performance.now();
    const wall0 = Date.now();
    let spawned;
    try {
      spawned = await call('POST', '/v2/execution/spawn', body);
    } catch (error) {
      samples.push({ outcome: 'refused', error: String(error.message ?? error) });
      console.log(`  ${mode} #${i + 1}: refused — ${error.message}`);
      continue;
    }
    const responseMs = performance.now() - t0;
    const sessionId = spawned?.entity?.id;
    const settled = await waitUntilSettled(sessionId, t0, wall0);
    samples.push({ sessionId, responseMs, ...settled, timings: spawned?.timings ?? null });
    console.log(
      `  ${mode} #${i + 1}: ${settled.outcome} · response ${responseMs.toFixed(0)} ms · running ${
        Number.isFinite(settled.runningMs) ? settled.runningMs.toFixed(0) : '-'} ms · ${sessionId}`,
    );
    await call('POST', `/v2/entities/${sessionId}/commands/terminate`, { clientMutationId: cmid('terminate') })
      .catch(() => undefined);
  }

  const ok = samples.filter((s) => s.sessionId);
  const fromLog = bootTimingsFromLog(ok.map((s) => s.sessionId));
  const rows = [
    ['request→response', ok.map((s) => s.responseMs)],
    ['request→running', ok.map((s) => s.runningMs)],
    ...BOOT_PHASES.map((phase) => [`request→bootPhase ${phase}`, ok.map((s) => s.reached?.[phase] ?? NaN)]),
  ];
  const responsePhases = [...new Set(ok.flatMap((s) => Object.keys(s.timings?.phases ?? {})))];
  for (const phase of responsePhases) {
    rows.push([`response: ${phase}`, ok.map((s) => s.timings?.phases?.[phase] ?? NaN)]);
  }
  const logPhases = [...new Set([...fromLog.values()].flatMap((r) => Object.keys(r.phases ?? {})))];
  for (const phase of logPhases) {
    rows.push([`log: ${phase}`, ok.map((s) => fromLog.get(s.sessionId)?.phases?.[phase] ?? NaN)]);
  }
  if (fromLog.size > 0) rows.push(['log: totalMs', ok.map((s) => fromLog.get(s.sessionId)?.totalMs ?? NaN)]);

  const outcomes = samples.reduce((acc, s) => ({ ...acc, [s.outcome]: (acc[s.outcome] ?? 0) + 1 }), {});
  printTable(
    `[${LABEL}] mode=${mode}  n=${samples.length}  outcomes ${JSON.stringify(outcomes)}  ` +
      `load ${loadBefore} → ${load()}  (ms)`,
    rows,
  );
  report.modes[mode] = {
    loadBefore, loadAfter: load(), outcomes,
    metrics: Object.fromEntries(rows.map(([name, values]) => [name, stats(values)])),
    samples: samples.map(({ entity: _entity, ...rest }) => rest),
  };
}

report.loadEnd = loadavg();
console.log(`\nnode load (1/5/15 min) at end: ${load()}`);
if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${JSON_OUT}`);
}
