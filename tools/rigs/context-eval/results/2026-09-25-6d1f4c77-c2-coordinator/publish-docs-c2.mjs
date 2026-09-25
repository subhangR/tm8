#!/usr/bin/env node
// c2 coordinator's lane-doc publisher (NOT part of the rig; reads the rig's results JSONL only).
//   node publish-docs-c2.mjs <results.jsonl> [--dry-run]
// Per row: one doc on 7778 (ambient `tm8`), child of the arm summary doc, attached to the c2 task,
// titled '<arm> · <task> · <model> · lane <rep>' (a re-run of the same cell gets ' (re-run k)').
// Idempotent: state file maps sessionId -> docId, and an existing child with the same title is reused.
// Then rewrites the summary doc's table from every row (expect-version from a fresh read).
// Coordinator notes per lane: notes/<sessionId>.md next to this script (appended to Observations).
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SUMMARY = '01a0d960-355a-7f0e-8dfe-c3ed0b777644';
const TASK = '01a0d943-4979-71ce-8e93-cd4f8386411f';
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'lane-docs.json');
// args: <results.jsonl>[=label] ... [--dry-run] [--final]; label 'rep2' = a rep-2 cell re-run in its own file
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const files = args.filter((a) => !a.startsWith('--')).map((a) => { const [path, label] = a.split('='); return { path, label }; });
const DRY = flags.includes('--dry-run');
if (!files.length) { console.error('usage: publish-docs-c2.mjs <results.jsonl>[=label] ... [--dry-run] [--final]'); process.exit(2); }
const file = files[0].path;

const tmp = mkdtempSync(join(tmpdir(), 'c2pub-'));
const json = (s) => JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
const tm8 = (...args) => execFileSync('tm8', [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

const rows = files.filter(({ path }) => existsSync(path)).flatMap(({ path, label }) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), _file: path.split('/').pop(), _label: label })));
const n = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const yn = (v) => (v == null ? '—' : v ? 'yes' : 'no');
const totalIn = (u) => (u ? (u.input ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0) : null);
const total = (u) => (u ? totalIn(u) + (u.output ?? 0) : null);
const PEND = 'measurement pending remeasure';
const pend = (r) => Boolean(r.measureError);
const startFailure = (r) => Boolean(['no-transcript', 'spawn-error', 'auth-error', 'task-copy-error'].includes(r.ended) || (r.excluded && r.firstRequestTokens == null));

// titles: '<arm> · <task> · <model> · lane <rep>', disambiguate repeated cells in file order
const seen = {};
for (const r of rows) {
  const base = r._label === 'rep2' ? `${r.arm} · ${r.taskKey} · ${r.model} · lane 2 (re-run, rep2 file)` : `${r.arm} · ${r.taskKey} · ${r.model} · lane ${r.rep}`;
  seen[base] = (seen[base] ?? 0) + 1;
  r._title = seen[base] === 1 ? base : `${base} (re-run ${seen[base]})`;
  r._key = r.sessionId ?? `nosession:${base}:${seen[base]}`;
}

function observations(r) {
  const o = [];
  if (r.excluded) o.push(`Set aside (${r.excluded.by}): ${r.excluded.reason}.`);
  if (r.measureError) o.push(`measureError: ${r.measureError}`);
  if (r.judgeError) o.push(`judgeError: ${r.judgeError}`);
  if (r.needleState != null) o.push(`Needle was ${r.needleState} in the index and ${r.needleOpened ? 'opened' : 'NOT opened'}; ${r.expand?.opened ?? 0} of ${r.expand?.entries ?? 0} entries expanded (${r.expand?.collapsedEntries ?? 0} collapsed).`);
  const fails = (r.checkResults ?? []).filter((c) => !c.pass);
  if (r.checkResults?.length) o.push(fails.length ? `Failed checks: ${fails.map((c) => `${c.expr} [${c.set}] want ${JSON.stringify(c.want)}`).join('; ')}.` : `All ${r.checkResults.length} hidden checks passed.`);
  if (r.family === 'memory') o.push(`Memories collapsed ${n(r.memoriesCollapsed)}, memory expands ${n(r.memoryExpands)}.`);
  if (r.turn) o.push(`Multi-turn: ${JSON.stringify(r.turn).slice(0, 300)}`);
  if (r.ended === 'timeout') o.push('Hit the lane timeout; measured anyway.');
  if (r.family !== 'replica' && r.success?.deliverableCorrect && r.success?.closeout && r.success?.ticked === false) o.push('Deliverable correct and closeout posted, but the acceptance criteria were left unticked: the rubric miss is process, not correctness.');
  if (r.family === 'replica') {
    o.push('Replica accuracy for this run (decision D8, amended) = closeout + ticked only; committed is n/a on all three v2 replicas (their named code is not in ledger-lite). The raw rubric above is unchanged; the report applies D8. This family\'s real measures are sizes, misses and blind-fetch.');
    if (r.ended === 'idle' && (r.requests ?? 99) <= 2 && !r.success?.committed && !r.success?.closeout) o.push('Outcome: ASKED THE HUMAN (ended idle, requests <= 2, no commit, no closeout) — a named outcome per D8, not scored 0.');
  }
  const notes = join(HERE, 'notes', `${r.sessionId}.md`);
  if (r.sessionId && existsSync(notes)) o.push(`Coordinator: ${readFileSync(notes, 'utf8').trim()}`);
  const esc = join(HERE, 'notes', `${r.sessionId}.escape.md`);
  if (r.sessionId && existsSync(esc)) o.push(readFileSync(esc, 'utf8').trim());
  return o;
}

