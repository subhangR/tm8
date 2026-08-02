#!/usr/bin/env node
/**
 * Journal stats, self-serve — the F8 report as a standalone in-repo script.
 *
 * DELIBERATELY NOT A CATALOG COMMAND in v1: a new `journal stats` cmd path
 * would move the frozen-grammar pins (catalog counts, digest, manifest); this
 * script touches nothing frozen at the cost of discoverability. Promote it to
 * a real command only with the catalog work priced in.
 *
 * Usage:
 *   node scripts/journal-stats.mjs <file-or-dir>... [--class agent|harness|human] [--top N] [--json]
 *
 * Needs a built tree (`bun run build:cli`) — the arithmetic lives in
 * `src/journal-stats.ts` so the spend line, this report, and the unit tests
 * can never disagree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distModule = join(here, '../dist/journal-stats.js');

let stats;
try {
  stats = await import(distModule);
} catch {
  process.stderr.write(`journal-stats: no built module at ${distModule} — run \`bun run build:cli\` first\n`);
  process.exit(2);
}
const { parseJournalText, computeStats } = stats;

const args = process.argv.slice(2);
const paths = [];
let classFilter;
let topN = 10;
let asJson = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--class') classFilter = args[++i];
  else if (a === '--top') topN = Number(args[++i]);
  else if (a === '--json') asJson = true;
  else paths.push(a);
}
if (paths.length === 0) {
  process.stderr.write('journal-stats: name at least one journal file or directory of *.jsonl\n');
  process.exit(2);
}

const files = paths.flatMap((p) => {
  const s = statSync(p);
  if (s.isDirectory()) return readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => join(p, f));
  return [p];
});

let records = [];
let malformed = 0;
for (const file of files) {
  const parsed = parseJournalText(readFileSync(file, 'utf8'));
  records = records.concat(parsed.records);
  malformed += parsed.malformed;
}

const report = computeStats(records, { classFilter, topN });

if (asJson) {
  process.stdout.write(`${JSON.stringify({ files: files.length, malformed, ...report }, null, 2)}\n`);
  process.exit(0);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lines = [];
lines.push(`files ${files.length} · records ${report.invocations}${classFilter ? ` (class=${classFilter})` : ''} · malformed ${malformed}`);
lines.push(`class split: agent ${report.byClass.agent} · harness ${report.byClass.harness} · human ${report.byClass.human}`);
lines.push(`est tokens (chars/4): ${report.estTokens} · failures ${report.failed} (${pct(report.failureRate)})`);
lines.push(`byte-identical re-fetches: ${report.refetch.records} records, ${report.refetch.estTokens} est tokens (${pct(report.refetch.share)} of cli→agent)`);
lines.push('');
lines.push('per command (by est tokens):');
for (const c of report.perCommand.slice(0, 20)) {
  lines.push(`  ${c.command}  ×${c.count}  est ${c.estTokens}  fail ${pct(c.failureRate)}`);
}
lines.push('');
lines.push(`top ${topN} most expensive invocations:`);
for (const t of report.topExpensive) {
  lines.push(`  est ${t.estTokens}  ${t.startedAt}  ${t.argv.join(' ')}`);
}
if (report.pollLoops.length > 0) {
  lines.push('');
  lines.push('poll-loop signatures (same argv ≥5× in one session):');
  for (const p of report.pollLoops.slice(0, 10)) {
    lines.push(`  ×${p.count}  mean gap ${p.meanGapMs}ms  ${p.argv.join(' ')}`);
  }
}
process.stdout.write(`${lines.join('\n')}\n`);
