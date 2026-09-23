#!/usr/bin/env node
/**
 * journal-report — where agent tokens actually go, across every session this
 * node has journaled.
 *
 * WHY THIS EXISTS. `packages/cli/src/journal-stats.ts` is a complete analysis
 * library — spend per command, byte-identical re-fetch share, poll-loop
 * detection, top consumers — and until now nothing called it except its own
 * unit test. The measurement existed with no door on it. This is the door.
 *
 * It is a SCRIPT rather than a `tm8` command on purpose: adding a command means
 * adding a row to the discovery catalog, which moves the catalog digest and a
 * set of hardcoded count pins across three packages. That cost is worth paying
 * for a surface agents use, and not worth paying to answer a question once. If
 * this becomes a habit, promote it deliberately.
 *
 * ESTIMATES, NOT BILLING. Every token number here is `chars / 4` measured at
 * the CLI boundary — the same estimator the journal records under
 * `tokens.estimator`. It is not provider-billed usage and must never be
 * presented as such. What it measures precisely is the number this repo can
 * actually change: bytes the CLI hands an agent.
 *
 *   node scripts/journal-report.mjs [--dir <journals>] [--json] [--top N]
 *                                   [--since <ISO>] [--class agent|harness|human]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computeStats, parseJournalText } from '../packages/cli/dist/journal-stats.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DIR = flag('dir', process.env.TM8_JOURNAL_DIR ?? '/home/tm8/prod-data/journals');
const TOP = Number(flag('top', '12'));
const SINCE = flag('since', null);
const CLASS = flag('class', 'agent');
const AS_JSON = has('json');

/* ---------------------------------------------------------------------- */

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => join(DIR, f));

let records = [];
let malformed = 0;
let bytes = 0;
for (const f of files) {
  bytes += statSync(f).size;
  const parsed = parseJournalText(readFileSync(f, 'utf8'));
  malformed += parsed.malformed;
  records.push(...parsed.records);
}

if (SINCE !== null) {
  const cut = Date.parse(SINCE);
  records = records.filter((r) => Date.parse(r.startedAt ?? '') >= cut);
}

const stats = computeStats(records, { classFilter: CLASS, topN: TOP });

/**
 * PAYLOAD OVERHEAD — the part `computeStats` cannot see.
 *
 * The journal keeps the exact char counts but only a bounded sample of the
 * body, so this reads the sample and asks a narrower question: of the bytes a
 * read returns, how many are structural envelope repeated per row rather than
 * fields a caller plausibly wants? Answerable only for records whose sample is
 * complete (`truncated === false`), so it is reported with its own n.
 */
const ENVELOPE_KEYS = new Set([
  'spaceId', 'position', 'visibility', 'createdAt', 'updatedAt', 'deletedAt',
  'counters', 'capabilities', 'badges', 'category', 'parentId', 'avatar',
  'ownerMemberId', 'isAgent', 'role', 'kind',
]);

function envelopeShare(value) {
  let envelope = 0;
  let total = 0;
  const walk = (node) => {
    if (node === null || typeof node !== 'object') {
      total += JSON.stringify(node)?.length ?? 0;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const size = (JSON.stringify(v)?.length ?? 0) + k.length + 3;
      total += k.length + 3;
      if (ENVELOPE_KEYS.has(k)) envelope += size;
      else walk(v);
    }
  };
  walk(value);
  return { envelope, total };
}

let overheadN = 0;
let overheadEnvelope = 0;
let overheadTotal = 0;
for (const r of records) {
  if (r.output?.truncated !== false) continue;
  const sample = r.output?.stdoutSample;
  if (typeof sample !== 'string' || sample.length < 200) continue;
  let parsed;
  try { parsed = JSON.parse(sample); } catch { continue; }
  const { envelope, total } = envelopeShare(parsed);
  if (total === 0) continue;
  overheadN += 1;
  overheadEnvelope += envelope;
  overheadTotal += total;
}

const k = (n) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (n) => `${(n * 100).toFixed(1)}%`;

if (AS_JSON) {
  console.log(JSON.stringify({
    corpus: { files: files.length, bytes, records: records.length, malformed },
    stats,
    envelopeOverhead: overheadN === 0 ? null : {
      n: overheadN, share: overheadEnvelope / overheadTotal,
    },
  }, null, 2));
  process.exit(0);
}

console.log(`\n  JOURNAL REPORT — ${CLASS} invocations`);
console.log(`  ${files.length} session files · ${k(bytes)}B on disk · ${records.length} records parsed` +
            (malformed ? ` · ${malformed} malformed` : ''));
if (SINCE) console.log(`  since ${SINCE}`);
console.log(`  estimator: chars/4 at the CLI boundary — NOT provider-billed usage\n`);

console.log(`  invocations      ${stats.invocations}`);
console.log(`  est tokens       ${k(stats.estTokens)}`);
console.log(`  failed           ${stats.failed} (${pct(stats.failureRate)})`);
console.log(`  re-fetch waste   ${k(stats.refetch.estTokens)} est tokens ` +
            `(${pct(stats.refetch.share)} of spend, ${stats.refetch.records} records)`);
if (overheadN > 0) {
  console.log(`  envelope share   ${pct(overheadEnvelope / overheadTotal)} of parsed read bodies ` +
              `(n=${overheadN} complete samples)`);
}
console.log(`  by class         ${Object.entries(stats.byClass).map(([c, n]) => `${c} ${n}`).join(' · ')}`);

console.log(`\n  SPEND BY COMMAND (top ${TOP})`);
console.log(`  ${'command'.padEnd(26)}${'calls'.padStart(7)}${'est tok'.padStart(10)}${'tok/call'.padStart(10)}${'fail'.padStart(8)}`);
for (const c of stats.perCommand.slice(0, TOP)) {
  console.log(`  ${c.command.padEnd(26)}${String(c.count).padStart(7)}${k(c.estTokens).padStart(10)}` +
              `${k(Math.round(c.estTokens / Math.max(1, c.count))).padStart(10)}${pct(c.failureRate).padStart(8)}`);
}

console.log(`\n  MOST EXPENSIVE SINGLE CALLS`);
for (const t of stats.topExpensive.slice(0, Math.min(TOP, 8))) {
  console.log(`  ${k(t.estTokens).padStart(7)}  ${t.argv.slice(0, 6).join(' ').slice(0, 78)}`);
}

if (stats.pollLoops.length > 0) {
  console.log(`\n  POLL LOOPS (same argv, ${stats.pollLoops.length} signature(s))`);
  for (const p of stats.pollLoops.slice(0, 6)) {
    console.log(`  ${String(p.count).padStart(5)}x every ${Math.round(p.meanGapMs / 1000)}s  ` +
                `${p.argv.slice(0, 5).join(' ').slice(0, 62)}`);
  }
}
console.log();
