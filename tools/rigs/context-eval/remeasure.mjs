#!/usr/bin/env node
// Re-measure rows IN PLACE from what is already on disk: the node's stored
// manifest (<dataDir>/manifests/<sessionId>.json) and the row's transcript.
// Identity fields, success, checkResults, rubric and turn are untouched; the
// measurement fields are recomputed with the current rig (the same
// measureRow lanes.mjs uses) and the row gets `remeasuredAt` + `remeasureRig`
// (the rig's git sha). Refuses a row whose manifest or transcript is missing.
//
//   node remeasure.mjs results/<run>.jsonl [--all] [--session <id>] [--dry-run]
//
// Default: only rows with `measureError` (and no `excluded`). --all: every
// non-excluded row. A row that still fails keeps its (new) measureError.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureRow } from './measure-row.mjs';
import { nodeRecord } from './node-registry.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const file = process.argv[2];
if (!file) throw new Error('usage: node remeasure.mjs <results.jsonl> [--all] [--session <id>] [--dry-run]');
const all = process.argv.includes('--all');
const dry = process.argv.includes('--dry-run');
const only = arg('session');
let rigSha = 'unknown';
try {
  rigSha = execFileSync('git', ['-C', new URL('.', import.meta.url).pathname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* not a checkout */
}

const MEASURE_KEYS = ['session', 'surface', 'contextIndex', 'manifestContextIndexBytes', 'entries', 'dropped', 'system', 'firstUserBytes', 'attachments', 'firstRequestTokens', 'requests', 'usage', 'residentHarnessChars', 'residentTm8Bytes', 'expand', 'miss', 'blindFetchBytes', 'omittedFetches', 'needleOpened', 'needleMissed', 'needleState', 'memoriesCollapsed', 'memoryExpands', 'toolCalls', 'modelId', 'components', 'costUsd', 'measureError'];

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fixtures = new Map();
const tplFor = (row) => {
  const port = row.node?.port;
  if (!fixtures.has(port)) fixtures.set(port, JSON.parse(readFileSync(new URL(`./fixtures/node-${port}.json`, import.meta.url), 'utf8')));
  const tpl = fixtures.get(port).tasks[row.taskKey];
  if (!tpl) throw new Error(`fixtures/node-${port}.json has no template ${row.taskKey}`);
  if (tpl.templateId !== row.templateTaskId) throw new Error(`row ${row.sessionId}: templateTaskId ${row.templateTaskId} is not fixtures/node-${port}.json's ${tpl.templateId}`);
  return tpl;
};
let done = 0;
let failed = 0;
for (const row of rows) {
  if (row.excluded) continue;
  if (only && row.sessionId !== only) continue;
  if (!all && !row.measureError) continue;
  const tag = `${row.arm}/${row.model}/${row.taskKey}#${row.rep} (${row.sessionId})`;
  const node = nodeRecord(row.node.port);
  const manifestPath = join(node.dataDir, 'manifests', `${row.sessionId}.json`);
  if (!existsSync(manifestPath)) throw new Error(`${tag}: manifest missing at ${manifestPath}; refusing`);
  if (!row.transcript || !existsSync(row.transcript)) throw new Error(`${tag}: transcript missing (${row.transcript ?? 'none recorded'}); refusing`);
  const before = row.measureError ?? null;
  for (const k of MEASURE_KEYS) delete row[k];
  try {
    Object.assign(row, measureRow({ manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), transcriptText: readFileSync(row.transcript, 'utf8'), tpl: tplFor(row), taskKey: row.taskKey }));
    done++;
    console.error(`${tag}: measured (first=${row.firstRequestTokens} entryMiss=${row.miss.entry.count} headerMiss=${row.miss.header.count} memCollapsed=${row.memoriesCollapsed})${before ? ` — was: ${before}` : ''}`);
  } catch (e) {
    row.measureError = String(e.message ?? e);
    failed++;
    console.error(`${tag}: STILL NOT MEASURED: ${row.measureError}`);
  }
  row.remeasuredAt = new Date().toISOString();
  row.remeasureRig = rigSha;
}
if (!dry) writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.error(`${dry ? '(dry run) ' : ''}${done} re-measured, ${failed} still failing, ${rows.length} rows in ${file}`);
if (failed) process.exitCode = 1;
