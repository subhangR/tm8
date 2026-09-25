import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const notes = JSON.parse(readFileSync('/private/tmp/ctxeval/node1/notes.json', 'utf8'));
const [file, maxText = '350'] = process.argv.slice(2);
for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
  const r = JSON.parse(l);
  if (notes[r.sessionId]) continue;
  const last = r.transcript && existsSync(r.transcript) ? execFileSync('node', ['/private/tmp/ctxeval/node1/last-text.mjs', r.transcript, '1', maxText], { encoding: 'utf8' }).replace(/\s+/g, ' ') : '(no transcript)';
  console.log(`## ${r.sessionId} ${r.model} ${r.taskKey}#${r.rep} ended=${r.ended} req=${r.requests} wall=${r.wallSeconds} commits=${r.success?.commits} checks=${r.success?.checks?.passed}/${r.success?.checks?.total} close=${r.success?.closeout} tick=${r.success?.ticked} needle=${r.needleState}/${r.needleOpened} entryMiss=${r.miss?.entry?.count} hdr=${r.miss?.header?.count} expand=${r.expand?.opened}/${r.expand?.entries} blind=${r.blindFetchBytes} $${r.costUsd?.toFixed(3)}\n${last}`);
}