function laneBody(r) {
  const s = r.success ?? {};
  const rub = r.rubric;
  const items = rub?.items?.map((i) => `${i.name} ${i.pass ? '✓' : '✗'}`).join(' · ') ?? '—';
  return [
    `# ${r._title}`,
    '',
    `Slice ${r.slice} · node ${r.node?.port} (${r.node?.db}) · build ${String(r.buildSha).slice(0, 8)} · fixture v${r.fixtureVersion?.schemaVersion ?? r.fixtureVersion} · results: ${r._file}${r._label === 'rep2' ? ' (rep-2 cell re-run; the row itself says rep 1 because lanes.mjs has no rep offset)' : ''}`,
    '',
    '| field | value |', '|---|---|',
    `| arm | ${r.arm} |`,
    `| subject model | ${r.model} (${r.modelId ?? '—'}) |`,
    `| task key / family | ${r.taskKey} / ${r.family} |`,
    `| rep | ${r.rep} |`,
    `| session / task copy / template | ${r.sessionId ?? '—'} / ${r.taskId ?? '—'} / ${r.templateTaskId ?? '—'} |`,
    `| ended | ${r.ended ?? '—'} (wall ${n(r.wallSeconds)} s) |`,
    `| start failure | ${yn(startFailure(r))} |`,
    `| excluded | ${r.excluded ? `${r.excluded.reason} (by ${r.excluded.by})` : 'no'} |`,
    `| first-request tokens | ${pend(r) ? PEND : `${n(r.firstRequestTokens)} `} |`,
    `| total tokens (input-side + output) | ${pend(r) ? PEND : `${n(total(r.usage))} = ${n(totalIn(r.usage))} in (${n(r.usage?.input)} + cache-create ${n(r.usage?.cacheCreation)} + cache-read ${n(r.usage?.cacheRead)}) + ${n(r.usage?.output)} out `} |`,
    `| requests / tool calls | ${pend(r) ? PEND : `${n(r.requests)} / ${n(r.toolCalls)} `} |`,
    `| entry misses / header misses | ${pend(r) ? PEND : `${n(r.miss?.entry?.count)} / ${n(r.miss?.header?.count)} (header bytes ${n(r.miss?.header?.bytes)}) `} |`,
    `| expand rate (of collapsed) | ${pend(r) ? PEND : `${pct(r.expand?.rate)} (${pct(r.expand?.rateOfCollapsed)}) `} |`,
    `| blind-fetch bytes | ${pend(r) ? PEND : `${n(r.blindFetchBytes)} `} |`,
    `| context index bytes | ${pend(r) ? PEND : `${n(r.components?.bytes?.contextIndex?.total ?? r.components?.bytes?.contextIndex)} `} |`,
    `| cost (est.) | ${pend(r) ? PEND : `${r.costUsd == null ? '—' : '$' + r.costUsd.toFixed(3)} `} |`,
    `| gates: committed / checks / closeout / ticked | ${yn(s.committed)} / ${s.checks ? `${s.checks.passed}/${s.checks.total}` : '—'} / ${yn(s.closeout)} / ${yn(s.ticked)} |`,
    `| success | ${yn(s.success)} |`,
    `| rubric (${rub?.family ?? '—'}, ${rub?.judge ?? '—'}) | ${rub ? rub.score.toFixed(2) : '—'} — ${items} |`,
    `| load (1/5/15) start → end | ${r.uptimeStart ?? '—'} → ${r.uptimeEnd ?? '—'} (waited ${n(r.waitedSeconds)} s) |`,
    `| transcript | ${r.transcript ?? '—'} |`,
    '',
    '## Observations',
    '',
    ...observations(r).map((x) => `- ${x}`),
    '',
  ].join('\n');
}

