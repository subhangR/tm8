#!/usr/bin/env node
// Publish lane rows as DOCS on the MAIN node (the ambient `tm8`, 7778): one
// doc per row, a child of its arm's summary doc and attached to the arm's
// coordinator task; the arm doc's lane table is regenerated from the results
// file; optionally a per-arm block (and the consolidated report) in the
// program root doc.
//
//   node publish-docs.mjs results/<run>.jsonl[=<label>] [more.jsonl[=<label>] ...] --arm-doc <doc-id> --task <coordinator-task-id>
//     [--label <text>] [--root-doc <doc-id>] [--report <report.md>] [--observations <file.json>] [--dry-run]
//
// Several result files make ONE arm table (pilot + full slice). A lane title
// keys on rep within a file, so a pilot's "lane 1" and the full run's "lane 1"
// would collide: give each file a label (`pilot.jsonl=pilot`, or --label for
// every file without one) and the title carries it: "… · lane 1 · pilot".
//
// Idempotent by TITLE: a lane doc titled "<arm> · <taskKey> · <model> · lane <rep>"
// is updated in place (under --expect-version) when it already exists among the
// arm doc's children, else created. The arm table is rewritten wholesale from
// the rows, so re-publishing after more lanes is safe. Observations are per
// lane text the coordinator writes: a JSON object keyed by sessionId or by
// "<model>/<taskKey>#<rep>"; a lane without one gets a placeholder line.
//
// Reads only the results file; the ONLY writes are entity create/update on the
// ambient node. Nothing here touches a dev node.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { classify, entryMissed, headerRead, stats, fmt, rubricScore, indexOff } from './report.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const tm8 = (...args) => JSON.parse(execFileSync('tm8', [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
const idOf = (r) => r.id ?? r.entity?.id ?? r.data?.id;
const docContent = (body) => JSON.stringify({ kind: 'doc', body, format: 'markdown' });

const n = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(d)).toLocaleString('en-US') : '—');
const yes = (b) => (b ? 'yes' : 'no');
const inputTokens = (r) => (r.usage ? r.usage.input + r.usage.cacheCreation + r.usage.cacheRead : null);
const startFailure = (r) => (r.excluded ? `yes — ${r.excluded.reason}` : 'no');

export function laneTitle(r, dup = false) {
  return `${r.arm} · ${r.taskKey} · ${r.model} · lane ${r.rep}${r.label ? ` · ${r.label}` : ''}${dup ? ` · ${String(r.sessionId).slice(0, 8)}` : ''}`;
}

export function laneBody(r, observation) {
  const s = r.success ?? {};
  // The rubric score the report uses (aliasCheck is n/a on an index-off arm).
  const rub = r.rubric ? { ...r.rubric, score: rubricScore(r), items: r.rubric.items.map((i) => (i.name === 'aliasCheck' && indexOff(r.arm) ? { ...i, na: 'index off' } : i)) } : null;
  const gates = [`committed ${yes(s.committed)}`, `hidden checks ${s.checks ? `${s.checks.passed}/${s.checks.total}` : '—'}`, `closeout ${yes(s.closeout)}`, `criteria ticked ${yes(s.ticked)}`, `success ${yes(s.success)}`].join(' · ');
  return [
    `# ${laneTitle(r)}`,
    '',
    `| field | value |`, `|---|---|`,
    `| arm | ${r.arm} (node ${r.node?.port ?? '—'}, ${JSON.stringify(r.node?.env ?? {})}) |`,
    `| model | ${r.model} (${r.modelId ?? '—'}) |`,
    `| task | ${r.family} / ${r.taskKey} rep ${r.rep} · copy ${r.taskId ?? '—'} of template ${r.templateTaskId ?? '—'} |`,
    `| session | ${r.sessionId ?? '—'} · build ${String(r.buildSha ?? '').slice(0, 8)} · fixture ${r.fixtureVersion?.contentHash ?? '—'} |`,
    `| ended | ${r.ended ?? '—'} · wall ${n(r.wallSeconds)} s · load at start ${n(r.loadAtStart, 1)} (waited ${n(r.waitedSeconds)} s) |`,
    `| first-request tokens | ${n(r.firstRequestTokens)} |`,
    `| total input-side tokens | ${n(inputTokens(r))} (in ${n(r.usage?.input)} · cache write ${n(r.usage?.cacheCreation)} · cache read ${n(r.usage?.cacheRead)}) · output ${n(r.usage?.output)} |`,
    `| requests / tool calls | ${n(r.requests)} / ${n(r.toolCalls)} |`,
    `| context by component (bytes) | tm8 kernel ${n(r.components?.bytes?.tm8Kernel)} · assignment ${n(r.components?.bytes?.assignmentSnapshot)} · index ${n(r.components?.bytes?.contextIndex)} · memories expanded ${n(r.components?.bytes?.memoriesExpanded)} · harness ${n(r.components?.harnessTotal)} chars · remainder (est.) ${n(r.components?.bytes?.remainderEstimated)} |`,
    `| misses (D2) | entry-level ${n(r.miss?.entry?.count)} · header-level ${n(r.miss?.header?.count)} · launch entry-missed ${yes(entryMissed(r))} |`,
    `| expand rate | ${r.expand?.rate == null ? '—' : `${(r.expand.rate * 100).toFixed(0)}% (${r.expand.opened}/${r.expand.entries})`} |`,
    `| blind-fetch bytes | ${n(r.blindFetchBytes)} |`,
    `| needle | state ${r.needleState ?? '—'} · opened ${r.needleOpened == null ? '—' : yes(r.needleOpened)} |`,
    `| start failure | ${startFailure(r)} |`,
    `| success gates | ${gates} |`,
    `| rubric | ${rub ? `${rub.score == null ? '—' : rub.score.toFixed(2)} (${rub.items.map((i) => `${i.name} ${i.na ? `n/a (${i.na})` : i.pass ? '✓' : '✗'}`).join(', ')})` : '—'} |`,
    ...(r.turn ? [`| multi-turn | injected ${r.turn.injectedAt ?? '—'} · ran after inject ${yes(r.turn.ranAfterInject)} · resumed ${yes(r.turn.resumed)} (${r.turn.afterResume ?? '—'}) |`] : []),
    `| est. $ | ${n(r.costUsd, 3)} (pricing.mjs, VERIFY) |`,
    `| transcript | \`${r.transcript ?? '—'}\` |`,
    `| manifest | \`${r.node?.port ? `<datadir>/manifests/${r.sessionId}.json` : '—'}\` |`,
    ...(r.measureError ? [`| measure error | ${r.measureError} |`] : []),
    '',
    '## Observations',
    '',
    observation ?? '_(none yet — the coordinator adds per-lane observations via `--observations <file.json>`, keyed by sessionId or `<model>/<taskKey>#<rep>`)_',
    '',
  ].join('\n');
}

