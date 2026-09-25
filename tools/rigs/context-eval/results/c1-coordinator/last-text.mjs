// print the last N assistant text blocks of a Claude transcript (jsonl)
import { readFileSync } from 'node:fs';
const [file, n = '1', max = '900'] = process.argv.slice(2);
const texts = [];
for (const l of readFileSync(file, 'utf8').split('\n')) {
  if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.type !== 'assistant') continue;
  for (const c of j.message?.content ?? []) if (c.type === 'text' && c.text.trim()) texts.push(c.text.trim());
}
for (const t of texts.slice(-Number(n))) console.log('---\n' + t.slice(0, Number(max)));
