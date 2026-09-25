#!/usr/bin/env node
// What a shorter DERIVED header cut would save in the index, offline.
//
//   node derived-cut.mjs --results results.jsonl --data-dir <dev node data dir> \
//     --build <tree with packages/prompt/dist> [--arm <label>] [--cut 200]
//
// Re-serializes each launch's recorded `manifest.contextIndex` entries with
// the real `contextEntryBytes`, clipping DERIVED summary / whenToUse to --cut
// chars. Authored and native headers are left alone. Entries whose header the
// 8 KiB cap already dropped show no saving here; that effect (more headers
// surviving the cap) needs a fitContextIndex re-run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const cutAt = Number(arg('cut', 200));
const arm = arg('arm');
const { contextEntryBytes } = await import(pathToFileURL(join(arg('build'), 'packages/prompt/dist/context-index.js')).href);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

const rows = readFileSync(arg('results'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => (!arm || r.arm === arm) && r.contextIndex === 'on');
for (const r of rows) {
  const m = JSON.parse(readFileSync(join(arg('data-dir'), 'manifests', `${r.sessionId}.json`), 'utf8'));
  for (const g of m.contextIndex?.groups ?? []) {
    let now = 0;
    let cut = 0;
    let derived = 0;
    for (const e of g.entries) {
      now += contextEntryBytes(e);
      if (e.source === 'derived' && e.header) {
        derived++;
        cut += contextEntryBytes({ ...e, header: { ...e.header, summary: clip(e.header.summary, cutAt), whenToUse: clip(e.header.whenToUse, cutAt) } });
      } else {
        cut += contextEntryBytes(e);
      }
    }
    const n = g.entries.length;
    if (n) console.log(`${r.taskKey}\t${g.name}\tentries=${n}\tderived=${derived}\tnow=${now}\tat${cutAt}=${cut}\tsaved=${now - cut} (${Math.round((100 * (now - cut)) / now)}%)\tper-entry ${Math.round(now / n)} -> ${Math.round(cut / n)}`);
  }
}
