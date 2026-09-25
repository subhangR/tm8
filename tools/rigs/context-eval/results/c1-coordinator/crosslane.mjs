// cross-lane scan: tool calls (main + subagents) naming ANOTHER lane's worktree dir, session id or task-copy id, or
// a node-wide search (cd <datadir> / find over worktrees)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const lanes = rows.map((r) => ({ s: r.sessionId, t: r.taskId, w: r.worktree && r.worktree.split('/').pop() }));
for (const r of rows) {
  if (!r.transcript || !existsSync(r.transcript)) continue;
  const files = [r.transcript]; const sd = r.transcript.replace(/\.jsonl$/, '') + '/subagents';
  if (existsSync(sd)) for (const x of readdirSync(sd)) if (x.endsWith('.jsonl')) files.push(join(sd, x));
  const me = r.worktree && r.worktree.split('/').pop(); const hits = new Set();
  for (const f of files) for (const t of readFileSync(f, 'utf8').split('\n')) {
    if (!t.includes('tool_use')) continue; let j; try { j = JSON.parse(t); } catch { continue; }
    for (const c of j.message?.content ?? []) {
      if (c.type !== 'tool_use') continue; const s = JSON.stringify(c.input);
      for (const o of lanes) {
        if (o.s === r.sessionId) continue;
        if (o.w && o.w !== me && s.includes(o.w)) hits.add(`worktree-of ${o.s.slice(0, 13)}`);
        if (s.includes(o.s)) hits.add(`session ${o.s.slice(0, 13)}`);
        if (o.t && s.includes(o.t)) hits.add(`task-copy-of ${o.s.slice(0, 13)}`);
      }
      if (/cd \/private\/tmp\/ctxeval\/node1 *&&|find \/private\/tmp\/ctxeval|ls[^"]*\/private\/tmp\/ctxeval\/node1\/worktrees\/?["\s]/.test(s)) hits.add('node-wide search');
    }
  }
  if (hits.size) console.log(`${r.sessionId}\t${r.model}\t${r.taskKey}#${r.rep}\t${r._f ?? ''}${[...hits].join(' | ')}`);
}
console.error(`scanned ${rows.length} rows`);
