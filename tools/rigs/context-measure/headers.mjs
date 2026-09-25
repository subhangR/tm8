#!/usr/bin/env node
// Write AUTHORED selection headers on the fixture docs (the "+index authored"
// pass). The first +index pass runs on derived headers only, as real 7778
// entities are today; this one models the steady state the layered prompt
// (#786) asks agents to produce.
//
//   TM8_CLI=… node headers.mjs --fixture fixture.json
//
// A needle's authored header describes its rule WITHOUT stating it, except the
// `merchant` needle (headerCarriesFact), whose summary IS the rule: that one
// task shows what a header alone is worth.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TASKS } from './fixture-data.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const fx = JSON.parse(readFileSync(arg('fixture'), 'utf8'));
const tm8 = (...a) => JSON.parse(execFileSync(process.env.TM8_CLI, [...a, '--format', 'json'], { encoding: 'utf8' }));

let n = 0;
for (const task of TASKS) {
  const t = fx.tasks[task.key];
  if (!t) continue;
  tm8('entity', 'header', 'set', t.needleId, '--when-to-use', task.needle.header.whenToUse, '--summary', task.needle.header.summary);
  n++;
}
for (const d of fx.distractors) {
  tm8('entity', 'header', 'set', d.id, '--when-to-use', `When you need the team's ${d.title.toLowerCase()}`, '--summary', `Informational notes on ${d.title.toLowerCase()}. Defines no ledger-lite helper behaviour.`);
  n++;
}
console.error(`authored headers written on ${n} docs`);
