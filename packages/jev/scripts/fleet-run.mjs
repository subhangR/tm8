#!/usr/bin/env node
// Ask the REAL Jev API about REAL tm8 tasks, and print what it decided.
//
// This is the script that produced EVIDENCE.md. It exists so the numbers in
// that file can be re-derived rather than believed, and so the next person to
// change the weights can see what moved.
//
//   TYPESAFE_API_KEY=<key> node packages/jev/scripts/fleet-run.mjs [--limit 57] [--policy auto]
//
// It reads tasks through the tm8 CLI, so it sees exactly the facts a spawn
// would carry. It spawns nothing, writes nothing to the graph and costs about
// $0.00008 per task.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const { JevClient } = await import(join(dist, 'client.js'));
const { JevRoutingAdvisor } = await import(join(dist, 'advisor.js'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const limit = Number(arg('limit', '57'));
const policy = arg('policy', 'auto');
const baseline = arg('baseline', 'claude-opus-5');

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

const client = new JevClient({ apiKey, timeoutMs: 30_000, retries: 1 });
const advisor = new JevRoutingAdvisor({ client, policy, defaultModel: baseline });

const rows = [];
for (const task of tasks) {
  const advice = await advisor.advise(
    task,
    { requestedModel: null, memberModel: baseline, requestedAgentTool: null },
    'inline',
  );
  rows.push({ task, advice });
  process.stderr.write(`\r${rows.length}/${tasks.length}`);
}
process.stderr.write('\n');

const answered = rows.filter((r) => r.advice);
const tally = (fn) =>
  [...answered.reduce((m, r) => m.set(fn(r), (m.get(fn(r)) ?? 0) + 1), new Map())].sort(
    (a, b) => b[1] - a[1],
  );
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`answered ${answered.length}/${rows.length}, policy=${policy}, baseline=${baseline}`);
console.log(`median latency ${median(answered.map((r) => r.advice.activation.latencyMs))}ms`);
console.log(
  `jev cost $${answered.reduce((n, r) => n + r.advice.activation.jevCostUsd, 0).toFixed(4)}`,
);
for (const [k, n] of tally((r) => r.advice.activation.appliedModel)) console.log(`  ${String(n).padStart(3)}  ${k}`);
for (const [k, n] of tally((r) => r.advice.activation.appliedAgentTool)) console.log(`  ${String(n).padStart(3)}  ${k}`);

const saved = answered.reduce((n, r) => n + (r.advice.activation.savings?.savedUsd ?? 0), 0);
const base = answered.reduce((n, r) => n + (r.advice.activation.savings?.baselineUsd ?? 0), 0);
console.log(`projected saving $${saved.toFixed(2)} of $${base.toFixed(2)} (${((100 * saved) / base).toFixed(1)}%) — counterfactual, not measured`);
