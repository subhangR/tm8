#!/usr/bin/env node
// The eval report: per model × arm × family tables, the D2 gate rows, accuracy,
// cost deltas vs the lean arm, start failures, per-slice load, and a DELTA
// section against a prior run. Writes <out>.md and <out>.json.
//
//   node report.mjs results/<run>.jsonl [more.jsonl ...] [--baseline results/<prior>.jsonl] [--out results/<run>]
//
// Refuses (exit 1): zero rows; an arm with zero rows; a row that is neither
// measured nor excluded (medians silently drop nulls, so an unmeasured lane
// would shrink n and still look fine; a 0-token first request counts as
// unmeasured); rows spanning more than one fixture version, or a baseline
// built on another one (their numbers would not be comparable).

import { readFileSync, writeFileSync } from 'node:fs';
import { missLevel } from '../context-measure/measure.mjs';
import { COMPONENTS_SCHEMA } from './components.mjs';
import { ARMS, ARM_ENV } from './node-registry.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

export function readRows(files) {
  return files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

export function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return { n: v.length, median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, min: v[0], max: v[v.length - 1] };
}
const fmtN = (x, d = 0) => (typeof x === 'number' ? Number(x.toFixed(d)).toLocaleString('en-US') : '—');
export const fmt = (s, d = 0) => (s ? `${fmtN(s.median, d)} [${fmtN(s.min, d)}–${fmtN(s.max, d)}] n=${s.n}` : '—');
const pct = (k, n) => (n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : '—');

/** Exact one-sided 95% upper bound on a rate with k of n (Clopper–Pearson), by bisection on the binomial CDF. */
export function upperBound95(k, n) {
  if (!n) return null;
  if (k >= n) return 1;
  const cdf = (p) => {
    let s = 0;
    for (let i = 0; i <= k; i++) s += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
    return s;
  };
  let lo = k / n;
  let hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}
