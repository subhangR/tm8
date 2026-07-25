#!/usr/bin/env node
/**
 * Golden-workflow runner — the G1 gate artifact.
 *
 * G1 (09 §3.3) requires "five golden workflows executable as scripted HTTP
 * sequences" against tm8-server headless. This is that script.
 *
 * IT IS EXPECTED TO BE RED UNTIL M1. That is the point: the gate artifact
 * exists BEFORE the thing it gates, so "M1 is done" has an objective meaning
 * rather than a subjective one. Red is reported as red — the runner never
 * pretends a missing server is a skip.
 *
 * The five workflows share one seeded world and run IN ORDER: workflow 2 works
 * the task workflow 1 authored, 3 ships it, 4 grows knowledge off its thread,
 * 5 reads the whole thing back. That ordering is deliberate — it is the actual
 * lifecycle, and a suite of five independent worlds would not catch the
 * cross-workflow derived-truth bugs (staleness, unblock ripple) that are the
 * riskiest part of the model.
 *
 * USAGE
 *   node run.mjs                                  # all five, TM8_BASE_URL or :4610
 *   node run.mjs --only 03                        # one workflow (still seeds + runs its prerequisites)
 *   node run.mjs --base-url http://localhost:4610
 *   node run.mjs --json                           # machine-readable artifact on stdout
 *
 * EXIT CODES
 *   0  every step passed
 *   1  a step failed (or the suite is red pre-M1)
 *   2  bad usage
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractClient, DEFAULT_BASE_URL } from '../lib/http.mjs';
import { RunRecorder } from '../lib/assert.mjs';
import { buildWorld } from './lib/world.mjs';

import * as w1 from './workflows/01-author-and-stage.mjs';
import * as w2 from './workflows/02-agent-pulls-and-works.mjs';
import * as w3 from './workflows/03-ship-and-review.mjs';
import * as w4 from './workflows/04-knowledge-grows.mjs';
import * as w5 from './workflows/05-orient-a-newcomer.mjs';

export const WORKFLOWS = [w1, w2, w3, w4, w5];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run the suite. Exported so the vitest wrapper drives the exact same code —
 * two harnesses, one definition of what "the golden workflows pass" means.
 */
export async function runSuite({ baseUrl = DEFAULT_BASE_URL, only = null, headers = {} } = {}) {
  const client = new ContractClient({ baseUrl, headers });
  const rec = new RunRecorder('golden-suite', { expectRed: false });
  const startedAt = new Date().toISOString();

  const selected = only
    ? WORKFLOWS.filter((w) => w.id.startsWith(only))
    : WORKFLOWS;
  if (!selected.length) throw new Error(`--only '${only}' matched no workflow`);

  // Workflows are stateful in sequence; running a later one alone still needs
  // its predecessors, so we always run from the start up to the selection.
  const lastIndex = WORKFLOWS.indexOf(selected[selected.length - 1]);
  const toRun = WORKFLOWS.slice(0, lastIndex + 1);

  const results = [];
  let world;
  let fatal = null;

  try {
    world = await buildWorld(client, rec);
  } catch (error) {
    fatal = error;
  }

  if (!fatal) {
    for (const wf of toRun) {
      const wfRec = new RunRecorder(wf.id);
      const t0 = Date.now();
      let error = null;
      try {
        world = (await wf.run({ client, world, rec: wfRec })) ?? world;
      } catch (e) {
        error = e;
      }
      results.push({
        id: wf.id,
        title: wf.title,
        source: wf.source,
        ...wfRec.summary,
        durationMs: Date.now() - t0,
        steps: wfRec.steps,
        error: error ? error.message : null,
      });
      // A failed workflow poisons the ones after it (they depend on its state),
      // so we stop rather than emit a cascade of misleading failures.
      if (error) break;
    }
  }

  const ran = results.length;
  const passedWorkflows = results.filter((r) => !r.error).length;
  return {
    rig: 'golden-workflows',
    rigVersion: 1,
    gate: 'G1',
    baseUrl,
    startedAt,
    seed: { steps: rec.steps, ...rec.summary },
    fatal: fatal ? fatal.message : null,
    totalWorkflows: toRun.length,
    workflows: results,
    green: !fatal && ran === toRun.length && passedWorkflows === toRun.length,
    requests: client.log.length,
  };
}

function printReport(report) {
  const mark = (s) => ({ pass: '  ✓', fail: '  ✗', red: '  ✗', skip: '  –' })[s] ?? '  ?';
  console.log(`\ngolden workflows → ${report.baseUrl}   (gate G1)\n`);

  console.log('seed world');
  for (const s of report.seed.steps) {
    console.log(`${mark(s.status)} ${s.title}${s.error ? `\n      ${s.error}` : ''}`);
  }
  if (report.fatal) {
    console.log(`\n  FATAL: could not seed the world — ${report.fatal}`);
  }

  for (const wf of report.workflows) {
    console.log(`\n${wf.id} — ${wf.title}   [${wf.source}]`);
    for (const s of wf.steps) {
      console.log(`${mark(s.status)} ${s.title}${s.error ? `\n      ${s.error}` : ''}`);
    }
    if (wf.error && !wf.steps.some((s) => s.error === wf.error)) {
      console.log(`      ${wf.error}`);
    }
  }

  console.log('');
  if (report.green) {
    console.log(`GREEN — ${report.workflows.length} workflows, ${report.requests} contract-checked requests.`);
  } else if (report.fatal) {
    console.log(
      `RED — the seed world could not be built, so 0 of ${report.totalWorkflows} workflows ran. ` +
        'Expected until M1: the graph engine does not exist yet. ' +
        'After M1 this is a gate failure, not a status report.',
    );
  } else {
    const done = report.workflows.filter((w) => !w.error).length;
    console.log(
      `RED — ${done}/${report.totalWorkflows} workflows clean (${report.workflows.length} attempted). ` +
        'Expected until M1: the graph engine does not exist yet. ' +
        'After M1 this is a gate failure, not a status report.',
    );
  }
}

async function main() {
  const args = { baseUrl: DEFAULT_BASE_URL, only: null, json: false, out: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--base-url') args.baseUrl = process.argv[++i];
    else if (a === '--only') args.only = process.argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--out') args.out = process.argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('node run.mjs [--base-url URL] [--only 01|02|03|04|05] [--json] [--out FILE]');
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }

  const report = await runSuite({ baseUrl: args.baseUrl, only: args.only });

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  process.exit(report.green ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`golden runner crashed: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
