#!/usr/bin/env node
// Per-arm medians and spread over results.jsonl rows (run-lane.mjs).
//
//   node summarize.mjs results.jsonl [--arms main,lean,index] [--set fixture|replica|all] [--markdown]
//
// Medians with [min–max], never means alone (the coordinator's rule 6).
// Launch-only rows feed the bytes columns; full rows also feed success,
// expand, miss, blind fetch and resident cost.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const set = arg('set') ?? 'all';
const arms = arg('arms')?.split(',') ?? [...new Set(rows.map((r) => r.arm))];
const inSet = (r) => set === 'all' || (set === 'replica' ? r.taskKey.startsWith('replica-') : !r.taskKey.startsWith('replica-'));

export function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, median, min: v[0], max: v[v.length - 1] };
}
const fmt = (s, unit = '') => (s ? `${Math.round(s.median).toLocaleString('en-US')}${unit} [${Math.round(s.min).toLocaleString('en-US')}–${Math.round(s.max).toLocaleString('en-US')}] n=${s.n}` : '—');
const pct = (k, n) => (n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : '—');

const COLS = [
  ['first-request tokens', (r) => r.firstRequestTokens],
  ['tm8 system bytes', (r) => r.system?.tm8Bytes],
  ['task prompt bytes (turn 1)', (r) => r.firstUserBytes],
  ['tm8 total bytes', (r) => (r.system?.tm8Bytes ?? 0) + (r.firstUserBytes ?? 0)],
  ['harness system chars', (r) => r.system?.harnessChars],
  ['  of which Claude in Chrome', (r) => r.system?.chromeChars],
  ['skill_listing chars', (r) => r.attachments?.skill_listing ?? 0],
  ['deferred_tools_delta chars', (r) => r.attachments?.deferred_tools_delta ?? 0],
  ['mcp_instructions_delta chars', (r) => r.attachments?.mcp_instructions_delta ?? 0],
  ['agent_listing_delta chars', (r) => r.attachments?.agent_listing_delta ?? 0],
  ['manifest.context.index.bytes', (r) => r.manifestContextIndexBytes],
];
const FULL = [
  ['API requests', (r) => r.requests],
  ['wall seconds', (r) => r.wallSeconds],
  ['resident harness chars', (r) => r.residentHarnessChars],
  ['resident tm8 bytes', (r) => r.residentTm8Bytes],
  ['total input-side tokens', (r) => (r.usage ? r.usage.input + r.usage.cacheCreation + r.usage.cacheRead : null)],
  ['output tokens', (r) => r.usage?.output],
  ['expand rate (opened / collapsed)', (r) => (r.expand?.rate ?? null) === null ? null : r.expand.rate * 100],
  ['blind-fetch bytes', (r) => r.blindFetchBytes],
];

const out = [];
out.push(`| measure (${set}) | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
for (const [name, f] of COLS) out.push(`| ${name} | ${arms.map((a) => fmt(stats(rows.filter((r) => r.arm === a && inSet(r)).map(f)))).join(' | ')} |`);
const full = (a) => rows.filter((r) => r.arm === a && inSet(r) && r.success);
if (arms.some((a) => full(a).length)) {
  for (const [name, f] of FULL) out.push(`| ${name} | ${arms.map((a) => fmt(stats(full(a).map(f)))).join(' | ')} |`);
  const count = (a, p) => pct(full(a).filter(p).length, full(a).length);
  out.push(`| task success (all four gates) | ${arms.map((a) => count(a, (r) => r.success.success)).join(' | ')} |`);
  out.push(`| deliverable correct | ${arms.map((a) => count(a, (r) => r.success.deliverableCorrect)).join(' | ')} |`);
  out.push(`| launches with >= 1 MISS | ${arms.map((a) => count(a, (r) => r.miss?.launchMissed)).join(' | ')} |`);
  out.push(`| needle opened | ${arms.map((a) => count(a, (r) => r.needleOpened)).join(' | ')} |`);
  out.push(`| lanes that hit the timeout | ${arms.map((a) => count(a, (r) => r.ended === 'timeout')).join(' | ')} |`);
}
const loads = rows.filter((r) => arms.includes(r.arm) && inSet(r)).map((r) => Number(String(r.uptimeStart).split(/\s+/)[0]));
out.push('', `host load at lane start (1-min): ${fmt(stats(loads))}`);
console.log(out.join('\n'));
