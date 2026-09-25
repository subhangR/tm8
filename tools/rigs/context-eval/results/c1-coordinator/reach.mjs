// flag tool calls that reach outside the lane's worktree: absolute paths not under the worktree
// (ignoring the lane's tm8 binary and common system paths), gh usage, git fetch/pull/push/remote
import { readFileSync, existsSync } from 'node:fs';
const files = process.argv.slice(2);
const OK = [/^\/private\/tmp\/ctxeval\/build\/packages\/cli\/dist\/tm8/, /^\/(usr|bin|opt|dev|etc|tmp\/claude|private\/tmp\/claude)/, /^\/Users\/[^/]+\/\.claude\//];
for (const f of files) for (const l of readFileSync(f, 'utf8').trim().split('\n')) {
  const r = JSON.parse(l); if (!r.transcript || !existsSync(r.transcript)) { console.log(`${r.sessionId}\t(no transcript)`); continue; }
  const wt = r.worktree; const hits = new Set();
  for (const t of readFileSync(r.transcript, 'utf8').split('\n')) {
    if (!t.includes('tool_use')) continue; let j; try { j = JSON.parse(t); } catch { continue; }
    for (const c of j.message?.content ?? []) {
      if (c.type !== 'tool_use') continue; const s = JSON.stringify(c.input);
      for (const m of s.matchAll(/(\/(?:private|Users|tmp|var)\/[A-Za-z0-9._\/-]+)/g)) {
        const p = m[1]; if (wt && p.startsWith(wt)) continue; if (OK.some((re) => re.test(p))) continue; hits.add(`path ${p.slice(0, 90)}`);
      }
      if (/(^|[\s;&|"(])gh\s+(pr|api|repo|issue|run)/.test(s)) hits.add('gh');
      if (/git\s+(-C\s+\S+\s+)?(fetch|pull|push|remote\s+add)/.test(s)) hits.add('git remote op');
    }
  }
  console.log(`${r.sessionId}\t${r.model}\t${r.taskKey}#${r.rep}\t${hits.size ? [...hits].slice(0, 6).join(' | ') : '-'}`);
}
