#!/usr/bin/env node
// Ask the REAL Jev API about REAL tm8 tasks, and print what it decided.
//
// This is the script that produced EVIDENCE.md. It exists so the numbers in
// that file can be re-derived rather than believed, and so the next person to
// change the weights can see what moved.
//
//   bun run build:jev
//   TYPESAFE_API_KEY=<key> node packages/jev/scripts/fleet-run.mjs [--limit 57]
//
// It reads tasks through the tm8 CLI, so it sees exactly the facts a spawn
// would carry. It spawns nothing, writes nothing to the graph and costs about
// $0.00008 per task.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const { createJevClient, adviseModel } = await import(join(dist, 'index.js'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const limit = Number(arg('limit', '57'));

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set — nothing to ask with.');
  process.exit(2);
}

// `--format json` emits a trailing `[journal: …]` line that is not JSON.
const tm8 = (args) =>
  JSON.parse(
    execFileSync('tm8', [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .replace(/\[journal:[^\]]*\]\s*$/, ''),
  );

const page = tm8(['entity', 'query', '--kind', 'task', '--limit', String(limit)]).page;
const tasks = [];
for (const item of page.items) {
  const e = tm8(['entity', 'get', item.id]);
  tasks.push({
    id: e.id,
    title: e.title ?? '(untitled)',
    description: e.content?.description ?? '',
    priority: e.state?.priority,
    status: e.state?.status,
    acceptanceCriteriaCount: e.state?.acceptance?.total,
    parentTitle: e.hierarchy?.parent?.title ?? null,
  });
}

// A measurement run, not a launch: give each call room rather than the 5 s launch budget.
const client = createJevClient({ apiKey, totalBudgetMs: 60_000, attemptTimeoutMs: 30_000, retries: 1 });

const rows = [];
for (const task of tasks) {
  rows.push({ task, advice: await adviseModel(client, task) });
  process.stderr.write(`\r${rows.length}/${tasks.length}`);
}
process.stderr.write('\n');

const answered = rows.filter((r) => r.advice.ok);
const tally = (fn) =>
  [...answered.reduce((m, r) => m.set(fn(r), (m.get(fn(r)) ?? 0) + 1), new Map())].sort(
    (a, b) => b[1] - a[1],
  );
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`answered ${answered.length}/${rows.length}`);
const failures = rows.filter((r) => !r.advice.ok).reduce((m, r) => m.set(r.advice.reason, (m.get(r.advice.reason) ?? 0) + 1), new Map());
for (const [k, n] of failures) console.log(`  failed ${String(n).padStart(3)}  ${k}`);
console.log(`median latency ${median(rows.map((r) => r.advice.call.latencyMs))}ms`);
console.log(`jev cost $${rows.reduce((n, r) => n + r.advice.call.costUsd, 0).toFixed(4)}`);
for (const [k, n] of tally((r) => r.advice.verdict.tier)) console.log(`  ${String(n).padStart(3)}  ${k}`);
for (const [k, n] of tally((r) => r.advice.verdict.model)) console.log(`  ${String(n).padStart(3)}  ${k}`);
for (const [k, n] of tally((r) => r.advice.verdict.agentTool)) console.log(`  ${String(n).padStart(3)}  ${k}`);