export function armTable(rows, docIds) {
  const head = '| lane | run | task | model | first-request tokens | total tokens | requests | entry misses | header misses | expand | blind-fetch B | start failure | success | doc |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const sorted = [...rows].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '') || a.taskKey.localeCompare(b.taskKey) || a.model.localeCompare(b.model) || a.rep - b.rep);
  const lines = sorted.map((r) => `| ${r.rep} | ${r.label ?? '—'} | ${r.taskKey} | ${r.model} | ${n(r.firstRequestTokens)} | ${n(inputTokens(r))} | ${n(r.requests)} | ${n(r.miss?.entry?.count)} | ${n(r.miss?.header?.count)} | ${r.expand?.rate == null ? '—' : `${(r.expand.rate * 100).toFixed(0)}%`} | ${n(r.blindFetchBytes)} | ${r.excluded ? 'yes' : 'no'} | ${r.success?.success ? 'yes' : r.success ? 'no' : '—'} | ${docIds.get(r.sessionId) ?? '—'} |`);
  return [head, sep, ...lines].join('\n');
}

/** Replace the first markdown table in `body` (header line starting with "| lane |") with `table`; append one if absent. */
export function replaceArmTable(body, table) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\|\s*lane\s*\|/.test(l));
  if (start < 0) return `${body.trimEnd()}\n\n${table}\n`;
  let end = start;
  while (end < lines.length && /^\|/.test(lines[end])) end++;
  // drop a trailing "(rows appended ...)" placeholder line right after the table
  if (end < lines.length && /^\(rows appended/i.test(lines[end])) end++;
  return [...lines.slice(0, start), ...table.split('\n'), ...lines.slice(end)].join('\n');
}

/** Replace (or append) the `## <heading>` section of a body. */
export function replaceSection(body, heading, text) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return `${body.trimEnd()}\n\n## ${heading}\n\n${text}\n`;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return [...lines.slice(0, start), `## ${heading}`, '', text, '', ...lines.slice(end)].join('\n');
}

export function armSummary(rows, armDocId) {
  const { measured, excluded } = classify(rows);
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const out = [`arm doc ${armDocId} · lanes ${rows.length} · measured ${measured.length} · set aside ${excluded.length}`, '', '| model | launches | entry-level missed | success | first-request tokens | est. $ |', '|---|---|---|---|---|---|'];
  for (const m of models) {
    const rs = measured.filter((r) => r.model === m);
    const gated = rs.filter((r) => r.family !== 'replica');
    out.push(`| ${m} | ${rs.length} | ${gated.filter(entryMissed).length}/${gated.length} | ${rs.filter((r) => r.success?.success).length}/${rs.length} | ${fmt(stats(rs.map((r) => r.firstRequestTokens)))} | ${fmt(stats(rs.map((r) => r.costUsd)), 3)} |`);
  }
  void headerRead;
  return out.join('\n');
}

