// D13 instrument: per model x arm-group, did the lane open its OWN task copy, and did it tick.
// usage: node opened.mjs <rows.jsonl>...   (prints a table; --rows prints per-row)
import fs from 'node:fs';
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const perRow = process.argv.includes('--rows');
const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), file: f })));
function commands(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return null;
  const out = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line) continue; let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j?.message?.content; if (!Array.isArray(content)) continue;
    for (const c of content) if (c?.type === 'tool_use') out.push(JSON.stringify(c.input ?? {}));
  }
  return out;
}
const cells = new Map(); let missing = 0, excluded = 0;
for (const r of rows) {
  if (r.excluded || r.contaminated) { excluded++; continue; }
  if (process.env.FAMILIES && !process.env.FAMILIES.split(",").includes(r.family)) continue;
  const cmds = commands(r.transcript);
  if (cmds === null) { missing++; continue; }
  const id = r.taskId;
  const opened = cmds.some((c) => c.includes(id) && /entity (context|get)|task (get|show|view)/.test(c));
  const ctx = cmds.some((c) => c.includes(id) && /entity context/.test(c));
  const ticked = !!r.success?.ticked;
  const group = process.env.GROUP === 'arm' ? r.arm : (r.contextIndex === 'on' || (r.arm ?? '').startsWith('index') ? 'index ON' : 'index OFF');
  const key = `${r.model}\t${group}`;
  const c = cells.get(key) ?? { n: 0, opened: 0, ctx: 0, ticked: 0, tickedNotOpened: 0 };
  c.n++; if (opened) c.opened++; if (ctx) c.ctx++; if (ticked) c.ticked++; if (ticked && !opened) c.tickedNotOpened++;
  cells.set(key, c);
  if (perRow) console.log([r.slice, r.model, r.taskKey, r.rep, opened ? 'opened' : '-', ticked ? 'ticked' : '-', r.sessionId].join('\t'));
}
console.log('| model | arm | n | opened own task (any read) | opened via entity context | ticked | ticked without opening |');
console.log('|---|---|---|---|---|---|---|');
for (const [k, c] of [...cells].sort()) { const [m, g] = k.split('\t'); console.log(`| ${m} | ${g} | ${c.n} | ${c.opened}/${c.n} | ${c.ctx}/${c.n} | ${c.ticked}/${c.n} | ${c.tickedNotOpened} |`); }
console.log(`rows ${rows.length}, set aside ${excluded}, transcript missing ${missing}`);
