#!/usr/bin/env node
// Stitches dist/index.html: template + shared css/js + icon sprite + sections/*.html in name order.
// Usage: node build.mjs [--only <section-file>]   (--only builds a single section for quick preview)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const read = (p) => readFileSync(join(here, p), 'utf8');
const css = ['shared/tokens.css', 'shared/phone.css', 'shared/doc.css'].map(read).join('\n');
const js = read('shared/doc.js');
const icons = read('shared/icons.svg');
let files = readdirSync(join(here, 'sections')).filter((f) => f.endsWith('.html')).sort();
if (only) files = files.filter((f) => f === only || f === only + '.html' || f.startsWith(only));
const sections = files.map((f) => {
  const html = read('sections/' + f);
  const m = html.match(/<section[^>]*\sid="([^"]+)"[^>]*>/);
  return { f, id: m ? m[1] : f, html: `\n<!-- ===== ${f} ===== -->\n${html.trim()}\n`, bytes: Buffer.byteLength(html) };
});
let hero = '';
try { hero = read('hero.html'); } catch {}
const out = read('template.html')
  .replace('/*@@CSS@@*/', css)
  .replace('<!--@@ICONS@@-->', icons)
  .replace('<!--@@DATE@@-->', new Date().toISOString().slice(0, 10))
  .replace('<!--@@HERO@@-->', hero)
  .replace('<!--@@SECTIONS@@-->', sections.map((s) => s.html).join('\n'))
  .replace('/*@@JS@@*/', js);
mkdirSync(join(here, 'dist'), { recursive: true });
const target = only ? `dist/preview-${files[0] || 'none'}` : 'dist/index.html';
writeFileSync(join(here, target), out);
for (const s of sections) console.log(`  ${s.f.padEnd(40)} ${s.id.padEnd(24)} ${(s.bytes / 1024).toFixed(1)} KB`);
console.log(`built ${target}: ${sections.length} sections, ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