function writeContent(body) {
  const p = join(tmp, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ kind: 'doc', body, format: 'markdown' }));
  return '@' + p;
}

// existing children by title (covers a lost state file)
const existing = {};
if (!DRY) {
  let cursor;
  do {
    const j = json(tm8('entity', 'query', '--kind', 'doc', '--subtree', SUMMARY, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])));
    for (const it of j.page?.items ?? j.items ?? []) if (it.id !== SUMMARY) existing[it.title] = it.id;
    cursor = j.page?.nextCursor ?? j.nextCursor ?? null;
  } while (cursor);
}

// a lane doc whose rendered body changed (a remeasured row, a coordinator note) is updated in place
let created = 0, reused = 0, updated = 0;
for (const r of rows) {
  const body = laneBody(r);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  if (!state[r._key] && existing[r._title]) { state[r._key] = { docId: existing[r._title], title: r._title }; save(); }
  if (state[r._key]) {
    r._doc = state[r._key].docId;
    if (state[r._key].hash === hash) { reused++; continue; }
    if (DRY) { console.log('would update', r._doc, r._title); continue; }
    const cur = json(tm8('entity', 'context', r._doc));
    tm8('entity', 'update', r._doc, '--expect-version', String(cur.version), '--content', writeContent(body));
    state[r._key].hash = hash; save(); updated++;
    console.log('updated', r._doc, r._title);
    continue;
  }
  if (DRY) { console.log('would create', r._title); continue; }
  const out = json(tm8('entity', 'create', 'doc', r._title, '--parent', SUMMARY, '--attach-to', TASK, '--content', writeContent(body)));
  const id = out.id ?? out.entity?.id ?? out.data?.id ?? out.data?.entity?.id;
  if (!id) throw new Error(`no id from create for ${r._title}: ${JSON.stringify(out).slice(0, 400)}`);
  r._doc = id; state[r._key] = { docId: id, title: r._title, hash }; save(); created++;
  console.log('created', id, r._title);
}

// summary table (full rewrite)
const measured = rows.filter((r) => !r.excluded);
const lines = [
  '# Arm index-derived — lane summary (slice c2, node 4622)',
  '',
  `Status: ${flags.includes('--final') ? 'DONE' : 'RUNNING'} — ${rows.length} rows (${measured.length} measured, ${rows.length - measured.length} excluded) of 34 planned (40 minus the 6 rep-2 replica lanes dropped under D9). Results: ${files.map((f) => `tools/rigs/context-eval/results/${f.path.split('/').pop()}`).join(' + ')} (branch ctx-eval/results-c2). Coordinator task: see attachment. Each lane is a child doc of this doc. Updated ${new Date().toISOString()}.`,
  '',
  '| lane | task | model | first-request tokens | total tokens | requests | entry misses | header misses | expand | blind-fetch B | start failure | success | doc |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r._title.replace(/^.* · lane /, '')} | ${r.taskKey} | ${r.model} | ${pend(r) ? `${PEND} | | | | | | |` : `${n(r.firstRequestTokens)} | ${n(total(r.usage))} | ${n(r.requests)} | ${n(r.miss?.entry?.count)} | ${n(r.miss?.header?.count)} | ${pct(r.expand?.rate)} | ${n(r.blindFetchBytes)} |`} ${yn(startFailure(r))} | ${r.excluded ? `excluded: ${r.excluded.reason}` : `${yn(r.success?.success)} (rubric ${r.rubric ? r.rubric.score.toFixed(2) : '—'})`} | ${r._doc ?? '—'} |`),
  '',
];
const extra = join(HERE, 'summary-notes.md');
if (existsSync(extra)) lines.push('## Coordinator notes', '', readFileSync(extra, 'utf8').trim(), '');
const body = lines.join('\n');
if (DRY) { console.log(body); process.exit(0); }
const ctx = json(tm8('entity', 'context', SUMMARY));
tm8('entity', 'update', SUMMARY, '--expect-version', String(ctx.version), '--content', writeContent(body));
console.log(`summary updated (was v${ctx.version}); lane docs created ${created}, updated ${updated}, unchanged ${reused}, rows ${rows.length}`);
