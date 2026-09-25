// c2 coordinator: count messages on each lane's task copy authored by a NON-agent (the node owner).
// Any owner-authored message on a task copy is a lane using the owner token (the runner's injection targets the session).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const T8 = '/private/tmp/ctxeval/node2/t8';
const json = (s) => JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
let total = 0, unexpected = 0;
for (const f of process.argv.slice(2)) for (const l of readFileSync(f, 'utf8').trim().split('\n')) {
  const r = JSON.parse(l); if (!r.taskId) continue;
  let cursor, owner = [];
  do {
    const j = json(execFileSync(T8, ['message', 'list', '--for', r.taskId, '--limit', '100', '--format', 'json', ...(cursor ? ['--cursor', cursor] : [])], { encoding: 'utf8' }));
    for (const m of j.items ?? j.page?.items ?? []) if (m.state?.author && !m.state.author.isAgent) owner.push(m.title?.slice(0, 70));
    cursor = j.nextCursor ?? j.page?.nextCursor ?? null;
  } while (cursor);
  const expected = 0; // the multiturn injection goes to the lane SESSION, not the task copy
  total += owner.length; if (owner.length !== expected) unexpected++;
  if (owner.length) console.log(`${r.model}/${r.taskKey}#${r.rep} ${r.sessionId.slice(0, 13)} owner msgs ${owner.length} (expected ${expected})${owner.length !== expected ? ' <-- UNEXPECTED' : ''}: ${owner.join(' | ')}`);
}
console.log(`owner-authored messages on lane task copies: ${total}; rows with an unexpected count: ${unexpected}`);