// ---- main ----
function main() {
const dry = process.argv.includes('--dry-run');
const argv = process.argv.slice(2);
const inputs = argv.filter((a, i) => !a.startsWith('--') && /\.jsonl(=.*)?$/.test(a) && !(i > 0 && argv[i - 1].startsWith('--')));
const armDoc = arg('arm-doc');
const task = arg('task');
if (!inputs.length || !armDoc || !task) throw new Error('usage: node publish-docs.mjs <results.jsonl[=label]> [...] --arm-doc <id> --task <id> [--label <text>] [--root-doc <id>] [--report <md>] [--observations <json>] [--dry-run]');
const rows = [];
for (const input of inputs) {
  const [path, fileLabel] = input.split('=');
  const label = fileLabel || arg('label') || (inputs.length > 1 ? path.split('/').pop().replace(/\.jsonl$/, '') : undefined);
  for (const l of readFileSync(path, 'utf8').split('\n').filter(Boolean)) rows.push({ ...JSON.parse(l), ...(label ? { label } : {}) });
}
const file = inputs.join(', ');
if (!rows.length) throw new Error(`${file}: no rows`);
const arms = [...new Set(rows.map((r) => r.arm))];
if (arms.length !== 1) throw new Error(`${file} holds ${arms.length} arms (${arms.join(', ')}); publish one arm's file per arm doc`);
const arm = arms[0];
const observations = arg('observations') && existsSync(arg('observations')) ? JSON.parse(readFileSync(arg('observations'), 'utf8')) : {};
const obsFor = (r) => observations[r.sessionId] ?? observations[`${r.model}/${r.taskKey}#${r.rep}`] ?? null;
const children = new Map();
let cursor = null;
do {
  const page = tm8('entity', 'children', armDoc, '--limit', '200', ...(cursor ? ['--cursor', cursor] : []));
  for (const c of page.items ?? page.page?.items ?? []) children.set(c.title, { id: c.id, version: c.version });
  cursor = page.nextCursor ?? page.page?.nextCursor ?? null;
} while (cursor);

const seen = new Set();
const docIds = new Map();
for (const r of rows) {
  const key = `${r.label ?? ''}|${r.model}/${r.taskKey}#${r.rep}`;
  const title = laneTitle(r, seen.has(key));
  seen.add(key);
  const body = laneBody(r, obsFor(r));
  const existing = children.get(title);
  if (dry) {
    console.error(`${existing ? 'update' : 'create'} "${title}" (${body.length} chars)`);
    docIds.set(r.sessionId, existing?.id ?? '(new)');
    continue;
  }
  if (existing) {
    const cur = tm8('entity', 'get', existing.id);
    tm8('entity', 'update', existing.id, '--expect-version', String(cur.version), '--content', docContent(body));
    docIds.set(r.sessionId, existing.id);
    console.error(`updated ${existing.id} "${title}"`);
  } else {
    const id = idOf(tm8('entity', 'create', 'doc', title, '--parent', armDoc, '--attach-to', task, '--content', docContent(body)));
    docIds.set(r.sessionId, id);
    children.set(title, { id, version: 1 });
    console.error(`created ${id} "${title}"`);
  }
}

const armGot = tm8('entity', 'get', armDoc, '--full');
const armBody = replaceArmTable(armGot.content?.body ?? '', armTable(rows, docIds));
if (dry) console.error(`arm doc ${armDoc} v${armGot.version}: table with ${rows.length} rows\n${armTable(rows, docIds)}`);
else {
  tm8('entity', 'update', armDoc, '--expect-version', String(armGot.version), '--content', docContent(armBody));
  console.error(`arm doc ${armDoc} updated (v${armGot.version} → table of ${rows.length} lanes)`);
}

if (arg('root-doc')) {
  const root = tm8('entity', 'get', arg('root-doc'), '--full');
  let body = replaceSection(root.content?.body ?? '', `Arm ${arm}`, armSummary(rows, armDoc));
  if (arg('report')) body = replaceSection(body, 'Consolidated report', readFileSync(arg('report'), 'utf8').replace(/^# .*\n/, '').trim());
  if (dry) console.error(`root doc ${arg('root-doc')} v${root.version}: section "Arm ${arm}"${arg('report') ? ' + "Consolidated report"' : ''}`);
  else {
    tm8('entity', 'update', arg('root-doc'), '--expect-version', String(root.version), '--content', docContent(body));
    console.error(`root doc ${arg('root-doc')} updated`);
  }
}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
