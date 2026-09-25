#!/usr/bin/env node
// Drafts observation lines for rows that have no hand-written note in notes.json.
//   node auto-notes.mjs notes.json <file.jsonl>...   (rewrites notes.json; hand notes win)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
// tm8 commands a lane ran that could tick an acceptance item
const tickAttempts = (t) => {
  if (!t || !existsSync(t)) return null;
  let n = 0;
  for (const l of readFileSync(t, 'utf8').split('\n')) {
    if (!l.includes('tool_use')) continue;
    try { for (const b of JSON.parse(l).message?.content ?? []) if (b.type === 'tool_use' && /tm8\s+(task|entity)\s+\S*(tick|criteri|accept|complete|update)/i.test(b.input?.command ?? '')) n++; } catch {}
  }
  return n;
};
// D9: tool calls touching paths outside the lane's worktree, or reaching a forge/remote
const escapes = (r) => {
  if (!r.transcript || !existsSync(r.transcript)) return null;
  const outside = new Set(); const risky = new Set();
  const ok = (p) => p.startsWith(r.worktree) || p === r.laneTm8?.bin || (/^\/Users\/[^/]+\/\.claude\//.test(p) && !/\/memory(\/|$)|\/\.claude\/?$|\/projects\/?$/.test(p)) || /^\/(private\/)?tmp\/(claude|tmp\.|node-)/.test(p) || /^\/(usr|bin|opt|dev|System|Library)\//.test(p);
  for (const l of readFileSync(r.transcript, 'utf8').split('\n')) {
    if (!l.includes('tool_use')) continue;
    try { for (const b of JSON.parse(l).message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      const txt = JSON.stringify(b.input ?? {});
      for (const m of txt.match(/\/(?:private\/tmp|tmp|Users)\/[^\s'"\\;|&)]+/g) ?? []) if (!ok(m)) outside.add(m.slice(0, 90));
      const cmd = b.input?.command ?? '';
      for (const m of cmd.match(/\b(gh\s+\S+(\s+\S+)?|git\s+(push|clone)\b|git\s+-C\s+\S+|cd\s+\.\.\S*)/g) ?? []) risky.add(m.slice(0, 60));
      if (/(^|[\s;&|/])(\.\/)?t8\s/.test(cmd) || cmd.includes(`${r.node?.dataDir ?? '/private/tmp/ctxeval/node'}/t8`)) risky.add('OWNER CLI ./t8 (owner token)');
    } } catch {}
  }
  return { outside: [...outside], risky: [...risky] };
};
const subLine = (r) => {
  const d = r.transcript?.replace(/\.jsonl$/, '') + '/subagents';
  if (!r.transcript || !existsSync(d)) return null;
  const n = readdirSync(d).filter((f) => f.endsWith('.jsonl')).length;
  return `SUBAGENT: spawned ${n} subagent(s) (${d}); their requests/tokens are NOT in this row until the rig measures subagents.`;
};
const isoLine = (esc) => (esc.outside.length || esc.risky.length
  ? `ISOLATION (D9): tool calls reached outside the worktree (${esc.outside.length} path(s), ${esc.risky.length} command(s)): ${[...esc.risky.slice(0, 6), ...esc.outside.slice(0, 6)].map((x) => `\`${x}\``).join(', ')}${esc.outside.length + esc.risky.length > 12 ? ' …' : ''}.`
  : 'Isolation (D9): no tool call touched a path outside its worktree; no gh, git -C, git push/clone, cd .. or owner-t8 commands.');
const [notesPath, ...files] = process.argv.slice(2);
const notes = JSON.parse(readFileSync(notesPath, 'utf8'));
const auto = notes._auto ?? {};
const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => ({ ...JSON.parse(l), _file: f })));
const other = (r) => rows.find((x) => x._file === r._file && x.taskKey === r.taskKey && x.rep === r.rep && x.model !== r.model && !x.excluded && x.costUsd != null);
for (const r of rows) {
  if (notes[r.sessionId] && !auto[r.sessionId]) { // hand-written: only (re)place the isolation line
    const esc = escapes(r); const keep = notes[r.sessionId].filter((l) => !/^(ISOLATION|Isolation) \(D9\)/.test(l));
    const keep2 = keep.filter((l) => !l.startsWith('SUBAGENT:'));
    if (esc) keep2.push(isoLine(esc)); if (subLine(r)) keep2.push(subLine(r)); notes[r.sessionId] = keep2; continue;
  }
  const out = [];
  if (r.excluded) out.push(`Set aside (${r.excluded.by}): ${r.excluded.reason}.`);
  else if (r.measureError) out.push(`Not measured yet: ${r.measureError}.`);
  else {
    const failed = (r.rubric?.items ?? []).filter((i) => i.pass === false).map((i) => i.name);
    out.push(`Ended ${r.ended} after ${r.wallSeconds}s; rubric ${r.rubric?.score == null ? '—' : +r.rubric.score.toFixed(2)}${failed.length ? ` (failed: ${failed.join(', ')})` : ' (all gates pass)'}${r.success?.checks?.failures?.length ? `; check failures ${r.success.checks.failures.map((f) => `${f.expr} want ${f.want} got ${f.got}`).join('; ')}` : ''}.`);
    if (r.success && r.success.ticked === false) { const n = tickAttempts(r.transcript); out.push(n === 0 ? 'Did not tick its acceptance item: the transcript has NO tick/criteria/complete command (it closed out by message only), so this is model behaviour, not a failed tick.' : `Did not end ticked despite ${n} tick/criteria/update command(s) in the transcript: check them.`); }
    const needle = r.needleState ? `needle ${r.needleState}, ${r.needleOpened ? 'opened' : 'NOT opened'}${r.needleMissed ? ' (MISSED)' : ''}; ` : '';
    out.push(`${needle}${r.miss?.entry?.count ?? 0} entry / ${r.miss?.header?.count ?? 0} header misses, expanded ${r.expand?.opened ?? 0} of ${r.expand?.entries ?? 0} entries, blind-fetch ${r.blindFetchBytes ?? 0} B${r.memoriesCollapsed ? `, ${r.memoriesCollapsed} memories body-collapsed and ${r.memoryExpands ?? 0} opened` : ''}.`);
    const o = other(r);
    if (o && r.costUsd != null) out.push(`${r.requests} requests, $${r.costUsd.toFixed(2)} vs ${o.model} rep ${o.rep} on the same task: ${o.requests} requests, $${o.costUsd.toFixed(2)}, rubric ${o.rubric?.score}.`);
    else if (r.costUsd != null) out.push(`${r.requests} requests, $${r.costUsd.toFixed(2)}.`);
  }
  const esc = escapes(r);
  if (esc) out.push(isoLine(esc));
  if (subLine(r)) out.push(subLine(r));
  notes[r.sessionId] = out;
  auto[r.sessionId] = true;
}
notes._auto = auto;
writeFileSync(notesPath, JSON.stringify(notes, null, 1) + '\n');
console.log(`${Object.keys(auto).length} auto-drafted notes`);
