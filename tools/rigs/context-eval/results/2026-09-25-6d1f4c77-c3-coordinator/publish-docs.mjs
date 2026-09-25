#!/usr/bin/env node
// c3 coordinator's lane-doc publisher (NOT part of the rig; reads rows only).
//   node publish-docs.mjs --arm-doc <id> --task <id> [--notes notes.json] [--status "<text>"] <file.jsonl>[:<label-suffix>] ...
// One doc per row on the AMBIENT tm8 (7778), child of --arm-doc and attached to --task,
// titled "<arm> · <task> · <model> · lane <rep><suffix>". Idempotent by title: an
// existing lane doc is skipped (not rewritten). Then the arm doc's table is rebuilt
// from every row given, under a version guard.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const armDoc = opt('arm-doc'); const task = opt('task'); const notesPath = opt('notes'); const status = opt('status');
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const dryRun = flag('--dry-run'); const refresh = flag('--refresh'); // --refresh: re-render existing lane docs whose body changed
if (!armDoc || !task || !argv.length) { console.error('usage: publish-docs.mjs --arm-doc <id> --task <id> [--notes f] [--status s] <file.jsonl>[:suffix]...'); process.exit(2); }
const notes = notesPath ? JSON.parse(readFileSync(notesPath, 'utf8')) : {};
const tmp = mkdtempSync(join(tmpdir(), 'c3pub-'));