function lnChoose(n, k) {
  return lnFact(n) - lnFact(k) - lnFact(n - k);
}
function lnFact(n) {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/** Row classification: measured, excluded (set aside with a reason), or neither (a defect). */
export function classify(rows) {
  // firstRequestTokens 0 is a lane that sent no request (a synthetic first
  // reply): it is a start failure to set aside, never a measured 0-token lane.
  const ok = (r) => typeof r.firstRequestTokens === 'number' && r.firstRequestTokens > 0 && !r.measureError;
  const measured = rows.filter((r) => !r.excluded && ok(r));
  const excluded = rows.filter((r) => r.excluded);
  const unmeasured = rows.filter((r) => !r.excluded && !ok(r));
  return { measured, excluded, unmeasured };
}
export const entryMissed = (r) => Object.values(r.miss?.ids ?? {}).some((why) => missLevel(why) === 'entry');
export const headerRead = (r) => Object.values(r.miss?.ids ?? {}).some((why) => missLevel(why) === 'header');
// Q1's memory collapse runs only with the context index ON, so the memory
// family's alias fact is inlined whole on an index-off arm and `aliasCheck`
// cannot discriminate there: n/a, and out of the rubric mean on those arms.
const INDEX_OFF_NA = ['aliasCheck'];
export const indexOff = (arm) => !ARM_ENV[arm]?.TM8_CONTEXT_INDEX;
const itemApplies = (arm, name) => !(indexOff(arm) && INDEX_OFF_NA.includes(name));
/** The row's rubric score over the items that apply on its arm. */
export function rubricScore(r) {
  const items = r.rubric?.items;
  if (!Array.isArray(items)) return r.rubric?.score ?? null;
  const kept = items.filter((i) => itemApplies(r.arm, i.name));
  return kept.length ? kept.filter((i) => i.pass).length / kept.length : null;
}
/** Per rubric item: `name k/n`, or `name n/a (index off)`. */
function rubricItems(rs, arm) {
  const names = [...new Set(rs.flatMap((r) => (r.rubric?.items ?? []).map((i) => i.name)))];
  return names.map((name) => (itemApplies(arm, name) ? `${name} ${rs.filter((r) => r.rubric?.items?.some((i) => i.name === name && i.pass)).length}/${rs.length}` : `${name} n/a (index off)`)).join(' · ');
}
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const inputTokens = (r) => (r.usage ? r.usage.input + r.usage.cacheCreation + r.usage.cacheRead : null);

const SIZE_COLS = [
  ['first-request tokens', (r) => r.firstRequestTokens],
  ['tm8 kernel bytes', (r) => r.components?.bytes?.tm8Kernel],
  ['assignment snapshot bytes', (r) => r.components?.bytes?.assignmentSnapshot],
  ['context index bytes', (r) => r.components?.bytes?.contextIndex],
  ['  references', (r) => r.components?.bytes?.contextIndexByGroup?.references],
  ['  skills', (r) => r.components?.bytes?.contextIndexByGroup?.skills],
  ['  memories (collapsed)', (r) => r.components?.bytes?.contextIndexByGroup?.memories],
  ['memories expanded bytes (outside the kernel)', (r) => r.components?.bytes?.memoriesExpanded],
  ['skills listing bytes (index off: the <skills> block)', (r) => r.components?.bytes?.skillsListing],
  ['harness chars (system + attachments)', (r) => r.components?.harnessTotal],
  ['  skill_listing', (r) => r.components?.bytes?.harness?.skillListing],
  ['  Claude in Chrome block', (r) => r.components?.bytes?.harness?.chrome],
  ['remainder chars (estimated: tool schemas)', (r) => r.components?.bytes?.remainderEstimated],
  ['tokens: tm8 kernel (est.)', (r) => r.components?.tokens?.tm8Kernel],
  ['tokens: memories expanded (est.)', (r) => r.components?.tokens?.memoriesExpanded],
  ['tokens: skills listing, index off (est.)', (r) => r.components?.tokens?.skillsListing],
  ['tokens: context index (est.)', (r) => r.components?.tokens?.contextIndex],
  ['tokens: harness (est.)', (r) => r.components?.tokens?.harness],
  ['resident tm8 bytes (× requests)', (r) => r.residentTm8Bytes],
  ['resident harness chars (× requests)', (r) => r.residentHarnessChars],
];
const EFF_COLS = [
  ['API requests', (r) => r.requests],
  ['tool calls', (r) => r.toolCalls],
  ['input-side tokens (all requests)', inputTokens],
  ['output tokens', (r) => r.usage?.output],
  ['wall seconds', (r) => r.wallSeconds],
  ['est. $ per lane', (r) => r.costUsd, 3],
  ['expand rate % (opened / entries)', (r) => (r.expand?.rate == null ? null : r.expand.rate * 100)],
  ['blind-fetch bytes', (r) => r.blindFetchBytes],
  ['memories collapsed (Q1)', (r) => r.memoriesCollapsed],
];

export function buildReport(rows, baselineRows, { title = 'context-eval report' } = {}) {
  const { measured, excluded, unmeasured } = classify(rows);
  const arms = ARMS.filter((a) => rows.some((r) => r.arm === a));
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const families = [...new Set(rows.map((r) => r.family))].sort();
  const versions = [...new Set(rows.map((r) => r.fixtureVersion?.contentHash ?? 'none'))];
  const stale = measured.filter((r) => r.components?.schema !== COMPONENTS_SCHEMA);
  if (stale.length) throw new Error(`${stale.length} measured row(s) carry components schema ${[...new Set(stale.map((r) => r.components?.schema ?? 1))].join(', ')}, not ${COMPONENTS_SCHEMA} (the kernel figure changed meaning): node remeasure.mjs <file>.jsonl --all`);
  if (versions.length !== 1) throw new Error(`rows span fixture versions ${versions.join(', ')}: arms and families are not comparable across fixtures; report each version separately`);
  const md = [];
  const json = { title, generatedAt: new Date().toISOString(), rows: rows.length, measured: measured.length, excluded: excluded.length, fixtureVersions: versions, builds: [...new Set(rows.map((r) => r.buildSha))], cells: {}, gate: {}, accuracy: {}, costDelta: {}, failures: {}, load: {}, delta: null };
  md.push(`# ${title}`, '', `rows ${rows.length} · measured ${measured.length} · set aside ${excluded.length} · builds ${json.builds.join(', ')} · fixture ${versions.join(', ')} · generated ${json.generatedAt}`, '');
  md.push('Medians are shown as median [min–max] n. $ is an estimate from pricing.mjs (VERIFY its table). Token components are shares of the measured first request (components.mjs).', '');

  // 1. size + efficiency per model × arm × family
  md.push('## 1. Size and efficiency per model × arm × family', '');
  for (const model of models) {
    for (const family of families) {
      const cellRows = (a) => measured.filter((r) => r.model === model && r.family === family && r.arm === a);
      if (!arms.some((a) => cellRows(a).length)) continue;
      md.push(`### ${model} · ${family}`, '', `| measure | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
      for (const [name, f, d] of [...SIZE_COLS, ...EFF_COLS]) {
        md.push(`| ${name} | ${arms.map((a) => fmt(stats(cellRows(a).map(f)), d)).join(' | ')} |`);
        for (const a of arms) (json.cells[`${model}/${a}/${family}`] ??= {})[name] = stats(cellRows(a).map(f));
      }
      md.push('');
    }
  }

  // 2. D2 gate rows per model × arm (all non-replica families pooled: the gate is per launch)
  md.push('## 2. D2 gate (per LAUNCH): launches with an ENTRY-level miss', '', '| model | arm | launches | entry-level missed | rate | exact 95% upper bound | header-level reads | flag |', '|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const a of arms) {
      const rs = measured.filter((r) => r.model === model && r.arm === a && r.family !== 'replica');
      if (!rs.length) continue;
      const k = rs.filter(entryMissed).length;
      const h = rs.filter(headerRead).length;
      const ub = upperBound95(k, rs.length);
      const flag = rs.length && h / rs.length > 0.25 ? '⚑ headers too thin or sub-caps too small' : '';
      md.push(`| ${model} | ${a} | ${rs.length} | ${k} | ${Math.round((100 * k) / rs.length)}% | ${(100 * ub).toFixed(1)}% | ${pct(h, rs.length)} | ${flag} |`);
      json.gate[`${model}/${a}`] = { launches: rs.length, entryMissed: k, rate: k / rs.length, upperBound95: ub, headerReads: h, flag: !!flag };
    }
  }
  md.push('', 'The gate (design 01a0d348 §7.2, decision D2) needs < 5% entry-level missed launches AND success not worse than the lean arm. A 0/n point estimate certifies < 5% only when the upper bound is below it (n ≥ 59 with zero misses).', '');

  // 3. accuracy per model × arm × family
  md.push('## 3. Accuracy (deterministic rubric; replica reported separately, never pooled)', '', '| model | family | arm | n | success (all gates) | deliverable correct | mean rubric | rubric items | needle opened |', '|---|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const family of families) {
      for (const a of arms) {
        const rs = measured.filter((r) => r.model === model && r.family === family && r.arm === a);
        if (!rs.length) continue;
        const ok = rs.filter((r) => r.success?.success).length;
        const del = rs.filter((r) => r.success?.deliverableCorrect).length;
        const rub = mean(rs.map(rubricScore));
        const needle = rs.filter((r) => r.needleOpened !== null);
        md.push(`| ${model} | ${family} | ${a} | ${rs.length} | ${pct(ok, rs.length)} | ${family === 'replica' ? 'n/a' : pct(del, rs.length)} | ${rub == null ? '—' : rub.toFixed(2)} | ${rubricItems(rs, a)} | ${needle.length ? pct(needle.filter((r) => r.needleOpened).length, needle.length) : 'n/a'} |`);
        json.accuracy[`${model}/${a}/${family}`] = { n: rs.length, success: ok, deliverableCorrect: del, rubricMean: rub, rubricNa: indexOff(a) ? INDEX_OFF_NA : [] };
      }
    }
  }
  md.push('');

  // 4. cost deltas vs lean, same model, same family
  md.push('## 4. Cost vs the lean arm (same model, same family; median of lane values)', '', '| model | family | arm | Δ first-request tokens | Δ input-side tokens | Δ est. $ | Δ wall s |', '|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const family of families) {
      const lean = measured.filter((r) => r.model === model && r.family === family && r.arm === 'lean');
      if (!lean.length) continue;
      const base = { first: stats(lean.map((r) => r.firstRequestTokens)), input: stats(lean.map(inputTokens)), usd: stats(lean.map((r) => r.costUsd)), wall: stats(lean.map((r) => r.wallSeconds)) };
      for (const a of arms.filter((x) => x !== 'lean')) {
        const rs = measured.filter((r) => r.model === model && r.family === family && r.arm === a);
        if (!rs.length) continue;
        const cur = { first: stats(rs.map((r) => r.firstRequestTokens)), input: stats(rs.map(inputTokens)), usd: stats(rs.map((r) => r.costUsd)), wall: stats(rs.map((r) => r.wallSeconds)) };
        const d = (k, dec = 0) => (cur[k] && base[k] ? `${cur[k].median - base[k].median >= 0 ? '+' : ''}${fmtN(cur[k].median - base[k].median, dec)}` : '—');
        md.push(`| ${model} | ${family} | ${a} | ${d('first')} | ${d('input')} | ${d('usd', 3)} | ${d('wall')} |`);
        json.costDelta[`${model}/${a}/${family}`] = { firstRequestTokens: cur.first && base.first ? cur.first.median - base.first.median : null, inputTokens: cur.input && base.input ? cur.input.median - base.input.median : null, usd: cur.usd && base.usd ? cur.usd.median - base.usd.median : null };
      }
    }
  }
  md.push('');

  // 5. start failures / hangs, and per-slice load
  md.push('## 5. Start failures, hangs and set-aside launches (never dropped)', '', '| model | arm | launches | set aside | reasons | timeouts |', '|---|---|---|---|---|---|');
  for (const model of models) {
    for (const a of arms) {
      const all = rows.filter((r) => r.model === model && r.arm === a);
      if (!all.length) continue;
      const ex = all.filter((r) => r.excluded);
      const reasons = [...new Set(ex.map((r) => r.excluded.reason.slice(0, 60)))].join('; ');
      md.push(`| ${model} | ${a} | ${all.length} | ${pct(ex.length, all.length)} | ${reasons} | ${all.filter((r) => r.ended === 'timeout').length} |`);
      json.failures[`${model}/${a}`] = { launches: all.length, excluded: ex.length, reasons: ex.map((r) => r.excluded.reason), timeouts: all.filter((r) => r.ended === 'timeout').length };
    }
  }
  md.push('', '| slice / node | lanes | load at lane start (1-min) | lanes that waited for load | waited seconds (of those) | fixture main sha(s) |', '|---|---|---|---|---|---|');
  for (const key of [...new Set(rows.map((r) => `${r.slice} / ${r.node?.port}`))]) {
    const rs = rows.filter((r) => `${r.slice} / ${r.node?.port}` === key);
    const waited = rs.filter((r) => (r.waitedSeconds ?? 0) > 0);
    // `base` is the fixture repo's main the lane branched from: more than one here means main MOVED mid-slice.
    const bases = [...new Set(rs.map((r) => r.base).filter(Boolean))];
    md.push(`| ${key} | ${rs.length} | ${fmt(stats(rs.map((r) => r.loadAtStart)))} | ${pct(waited.length, rs.length)} | ${fmt(stats(waited.map((r) => r.waitedSeconds)))} | ${bases.map((b) => b.slice(0, 8)).join(', ')}${bases.length > 1 ? ' ⚑ MOVED' : ''} |`);
    json.load[key] = { lanes: rs.length, loadAtStart: stats(rs.map((r) => r.loadAtStart)), waited: waited.length, fixtureMainShas: bases };
  }
  md.push('');

  // 6. delta vs baseline
  if (baselineRows) {
    const bv = [...new Set(baselineRows.map((r) => r.fixtureVersion?.contentHash ?? 'none'))];
    if (bv.length !== 1 || versions.length !== 1 || bv[0] !== versions[0]) throw new Error(`baseline fixture ${bv.join(',')} differs from this run's ${versions.join(',')}: rows are not comparable`);
    const b = classify(baselineRows).measured;
    md.push('## 6. DELTA vs baseline (baseline → this run, medians; n on both sides)', '', `baseline: ${baselineRows.length} rows, builds ${[...new Set(baselineRows.map((r) => r.buildSha))].join(', ')}`, '');
    md.push('| model | arm | family | measure | baseline | this run | Δ |', '|---|---|---|---|---|---|---|');
    json.delta = {};
    const KEY = [['first-request tokens', (r) => r.firstRequestTokens], ['est. $ per lane', (r) => r.costUsd, 3], ['entry-level missed launches %', null], ['success %', null], ['mean rubric', rubricScore, 2], ['wall seconds', (r) => r.wallSeconds]];
    for (const model of models) {
      for (const a of arms) {
        for (const family of families) {
          const cur = measured.filter((r) => r.model === model && r.arm === a && r.family === family);
          const prev = b.filter((r) => r.model === model && r.arm === a && r.family === family);
          if (!cur.length || !prev.length) continue;
          for (const [name, f, d] of KEY) {
            let pv;
            let cv;
            if (name.startsWith('entry-level')) {
              pv = (100 * prev.filter(entryMissed).length) / prev.length;
              cv = (100 * cur.filter(entryMissed).length) / cur.length;
            } else if (name === 'mean rubric') {
              pv = mean(prev.map(f));
              cv = mean(cur.map(f));
            } else if (name === 'success %') {
              pv = (100 * prev.filter((r) => r.success?.success).length) / prev.length;
              cv = (100 * cur.filter((r) => r.success?.success).length) / cur.length;
            } else {
              pv = stats(prev.map(f))?.median;
              cv = stats(cur.map(f))?.median;
            }
            if (pv == null || cv == null) continue;
            const dd = cv - pv;
            md.push(`| ${model} | ${a} | ${family} | ${name} | ${fmtN(pv, d)} (n=${prev.length}) | ${fmtN(cv, d)} (n=${cur.length}) | ${dd >= 0 ? '+' : ''}${fmtN(dd, d)} |`);
            (json.delta[`${model}/${a}/${family}`] ??= {})[name] = { baseline: pv, current: cv, delta: dd, nBaseline: prev.length, nCurrent: cur.length };
          }
        }
      }
    }
    md.push('');
  }
  return { md: md.join('\n'), json, arms, measured, excluded, unmeasured };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const files = argv.filter((a, i) => !a.startsWith('--') && a.endsWith('.jsonl') && !(i > 0 && argv[i - 1].startsWith('--')));
  const refuse = (why) => {
    console.error(`report: ${why}`);
    process.exit(1);
  };
  if (!files.length) refuse('usage: node report.mjs results/<run>.jsonl [--baseline <prior>.jsonl] [--out <path-without-ext>]');
  const rows = readRows(files);
  if (!rows.length) refuse(`${files.join(', ')}: no rows`);
  const { unmeasured } = classify(rows);
  if (unmeasured.length) refuse(`${unmeasured.length} row(s) neither measured nor excluded: ${unmeasured.map((r) => `${r.arm}/${r.model}/${r.taskKey}#${r.rep} (${r.sessionId}) ${r.measureError ?? 'no firstRequestTokens'}`).join('; ')}. Fix the measurement or set it aside with exclude.mjs --reason.`);
  const present = ARMS.filter((a) => rows.some((r) => r.arm === a));
  for (const a of present) if (!rows.some((r) => r.arm === a && !r.excluded && typeof r.firstRequestTokens === 'number')) refuse(`arm ${a} has rows but none measured`);
  const wanted = (arg('arms') ?? '').split(',').filter(Boolean);
  for (const a of wanted) if (!rows.some((r) => r.arm === a)) refuse(`arm ${a} has zero rows`);
  const baseline = arg('baseline') ? readRows([arg('baseline')]) : null;
  const out = arg('out') ?? files[0].replace(/\.jsonl$/, '');
  let built;
  try {
    built = buildReport(rows, baseline, { title: `context-eval report — ${files.map((f) => f.split('/').pop()).join(', ')}` });
  } catch (e) {
    refuse(e.message);
  }
  const { md, json } = built;
  writeFileSync(`${out}.md`, md + '\n');
  writeFileSync(`${out}.json`, JSON.stringify(json, null, 2) + '\n');
  process.stdout.write(md + '\n');
  console.error(`wrote ${out}.md and ${out}.json`);
}
