#!/usr/bin/env node
// Mark a lane row EXCLUDED with a reason (never delete it): the report counts
// it under start failures / set-aside, per arm × model.
//
//   node exclude.mjs results/<run>.jsonl --session <work-session-id> --reason "<why>" [--by <who>]
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (!file || !arg('session') || !arg('reason')) throw new Error('usage: node exclude.mjs <results.jsonl> --session <id> --reason "<why>" [--by <who>]');
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hit = rows.filter((r) => r.sessionId === arg('session'));
if (!hit.length) throw new Error(`no row with sessionId ${arg('session')} in ${file}`);
for (const r of hit) r.excluded = { reason: arg('reason'), by: arg('by') ?? 'coordinator', at: new Date().toISOString() };
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.error(`excluded ${hit.length} row(s) for session ${arg('session')}: ${arg('reason')}`);