const tm8 = (args) => {
  const out = execFileSync('tm8', [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
};

const rows = [];
for (const spec of argv) {
  const [file, suffix = ''] = spec.split(':');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows.push({ row: JSON.parse(line), suffix, file });
  }
}

const n = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const yn = (v) => (v == null ? '—' : v ? 'yes' : 'no');
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const totalTokens = (u) => (u ? (u.input ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0) : null);
const title = ({ row, suffix }) => `${row.arm} · ${row.taskKey} · ${row.model} · lane ${row.rep}${suffix}`;
const startFailure = (r) => (r.excluded?.by === 'auto' && !r.requests ? 'yes' : 'no');

function body(entry) {
  const r = entry.row; const s = r.success ?? {}; const ck = s.checks ?? {};
  const rub = r.rubric ? `${r.rubric.score} (${(r.rubric.items ?? []).map((i) => `${i.name} ${i.pass ? '✓' : '✗'}`).join(', ')}; judge ${r.rubric.judge})` : '—';
  const obs = [...(notes[r.sessionId] ?? [])];
  if (!obs.length) obs.push('(no coordinator note yet)');
  const lines = [
    `# ${title(entry)}`, '',
    r.excluded ? `**EXCLUDED** (${r.excluded.by}): ${r.excluded.reason}\n` : '',
    r.measureError ? `**NOT MEASURED** (measureError): ${r.measureError}\n` : '',
    '| field | value |', '|---|---|',
    `| arm | ${r.arm} (surface ${r.surface ?? '—'}, context index ${r.contextIndex ?? '—'}) |`,
    `| subject model | ${r.model} (${r.modelId ?? '—'}) |`,
    `| task key / family / rep | ${r.taskKey} / ${r.family} / ${r.rep} |`,
    `| first-request tokens | ${n(r.firstRequestTokens)} |`,
    `| total tokens (input-side + output) | ${n(totalTokens(r.usage))} (input ${n(r.usage?.input)}, cache-create ${n(r.usage?.cacheCreation)}, cache-read ${n(r.usage?.cacheRead)}, output ${n(r.usage?.output)}) |`,
    `| cost (USD) | ${r.costUsd == null ? '—' : r.costUsd.toFixed(3)} |`,
    `| requests / tool calls | ${n(r.requests)} / ${n(r.toolCalls)} |`,
    `| entry misses / header misses | ${n(r.miss?.entry?.count)} / ${n(r.miss?.header?.count)} (header bytes ${n(r.miss?.header?.bytes)}) |`,
    `| expand rate (all / of collapsed) | ${pct(r.expand?.rate)} / ${pct(r.expand?.rateOfCollapsed)} (${n(r.expand?.opened)} opened of ${n(r.expand?.entries)}) |`,
    `| blind-fetch bytes | ${n(r.blindFetchBytes)} |`,
    `| needle state / opened / missed | ${n(r.needleState)} / ${yn(r.needleOpened)} / ${yn(r.needleMissed)} |`,
    `| start failure | ${startFailure(r)} |`,
    `| ended / wall | ${n(r.ended)} / ${n(r.wallSeconds)} s |`,
    `| committed | ${yn(s.committed)} (${n(s.commits)} commits) |`,
    `| checks | ${n(ck.passed)}/${n(ck.total)}${ck.failures?.length ? ` — failures: ${JSON.stringify(ck.failures).slice(0, 300)}` : ''} |`,
    `| closeout / ticked | ${yn(s.closeout)} / ${yn(s.ticked)} |`,
    `| success (all gates) | ${yn(s.success)} |`,
    `| rubric | ${rub} |`,
    r.turn ? `| multiturn | ${JSON.stringify(r.turn).slice(0, 400)} |` : '',
    `| load start → end | ${r.uptimeStart ?? '—'} → ${r.uptimeEnd ?? '—'} (waited ${n(r.waitedSeconds)} s) |`,
    `| session / task (node ${r.node?.port}) | ${r.sessionId ?? '—'} / ${r.taskId ?? '—'} |`,
    `| transcript | \`${r.transcript ?? '—'}\` |`,
    `| results file | \`${entry.file}\` |`,
    '', '## Observations', '', ...obs.map((o) => `- ${o}`), '',
  ];
  return lines.filter((l) => l !== '').join('\n').replace('\n## Observations', '\n\n## Observations\n');
}

// existing children by title (paged)
const existing = new Map();
let cursor;
do {
  const page = tm8(['entity', 'children', armDoc, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]);
  for (const it of page.items ?? []) existing.set(it.title, it.id);
  cursor = page.nextCursor ?? page.page?.nextCursor ?? null;
} while (cursor);

for (const e of rows) {
  const t = title(e);
  const f = join(tmp, `${e.row.sessionId ?? Math.random()}.json`);
  writeFileSync(f, JSON.stringify({ kind: 'doc', body: body(e), format: 'markdown' }));
  if (existing.has(t)) {
    e.docId = existing.get(t);
    if (!refresh) continue;
    const cur = tm8(['entity', 'get', e.docId, '--full']);
    if (cur.content?.body === body(e)) continue;
    if (dryRun) { console.log(`would refresh: ${t}`); continue; }
    tm8(['entity', 'update', e.docId, '--expect-version', String(cur.version), '--content', `@${f}`]);
    console.log(`refreshed ${e.docId} ${t} (v${cur.version})`);
    continue;
  }
  if (dryRun) { console.log(`would create: ${t}`); continue; }
  const made = tm8(['entity', 'create', 'doc', t, '--parent', armDoc, '--attach-to', task, '--content', `@${f}`]);
  e.docId = made.id ?? made.entity?.id ?? made.data?.id;
  console.log(`created ${e.docId} ${t}`);
}

// rebuild the arm doc's table (keep everything above the table)
const doc = tm8(['entity', 'get', armDoc, '--full']);
const old = doc.content?.body ?? '';
const head = old.slice(0, old.indexOf('| lane |')).replace(/^Status: .*$/m, (m) => (status ? `Status: ${status}` : m));
const hdr = '| lane | task | model | first-request tokens | total tokens | requests | entry misses | header misses | expand | blind-fetch B | start failure | success | doc |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
const tableRows = rows.map((e) => {
  const r = e.row;
  const succ = r.excluded ? `excluded: ${r.excluded.reason.slice(0, 60)}` : `${yn(r.success?.success)} (rubric ${r.rubric?.score ?? '—'})${r.measureError ? ' · NOT MEASURED' : ''}`;
  return `| ${r.rep}${e.suffix} | ${r.taskKey} | ${r.model} | ${n(r.firstRequestTokens)} | ${n(totalTokens(r.usage))} | ${n(r.requests)} | ${n(r.miss?.entry?.count)} | ${n(r.miss?.header?.count)} | ${pct(r.expand?.rate)} | ${n(r.blindFetchBytes)} | ${startFailure(r)} | ${succ} | ${e.docId ?? '—'} |`;
});
const newBody = `${head}${hdr}\n${tableRows.join('\n')}\n`;
if (dryRun) { console.log(newBody); process.exit(0); }
if (newBody !== old) {
  const f = join(tmp, 'arm.json');
  writeFileSync(f, JSON.stringify({ kind: 'doc', body: newBody, format: 'markdown' }));
  tm8(['entity', 'update', armDoc, '--expect-version', String(doc.version), '--content', `@${f}`]);
  console.log(`arm doc ${armDoc} updated from v${doc.version} (${rows.length} rows)`);
}
