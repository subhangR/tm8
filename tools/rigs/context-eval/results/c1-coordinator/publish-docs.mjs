#!/usr/bin/env node
// C1's lane-doc publisher (coordinator script; NOT part of the rig, no measurement side effect).
// Reads the slice's results JSONL files in order, numbers lanes 1..N in file order (append-only,
// so numbering is stable), and on 7778 (ambient `tm8`) creates one doc per lane as a child of the
// arm summary doc, attached to the coordinator task, then rewrites the summary doc's table.
// Idempotent by title: a ledger maps title -> {id, hash}; an unchanged lane is skipped, a changed
// one (e.g. a new observation note) is updated under --expect-version.
//
//   node publish-docs.mjs <results1.jsonl> [<results2.jsonl> ...] [--dry-run]
// Notes (my observations) live in notes.json: { "<sessionId>": "line\nline" }.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SUMMARY = '01a0d960-32b1-7241-b451-7d734a06985d';
const TASK = '01a0d943-4895-7ae3-8074-696dcf64171d';
const CWD = '/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d958-19b5-7fc6-930f-7f1bb982152c';
const HERE = '/private/tmp/ctxeval/node1';
const LEDGER = `${HERE}/published.json`;
const NOTES = `${HERE}/notes.json`;
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: publish-docs.mjs <results.jsonl>... [--dry-run]'); process.exit(2); }

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
const notes = existsSync(NOTES) ? JSON.parse(readFileSync(NOTES, 'utf8')) : {};
const tm8 = (argv) => {
  const out = execFileSync('tm8', [...argv, '--format', 'json'], { cwd: CWD, encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
};
const MODEL = { sonnet5: 'Sonnet 5', haiku45: 'Haiku 4.5', opus55: 'Opus 5.5' };
const rows = [];
for (const f of files) {
  if (!existsSync(f)) { console.error(`(no ${f} yet)`); continue; }
  for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim()) rows.push({ ...JSON.parse(line), _file: f });
}
const n = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const yn = (v) => (v == null ? '—' : v ? 'yes' : 'no');
const total = (u) => (u ? (u.input ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0) : null);
const START_FAIL = new Set(['no-transcript', 'spawn-error', 'auth-error']);

function laneDoc(r, i) {
  const lane = i + 1;
  const rerun = /-rep2\.jsonl$/.test(r._file);
  const title = `${r.arm} · ${r.taskKey} · ${MODEL[r.model] ?? r.model} · lane ${lane}${rerun ? ' · rep2 re-run' : ''}`;
  const startFail = START_FAIL.has(r.ended) || (r.excluded && !r.firstRequestTokens);
  const s = r.success ?? {};
  const rub = r.rubric;
  const auto = [];
  const pend = r.measureError ? ' — measurement pending remeasure' : '';
  if (r.excluded) auto.push(`EXCLUDED (${r.excluded.by}): ${r.excluded.reason}`);
  if (r.measureError) auto.push(`measure error: ${r.measureError}`);
  if (r.judgeError) auto.push(`judge error: ${r.judgeError}`);
  if (rub) {
    const failed = rub.items.filter((x) => !x.pass).map((x) => x.name);
    auto.push(failed.length ? `rubric misses: ${failed.join(', ')}` : `all ${rub.items.length} rubric items pass`);
  }
  if (r.needleState) auto.push(`needle entry ${r.needleState}, opened: ${yn(r.needleOpened)}`);
  if (r.turn) auto.push(`multiturn: ${JSON.stringify(r.turn)}`);
  const body = [
    `# ${title}`,
    '',
    `Slice ${r.slice} · node ${r.node?.port} (${r.node?.db}) · build ${String(r.buildSha).slice(0, 8)} · fixture v${r.fixtureVersion?.schemaVersion}/${r.fixtureVersion?.contentHash} · results \`${r._file.replace(/^.*\/tools\/rigs\//, 'tools/rigs/')}\``,
    '',
    '| field | value |',
    '|---|---|',
    `| arm | ${r.arm} |`,
    `| subject model | ${MODEL[r.model] ?? r.model} (\`${r.modelId ?? '—'}\`) |`,
    `| task key / family / rep | ${r.taskKey} / ${r.family} / ${rerun ? `rep 2 (clean RE-RUN; the row's rep field reads ${r.rep} because it came from a --reps 1 runner)` : r.rep} |`,
    `| dev-node session / task copy | ${r.sessionId ?? '—'} / ${r.taskId ?? '—'} (template ${r.templateTaskId ?? '—'}) |`,
    `| ended / wall | ${r.ended ?? '—'} / ${n(r.wallSeconds)} s |`,
    `| first-request tokens | ${n(r.firstRequestTokens)}${pend} |`,
    `| total tokens (input + cache create + cache read + output) | ${n(total(r.usage))} (${r.usage ? `${n(r.usage.input)} + ${n(r.usage.cacheCreation)} + ${n(r.usage.cacheRead)} + ${n(r.usage.output)}` : '—'}) |`,
    `| requests / tool calls | ${n(r.requests)} / ${n(r.toolCalls)} |`,
    `| entry misses / header misses | ${n(r.miss?.entry?.count)} / ${n(r.miss?.header?.count)} |`,
    `| expand rate | ${r.expand ? `${r.expand.rate.toFixed(3)} (${r.expand.opened}/${r.expand.entries} entries)` : '—'}${pend} |`,
    `| blind-fetch bytes | ${n(r.blindFetchBytes)}${pend} |`,
    `| cost (estimate) | ${r.costUsd != null ? `$${r.costUsd.toFixed(3)}` : '—'} |`,
    `| start failure | ${startFail ? 'yes' : 'no'} |`,
    `| committed / checks / closeout / ticked | ${yn(s.committed)} / ${s.checks ? `${s.checks.passed}/${s.checks.total}` : '—'} / ${yn(s.closeout)} / ${yn(s.ticked)} |`,
    `| success | ${yn(s.success)}${r.family === 'memory' && Array.isArray(r.checkResults) ? ` (D7, alias checks excluded: ${yn(s.committed && s.closeout && s.ticked && r.checkResults.filter((c) => c.set !== 'alias').every((c) => c.pass))}; alias memory trusted over conflicting skill: ${yn(r.checkResults.filter((c) => c.set === 'alias').every((c) => c.pass))})` : ''} |`,
    `| rubric | ${rub ? `${rub.score.toFixed(2)} (${rub.items.map((x) => `${x.name} ${x.pass ? '✓' : '✗'}`).join(', ')})` : '—'} |`,
    `| load start → end | ${r.uptimeStart ?? '—'} → ${r.uptimeEnd ?? '—'} (waited ${n(r.waitedSeconds)} s) |`,
    `| transcript | \`${r.transcript ?? '—'}\` |`,
    `| excluded | ${r.excluded ? `${r.excluded.reason} (by ${r.excluded.by})` : 'no'} |`,
    '',
    '## Observations',
    '',
    ...(notes[r.sessionId] ? notes[r.sessionId].split('\n').map((l) => `- ${l}`) : []),
    ...auto.map((l) => `- ${l}`),
    '',
  ].join('\n');
  const row = `| ${lane} | ${r.taskKey} | ${MODEL[r.model] ?? r.model} | ${n(r.firstRequestTokens)} | ${n(total(r.usage))} | ${n(r.requests)} | ${n(r.miss?.entry?.count)} | ${n(r.miss?.header?.count)} | ${r.expand ? r.expand.rate.toFixed(2) : '—'} | ${n(r.blindFetchBytes)} | ${startFail ? 'yes' : 'no'} | ${r.excluded ? `excluded: ${r.excluded.reason}` : `${yn(s.success)} (rubric ${rub ? rub.score.toFixed(2) : '—'})`} |`;
  return { title, body, row };
}

const docs = rows.map(laneDoc);
let created = 0, updated = 0, skipped = 0;
for (const d of docs) {
  const content = JSON.stringify({ kind: 'doc', body: d.body, format: 'markdown' });
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const have = ledger[d.title];
  if (have?.hash === hash) { skipped++; d.id = have.id; continue; }
  if (dry) { console.log(`${have ? 'update' : 'create'} ${d.title}`); d.id = have?.id ?? '(new)'; continue; }
  if (have) {
    const cur = tm8(['entity', 'get', have.id]);
    tm8(['entity', 'update', have.id, '--expect-version', String(cur.version), '--content', content]);
    updated++;
  } else {
    const res = tm8(['entity', 'create', 'doc', d.title, '--parent', SUMMARY, '--attach-to', TASK, '--content', content]);
    ledger[d.title] = { id: res.id ?? res.entity?.id ?? res.data?.id };
    if (!ledger[d.title].id) throw new Error(`create returned no id: ${JSON.stringify(res).slice(0, 300)}`);
    created++;
  }
  ledger[d.title].hash = hash;
  d.id = ledger[d.title].id;
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
}

// summary table: rebuilt whole from the rows (idempotent)
const status = process.env.C1_STATUS ?? 'RUNNING';
const summaryBody = [
  '# Arm lean — lane summary (slice c1, node 4621)',
  '',
  `Status: ${status}. Coordinator task: see attachment. Each lane below is a child doc of this doc, titled "lean · <task> · <model> · lane N". Lanes are numbered in results-file order: ${files.map((f) => `\`${f.replace(/^.*\/tools\/rigs\//, 'tools/rigs/')}\``).join(' then ')}.`,
  '',
  '| lane | task | model | first-request tokens | total tokens | requests | entry misses | header misses | expand | blind-fetch B | start failure | success | doc |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...docs.map((d) => `${d.row} ${d.id} |`),
  '',
  ...(process.env.C1_SUMMARY_TAIL ? [readFileSync(process.env.C1_SUMMARY_TAIL, 'utf8')] : []),
].join('\n');
if (dry) { console.log(summaryBody); process.exit(0); }
const sumContent = JSON.stringify({ kind: 'doc', body: summaryBody, format: 'markdown' });
const cur = tm8(['entity', 'get', SUMMARY]);
if (cur.content?.body !== summaryBody) tm8(['entity', 'update', SUMMARY, '--expect-version', String(cur.version), '--content', sumContent]);
console.log(`lanes ${docs.length}: created ${created}, updated ${updated}, unchanged ${skipped}; summary v${cur.version}${cur.content?.body !== summaryBody ? ' -> updated' : ' (unchanged)'}`);
