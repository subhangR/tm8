#!/usr/bin/env node
// Lints sections/*.html against the lane contract. Exit 1 on any ERROR.
// Usage: node check.mjs [section-file ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
let files = process.argv.slice(2);
if (!files.length) files = readdirSync(join(here, 'sections')).filter((f) => f.endsWith('.html')).map((f) => join(here, 'sections', f));
let errors = 0, warnings = 0;
const err = (f, m) => { errors++; console.log(`ERROR ${basename(f)}: ${m}`); };
const warn = (f, m) => { warnings++; console.log(`warn  ${basename(f)}: ${m}`); };

function checkCss(f, css, prefix) {
  // strip comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // walk blocks; handle @media/@supports by recursing into their body, @keyframes by name
  let i = 0;
  const walk = (text) => {
    let depth = 0, start = 0, sel = '';
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === '{') { if (depth === 0) { sel = text.slice(start, k).trim(); start = k + 1; } depth++; }
      else if (ch === '}') { depth--; if (depth === 0) { const body = text.slice(start, k); checkRule(sel, body); start = k + 1; } }
    }
  };
  const checkRule = (sel, body) => {
    if (!sel) return;
    if (sel.startsWith('@media') || sel.startsWith('@supports') || sel.startsWith('@container')) return walk(body);
    if (sel.startsWith('@keyframes')) { const name = sel.replace('@keyframes', '').trim(); if (!name.startsWith(prefix.slice(1) + '-')) err(f, `@keyframes "${name}" must be named ${prefix.slice(1)}-…`); return; }
    if (sel.startsWith('@font-face') || sel.startsWith('@import')) return err(f, `${sel.split(' ')[0]} is not allowed in a section`);
    sel.split(',').map((s) => s.trim()).forEach((s) => {
      if (!(s === prefix || s.startsWith(prefix + ' ') || s.startsWith(prefix + '.') || s.startsWith(prefix + '[') || s.startsWith(prefix + ':') || s.startsWith(prefix + '>'))) err(f, `selector not scoped under ${prefix}: "${s.slice(0, 80)}"`);
    });
    if (/\burl\(\s*['"]?https?:/.test(body)) err(f, `external url() in CSS: ${body.match(/url\([^)]*\)/)[0]}`);
  };
  walk(css);
}

for (const f of files) {
  const html = readFileSync(f, 'utf8');
  const slug = basename(f).replace(/\.html$/, '').replace(/^\d+-/, '');
  const expectId = 's-' + slug;
  const m = html.match(/^\s*<section\s+([^>]*)>/);
  if (!m) { err(f, 'file must start with a single <section …> element'); continue; }
  const attrs = m[1];
  const id = (attrs.match(/\sid="([^"]+)"/) || attrs.match(/^id="([^"]+)"/) || [])[1];
  if (id !== expectId) err(f, `section id must be "${expectId}" (got "${id}")`);
  if (!/class="[^"]*\bdoc-section\b/.test(attrs)) err(f, 'section needs class="doc-section"');
  if (!/data-title="/.test(attrs)) err(f, 'section needs data-title="…"');
  if (!/data-lane="/.test(attrs)) err(f, 'section needs data-lane="…"');
  if (!/<\/section>\s*$/.test(html)) err(f, 'file must end with </section>');
  const sectionCount = (html.match(/<section\b/g) || []).length;
  if (sectionCount !== 1) err(f, `exactly one <section> allowed (found ${sectionCount}); use <div> inside`);
  if (!/<header>\s*[\s\S]*?<h2[\s>]/.test(html)) err(f, 'needs <header> with <h2> right after the opening <section>');
  if (/<script\b/i.test(html)) err(f, '<script> is not allowed in a section; use data-tabs / data-set hooks from shared/doc.js');
  if (/<(link|iframe|object|embed|video|audio)\b/i.test(html)) err(f, '<link>/<iframe>/<object>/<embed>/<video>/<audio> are not allowed');
  const ext = html.match(/\b(src|href)=["']https?:\/\/[^"']+/g) || [];
  ext.forEach((x) => { if (!/^href=["']https?:\/\/(github\.com|tm8\.sh|docs\.expo\.dev|reactnative\.dev|developer\.apple\.com|m3\.material\.io)/.test(x)) err(f, `external resource not allowed: ${x.slice(0, 90)}`); });
  if (/<img\b[^>]*src=["'](?!data:)/i.test(html)) err(f, '<img> may only use data: URIs (prefer drawing with CSS/SVG)');
  (html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []).forEach((block) => checkCss(f, block.replace(/<\/?style[^>]*>/g, ''), '#' + expectId));
  if (/style="[^"]*url\(\s*['"]?https?:/.test(html)) err(f, 'inline external url()');
  // quality warnings
  const phones = (html.match(/class="[^"]*\bphone\b/g) || []).length;
  const dark = (html.match(/class="[^"]*\bphone\b[^"]*"[^>]*data-theme="dark"|data-theme="dark"[^>]*class="[^"]*\bphone\b/g) || []).length;
  const android = (html.match(/data-os="android"/g) || []).length;
  if (phones === 0 && !/data-lane="LLD"/.test(attrs)) warn(f, 'no .phone mockups');
  if (phones > 0 && dark === 0) warn(f, 'no phone drawn in dark theme (data-theme="dark")');
  if (phones > 0 && android === 0) warn(f, 'no phone drawn as Android (data-os="android")');
  if (!/class="route-table"/.test(html)) warn(f, 'no <table class="route-table"> (every lane lists its routes)');
  if (!/class="spec"/.test(html)) warn(f, 'no <table class="spec"> (component / state / gesture specs)');
  if (/lorem ipsum/i.test(html)) err(f, 'lorem ipsum: use real tm8 content (see BRIEF.md sample world)');
  if (/\bTODO\b|\bTBD\b|\bFIXME\b/.test(html)) warn(f, 'contains TODO/TBD/FIXME');
  const lanePrefix = new RegExp(`class="[^"]*\\b(?!${slug})[a-z]+-[a-z]`, 'g');
  console.log(`ok    ${basename(f)}: ${phones} phones (${dark} dark, ${android} android), ${(html.length / 1024).toFixed(0)} KB`);
}
console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
