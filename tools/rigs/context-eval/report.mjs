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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { missLevel, readsOf } from '../context-measure/measure.mjs';
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

// Decision D11: Claude Code's auto-memory is keyed to the fixture repo, so a
// lane that wrote memory had it loaded into every later lane on that node.
// Claude Code's injection header marks a lane that LOADED it (a bare memory
// path appears in every transcript via the harness's memory instructions).
const MEMORY_LOADED = /Contents of \S*\/memory\/MEMORY\.md \(user/;
const MEMORY_WRITE_PATH = /\/\.claude\/projects\/[^\s'"]*\/memory\//;
// The memory path must be the TARGET of the write: `cat <memory>/x 2>/dev/null` reads.
const MEM = String.raw`['"]?[^\s'"]*\/\.claude\/projects\/[^\s'"]*\/memory\/?[^\s'"]*['"]?`;
const SHELL_MEMORY_WRITES = [
  new RegExp(String.raw`(?:>>?|\btee\b(?:\s+-a)?)\s*` + MEM),
  new RegExp(String.raw`\b(?:cp|mv|rsync)\b[^;&|\n]*\s` + MEM + String.raw`\s*(?:$|[;&|\n])`),
  new RegExp(String.raw`\b(?:mkdir|touch)\b[^;&|\n]*` + MEM),
];
/** Did this transcript WRITE Claude auto-memory (a Write/Edit to, or a shell write into, a project memory dir)? */
export function wroteAutoMemory(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') || !line.includes('memory')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of r.message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      const p = String(b.input?.file_path ?? '');
      if (['Write', 'Edit', 'MultiEdit'].includes(b.name) && MEMORY_WRITE_PATH.test(p)) return true;
      const c = String(b.input?.command ?? '');
      if (b.name === 'Bash' && SHELL_MEMORY_WRITES.some((re) => re.test(c))) return true;
    }
  }
  return false;
}
/**
 * Report-time, from each row's transcript (no measured field changes): the
 * writer rows get `wroteAutoMemory: true`; a row that LOADED lane-written
 * memory gets `contaminated: {by, via: 'auto-memory'}`, `by` = the latest
 * writer on the same node that started before it ('unknown' if none in these
 * files). Contaminated rows are set aside from every comparison (§5).
 */
export function annotateContamination(rows, read = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : null)) {
  const texts = new Map(rows.map((r) => [r, read(r.transcript)]));
  for (const r of rows) {
    const t = texts.get(r);
    if (t != null && wroteAutoMemory(t)) r.wroteAutoMemory = true;
  }
  for (const r of rows) {
    const t = texts.get(r);
    if (t == null || !MEMORY_LOADED.test(t)) continue;
    const writers = rows.filter((w) => w.wroteAutoMemory && w !== r && w.node?.port === r.node?.port && w.startedAt && r.startedAt && w.startedAt < r.startedAt).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    r.contaminated = { by: writers.at(-1)?.sessionId ?? 'unknown', via: 'auto-memory' };
  }
  return rows;
}
/**
 * D9 (h) sub-count, report-time (advisor msg 01a0d9a8-331b): did a lane OPEN
 * another lane's copy of its task? Every copy's id is in the rows; the shared
 * needle doc's connections make siblings VISIBLE (C4 msg 01a0d9a7-9ff6), and
 * following one reaches that lane's closeout. A read = measure.mjs's own read
 * classifier (`tm8 entity context|get <id>`, ...) or `tm8 message list --for
 * <id>`, on an id that is another row's taskId, never the row's own. A mention
 * inside a message body is not a read.
 */
const MESSAGE_LIST = /tm8\s+message\s+list\b[^|;&\n]*--for\s+([0-9a-f-]{36})/g;
export function annotateCrossLane(rows, read = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : null)) {
  const copies = new Map(rows.filter((r) => r.taskId).map((r) => [r.taskId, r]));
  for (const r of rows) {
    const t = read(r.transcript);
    if (t == null) continue;
    const opened = new Set();
    for (const line of t.split('\n')) {
      if (!line.includes('tool_use')) continue;
      let x;
      try {
        x = JSON.parse(line);
      } catch {
        continue;
      }
      for (const b of x.message?.content ?? []) {
        if (b.type !== 'tool_use') continue;
        const ids = readsOf(b).map((rd) => rd.id);
        if (b.name === 'Bash') for (const m of String(b.input?.command ?? '').matchAll(MESSAGE_LIST)) ids.push(m[1]);
        for (const id of ids) if (id && id !== r.taskId && copies.has(id)) opened.add(id);
      }
    }
    if (opened.size) r.openedSiblingCopy = [...opened].map((id) => ({ taskId: id, sessionId: copies.get(id).sessionId }));
  }
  return rows;
}

/**
 * DECISION D12 (C1 msg 01a0d9ae-e864): every lane's worktree sits under
 * <datadir>/worktrees/<project>/ and is readable by every other lane on the
 * node, so a lane that could not find the spec copied a SIBLING's
 * implementation, and the rubric could not see it (c1 haiku45/stress30,
 * c4 haiku45/stress30#2). A row whose tool calls (main AND subagent
 * transcripts) name another row's worktree, matched on its
 * `<project>/<lane-id>` tail so a relative path after `cd <datadir>` counts,
 * gets readSiblingWorktree [{sessionId, worktree}] and is SET ASIDE: its
 * success is not the lane's own.
 */
const defaultTexts = (r) => {
  if (!r.transcript || !existsSync(r.transcript)) return [];
  const out = [readFileSync(r.transcript, 'utf8')];
  const sub = r.transcript.replace(/\.jsonl$/, '') + '/subagents';
  if (existsSync(sub)) for (const f of readdirSync(sub).filter((x) => x.endsWith('.jsonl')).sort()) out.push(readFileSync(`${sub}/${f}`, 'utf8'));
  return out;
};
const worktreeTail = (w) => (w ? w.split('/').filter(Boolean).slice(-2).join('/') : null);
export function annotateSiblingWorktree(rows, texts = defaultTexts) {
  const others = rows.filter((r) => r.worktree).map((r) => ({ r, tail: worktreeTail(r.worktree) }));
  for (const r of rows) {
    const own = worktreeTail(r.worktree);
    const found = new Map();
    for (const t of texts(r)) {
      for (const line of t.split('\n')) {
        if (!line.includes('tool_use')) continue;
        let x;
        try {
          x = JSON.parse(line);
        } catch {
          continue;
        }
        for (const b of x.message?.content ?? []) {
          if (b.type !== 'tool_use') continue;
          const input = JSON.stringify(b.input ?? {});
          for (const { r: o, tail } of others) {
            if (o === r || !tail || tail === own || !input.includes(tail)) continue;
            // The path as the tool named it (absolute, or relative after `cd <datadir>`).
            const path = input.match(new RegExp(`[^\\s"'\\\\]*${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s"'\\\\]*`))?.[0] ?? o.worktree;
            if (!found.has(o.sessionId)) found.set(o.sessionId, path);
          }
        }
      }
    }
    if (found.size) r.readSiblingWorktree = [...found].map(([sessionId, path]) => ({ path, sessionId }));
  }
  return rows;
}

/** A row set aside: excluded by hand/auto, or contaminated (D11). */
export const setAside = (r) => !!(r.excluded || r.contaminated || r.readSiblingWorktree);
export const asideReason = (r) => r.excluded?.reason ?? (r.contaminated ? `contaminated: loaded lane-written auto-memory (by ${r.contaminated.by})` : `copied from sibling worktree (${r.readSiblingWorktree.map((o) => o.sessionId).join(', ')})`);

/** Row classification: measured, excluded (set aside with a reason), or neither (a defect). */
export function classify(rows) {
  // firstRequestTokens 0 is a lane that sent no request (a synthetic first
  // reply): it is a start failure to set aside, never a measured 0-token lane.
  const ok = (r) => typeof r.firstRequestTokens === 'number' && r.firstRequestTokens > 0 && !r.measureError;
  const measured = rows.filter((r) => !setAside(r) && ok(r));
  const excluded = rows.filter(setAside);
  const unmeasured = rows.filter((r) => !setAside(r) && !ok(r));
  return { measured, excluded, unmeasured };
}
export const entryMissed = (r) => Object.values(r.miss?.ids ?? {}).some((why) => missLevel(why) === 'entry');
// D6 (advisor 01a0d777-7b11): D2 counts a miss only when a lane READS an id the
// launch withheld, so an entry-level miss on a stress needle is a RECOVERY, and
// the lane that never fetched the withheld needle scores 0 misses. A SILENT
// context failure is a needle that was not inlined whole (absent, collapsed or
// header-dropped) and was never opened. Needle rows only.
const SILENT_STATES = ['absent', 'collapsed', 'header-dropped'];
export const hasNeedle = (r) => r.needleOpened === true || r.needleOpened === false;
export const silentContextFailure = (r) => hasNeedle(r) && SILENT_STATES.includes(r.needleState) && r.needleOpened === false;
export const headerRead = (r) => Object.values(r.miss?.ids ?? {}).some((why) => missLevel(why) === 'header');
// DECISION D7 (advisor 01a0d777-7b11, from c1 msg 01a0d97b-370c): the fixture's
// naming-conventions skill CONTRADICTS the alias memory, so `aliasCheck` and its
// two hidden checks measure whether a lane trusts a memory over a conflicting
// skill (a careful model may rightly refuse it), not memory delivery. This run
// they stay out of the rubric mean AND out of success / deliverable correct on
// EVERY arm, printed per model with k/n under that name. Delivery on index arms
// is memoryExpands / the header-level read. Fixture v3 removes the conflict.
export const NOT_IN_MEAN = { aliasCheck: 'alias memory trusted over conflicting skill' };
export const indexOff = (arm) => !ARM_ENV[arm]?.TM8_CONTEXT_INDEX;
// DECISION D8 (advisor 01a0d777-7b11, from c2 msg 01a0d97c-ddec): the v2
// replicas are real tm8 tasks run in the ledger-lite fixture repo, so their
// rubric is NOT a context measure. Which rubric items apply, per key.
// AUTHORITY: fixtures/replicas-v2.json (frozen description + criteria), read by
// the designer (msg 01a0d97e-0233); report.test.mjs re-derives `ticked` from the
// criteria count. committed is n/a on all three (01a0d742's body forbids code;
// 01a0d780's PR and 01a0d778's harness code do not exist in ledger-lite);
// ticked is n/a where the replica has no criteria. A lane that read such a body
// and stopped to ask is a named outcome, `asked the human`, counted per model x
// arm and kept OUT of the replica mean and success (never scored 0). The
// replica family's real measures are sizes, misses and blind-fetch.
export const REPLICA_ITEMS = {
  'replica-01a0d742': { kind: 'doc', applies: ['closeout', 'ticked'] },
  'replica-01a0d780': { kind: 'code', applies: ['closeout', 'ticked'] },
  'replica-01a0d778': { kind: 'code', applies: ['closeout'] },
};
export const REPLICA_LABEL = 'not a context measure in fixture v2: tasks target the tm8 repo, lanes run on ledger-lite';
const replicaItems = (r) => {
  const m = REPLICA_ITEMS[r.taskKey];
  if (!m) throw new Error(`replica ${r.taskKey} has no entry in report.mjs REPLICA_ITEMS (D8): add its applicable rubric items from fixtures/replicas-v2.json`);
  return m.applies;
};
const itemCounts = (r, name) => !(name in NOT_IN_MEAN) && (r.family !== 'replica' || replicaItems(r).includes(name));
export const askedTheHuman = (r) => r.family === 'replica' && r.ended === 'idle' && typeof r.requests === 'number' && r.requests <= 2 && !r.success?.committed && !r.success?.closeout;
/** The row's rubric score over the items that count (D7, D8); null for a lane that asked the human. */
export function rubricScore(r) {
  if (askedTheHuman(r)) return null;
  const items = r.rubric?.items;
  if (!Array.isArray(items)) return r.rubric?.score ?? null;
  const kept = items.filter((i) => itemCounts(r, i.name));
  return kept.length ? kept.filter((i) => i.pass).length / kept.length : null;
}
/**
 * success / deliverableCorrect WITHOUT the alias hidden checks (D7), on every
 * arm: recomputed from the row's per-check checkResults (each pass already
 * requires the commit) exactly as success.mjs defines both, minus the alias
 * set. A row with no alias checks keeps success.mjs's values.
 */
export function outcomeOf(r) {
  const s = r.success;
  if (!s) return { success: false, deliverableCorrect: false };
  // D8: a replica succeeds on the items that apply to its key (closeout, and ticked when it has criteria).
  if (r.family === 'replica') return { success: replicaItems(r).every((name) => !!s[name]), deliverableCorrect: false };
  if (!(r.checkResults ?? []).some((c) => c.set === 'alias')) return { success: !!s.success, deliverableCorrect: !!s.deliverableCorrect };
  const deliverableCorrect = !!s.committed && r.checkResults.filter((c) => c.set !== 'alias').every((c) => c.pass);
  return { success: deliverableCorrect && !!s.closeout && !!s.ticked, deliverableCorrect };
}
const succeeded = (r) => outcomeOf(r).success;
/** Success over the rows that were scored: a lane that asked the human is not a failure (D8). */
const successOf = (rs) => {
  const scored = rs.filter((r) => !askedTheHuman(r));
  return { k: scored.filter(succeeded).length, n: scored.length, asked: rs.length - scored.length };
};
/** Per rubric item: `name k/n` over scored rows; a D7 item under its reading; a D8 n/a item; replica's asked-the-human count. */
function rubricItems(rs) {
  const names = [...new Set(rs.flatMap((r) => (r.rubric?.items ?? []).map((i) => i.name)))];
  const scored = rs.filter((r) => !askedTheHuman(r));
  const parts = names.map((name) => {
    const k = scored.filter((r) => r.rubric?.items?.some((i) => i.name === name && i.pass)).length;
    if (name in NOT_IN_MEAN) return `${NOT_IN_MEAN[name]} ${k}/${scored.length} (not in the mean or success: D7)`;
    const applicable = scored.filter((r) => itemCounts(r, name));
    const ka = applicable.filter((r) => r.rubric?.items?.some((i) => i.name === name && i.pass)).length;
    if (!applicable.length) return `${name} n/a (D8)`;
    return `${name} ${ka}/${applicable.length}${applicable.length < scored.length ? ` (n/a on ${scored.length - applicable.length}: D8)` : ''}`;
  });
  if (rs.some((r) => r.family === 'replica')) {
    parts.unshift(REPLICA_LABEL);
    parts.push(`asked the human ${rs.length - scored.length}/${rs.length}`);
  }
  return parts.join(' · ');
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
  ['API requests (lane total, subagents included)', (r) => r.requests],
  ['  of which subagent requests', (r) => r.subagents?.requests],
  ['tool calls', (r) => r.toolCalls],
  ['input-side tokens (all requests)', inputTokens],
  ['output tokens', (r) => r.usage?.output],
  ['wall seconds', (r) => r.wallSeconds],
  ['est. $ per lane (subagents included)', (r) => r.costUsd, 3],
  ['  of which subagent $', (r) => r.subagents?.costUsd, 3],
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
  // The floor: a row measured before subagent transcripts were read under-counts a delegating lane.
  const noSub = measured.filter((r) => r.subagentsMeasured !== true);
  if (noSub.length) throw new Error(`${noSub.length} measured row(s) were measured without their subagent transcripts (requests / usage / $ under-count a delegating lane): node remeasure.mjs <file>.jsonl --all`);
  const stale = measured.filter((r) => r.components?.schema !== COMPONENTS_SCHEMA);
  if (stale.length) throw new Error(`${stale.length} measured row(s) carry components schema ${[...new Set(stale.map((r) => r.components?.schema ?? 1))].join(', ')}, not ${COMPONENTS_SCHEMA} (the kernel figure changed meaning): node remeasure.mjs <file>.jsonl --all`);
  if (versions.length !== 1) throw new Error(`rows span fixture versions ${versions.join(', ')}: arms and families are not comparable across fixtures; report each version separately`);
  const md = [];
  const json = { title, generatedAt: new Date().toISOString(), rows: rows.length, measured: measured.length, excluded: excluded.length, fixtureVersions: versions, builds: [...new Set(rows.map((r) => r.buildSha))], cells: {}, gate: {}, accuracy: {}, costDelta: {}, failures: {}, load: {}, delta: null };
  md.push(`# ${title}`, '', `rows ${rows.length} · measured ${measured.length} · set aside ${excluded.length} · builds ${json.builds.join(', ')} · fixture ${versions.join(', ')} · generated ${json.generatedAt}`, '');
  const delegated = measured.filter((r) => (r.subagents?.files ?? 0) > 0);
  json.delegated = delegated.map((r) => ({ arm: r.arm, model: r.model, taskKey: r.taskKey, rep: r.rep, sessionId: r.sessionId, subagentRequests: r.subagents.requests, subagentUsd: r.subagents.costUsd }));
  md.push(`Lanes that delegated to subagents: ${delegated.length}${delegated.length ? ` (${delegated.map((r) => `${r.arm}/${r.model}/${r.taskKey}#${r.rep}: ${r.subagents.requests} req, $${r.subagents.costUsd.toFixed(3)}`).join('; ')})` : ''}. Requests, input-side tokens and $ are lane totals, subagents included; first-request tokens, components and misses are the main thread's.`, '');
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
  md.push('## 2. D2 gate (per LAUNCH): launches with an ENTRY-level miss', '', '| model | arm | launches | entry-level missed | rate | exact 95% upper bound | header-level reads | silent context failure (D6) | of which silent + passed | success | flag |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const a of arms) {
      const rs = measured.filter((r) => r.model === model && r.arm === a && r.family !== 'replica');
      if (!rs.length) continue;
      const k = rs.filter(entryMissed).length;
      const h = rs.filter(headerRead).length;
      const ub = upperBound95(k, rs.length);
      const flag = rs.length && h / rs.length > 0.25 ? '⚑ headers too thin or sub-caps too small' : '';
      const needles = rs.filter(hasNeedle);
      const silent = needles.filter(silentContextFailure).length;
      // The COPY signature (D12 / spec (n)): needle never opened, yet every check passed.
      const silentPassed = needles.filter((r) => silentContextFailure(r) && outcomeOf(r).deliverableCorrect).length;
      const ok = rs.filter(succeeded).length;
      md.push(`| ${model} | ${a} | ${rs.length} | ${k} | ${Math.round((100 * k) / rs.length)}% | ${(100 * ub).toFixed(1)}% | ${pct(h, rs.length)} | ${needles.length ? pct(silent, needles.length) : 'n/a'} | ${needles.length ? `${silentPassed}/${silent}` : 'n/a'} | ${pct(ok, rs.length)} | ${flag} |`);
      json.gate[`${model}/${a}`] = { launches: rs.length, entryMissed: k, rate: k / rs.length, upperBound95: ub, headerReads: h, needleLaunches: needles.length, silentContextFailures: silent, silentPassed, success: ok, flag: !!flag };
    }
  }
  md.push('', 'The gate (design 01a0d348 §7.2, decision D2) needs < 5% entry-level missed launches AND success not worse than the lean arm. A 0/n point estimate certifies < 5% only when the upper bound is below it (n ≥ 59 with zero misses).', '', 'Read the gate WITH the two columns beside it (decision D6). An entry-level miss means the lane FETCHED what the launch withheld: on index-off arms the stress needle is absent by construction (count-cap:entry), so a miss there is a recovery. A silent context failure is a needle that was not inlined (absent, collapsed or header-dropped) and was never opened. It scores 0 misses, so the gate cannot see it (needle launches only). "silent + passed" (D12) is the COPY signature: needle never opened, yet every check passed. Rows that read a sibling lane\'s worktree are already set aside; one that remains reasoned the rule out, or took it from a header or memory, and deserves a transcript read.', '');

  // 3. accuracy per model × arm × family
  md.push('## 3. Accuracy (deterministic rubric; replica reported separately, never pooled)', '', 'Decision D7: the memory family\'s alias item measures whether a lane trusts a memory over a CONFLICTING skill (fixture v2\'s naming-conventions skill contradicts it), not delivery. On every arm it and its two hidden checks are out of the rubric mean and out of success / deliverable correct, printed with k/n as "alias memory trusted over conflicting skill". Read delivery on index arms from memoryExpands (the header-level read).', '', 'Decision D8: replica accuracy is ' + REPLICA_LABEL + '. It is printed for completeness and dropped from every success comparison (§2 gate, §6 delta). Applicable items per key (AUTHORITY fixtures/replicas-v2.json): ' + Object.entries(REPLICA_ITEMS).map(([k, v]) => `${k} (${v.kind}): ${v.applies.join(' + ')}`).join('; ') + '; committed is n/a on all three. "asked the human" (ended idle after at most 2 requests, no commit, no closeout) is a named outcome: counted per cell and kept out of the replica mean and success rate. The replica family\'s real measures are its sizes, misses and blind-fetch (§1).', '', '| model | family | arm | n | success (all gates) | deliverable correct | mean rubric | rubric items | needle opened |', '|---|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    for (const family of families) {
      for (const a of arms) {
        const rs = measured.filter((r) => r.model === model && r.family === family && r.arm === a);
        if (!rs.length) continue;
        const so = successOf(rs);
        const del = rs.filter((r) => outcomeOf(r).deliverableCorrect).length;
        const rub = mean(rs.map(rubricScore));
        const needle = rs.filter((r) => r.needleOpened !== null);
        md.push(`| ${model} | ${family} | ${a} | ${rs.length} | ${pct(so.k, so.n)} | ${family === 'replica' ? 'n/a' : pct(del, rs.length)} | ${rub == null ? '—' : rub.toFixed(2)} | ${rubricItems(rs)} | ${needle.length ? pct(needle.filter((r) => r.needleOpened).length, needle.length) : 'n/a'} |`);
        json.accuracy[`${model}/${a}/${family}`] = { n: rs.length, success: so.k, scored: so.n, askedTheHuman: so.asked, deliverableCorrect: del, rubricMean: rub, notInMean: Object.keys(NOT_IN_MEAN) };
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
      const ex = all.filter(setAside);
      const reasons = [...new Set(ex.map((r) => asideReason(r).slice(0, 60)))].join('; ');
      md.push(`| ${model} | ${a} | ${all.length} | ${pct(ex.length, all.length)} | ${reasons} | ${all.filter((r) => r.ended === 'timeout').length} |`);
      json.failures[`${model}/${a}`] = { launches: all.length, excluded: ex.length, reasons: ex.map(asideReason), timeouts: all.filter((r) => r.ended === 'timeout').length };
    }
  }
  const writers = rows.filter((r) => r.wroteAutoMemory);
  const contaminated = rows.filter((r) => r.contaminated);
  const moved = rows.filter((r) => r.memoryDirState === 'moved');
  json.contamination = { wroteAutoMemory: writers.map((r) => ({ slice: r.slice, port: r.node?.port, model: r.model, taskKey: r.taskKey, rep: r.rep, sessionId: r.sessionId })), contaminated: contaminated.map((r) => ({ slice: r.slice, model: r.model, taskKey: r.taskKey, rep: r.rep, sessionId: r.sessionId, ...r.contaminated, excluded: !!r.excluded })), memoryDirMoved: moved.map((r) => ({ slice: r.slice, sessionId: r.sessionId, at: r.memoryDirMovedAt, files: r.memoryDirMovedFiles })) };
  md.push('', `Auto-memory (decision D11): ${writers.length} lane(s) WROTE Claude auto-memory${writers.length ? ` (${writers.map((r) => `${r.slice}/${r.model}/${r.taskKey}#${r.rep} ${r.sessionId}`).join('; ')})` : ''}; ${contaminated.length} row(s) LOADED lane-written memory and are set aside above${contaminated.length ? ` (${contaminated.map((r) => `${r.slice}/${r.model}/${r.taskKey}#${r.rep} by ${r.contaminated.by}`).join('; ')})` : ''}; the runner's guard moved a non-empty memory dir before ${moved.length} lane start(s).`);
  const hopped = rows.filter((r) => r.openedSiblingCopy);
  const copied = rows.filter((r) => r.readSiblingWorktree);
  json.crossLane = { readSiblingWorktree: copied.map((r) => ({ slice: r.slice, model: r.model, taskKey: r.taskKey, rep: r.rep, sessionId: r.sessionId, excluded: !!r.excluded, from: r.readSiblingWorktree })), openedSiblingCopy: hopped.map((r) => ({ slice: r.slice, model: r.model, taskKey: r.taskKey, rep: r.rep, sessionId: r.sessionId, opened: r.openedSiblingCopy })) };
  md.push('', `Cross-lane (D9 (h)): ${hopped.length} row(s) OPENED another lane's copy of their task${hopped.length ? ` (${hopped.map((r) => `${r.slice}/${r.model}/${r.taskKey}#${r.rep} -> ${r.openedSiblingCopy.map((o) => o.sessionId).join(',')}`).join('; ')})` : ''}. A shared needle doc makes sibling copies visible; this counts the hop.`);
  md.push('', `Sibling worktree (D12): ${copied.length} row(s) READ another lane's worktree and are set aside above${copied.length ? ` (${copied.map((r) => `${r.slice}/${r.model}/${r.taskKey}#${r.rep} ${r.sessionId} <- ${r.readSiblingWorktree.map((o) => o.sessionId).join(',')}`).join('; ')})` : ''}. Every lane worktree on a node is readable by every other lane; a copied answer passes the rubric, so it cannot count as the lane's own success.`);
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
            // D8: replica accuracy is not a context measure; it enters no success or rubric comparison.
            if (family === 'replica' && (name === 'success %' || name === 'mean rubric')) continue;
            let pv;
            let cv;
            if (name.startsWith('entry-level')) {
              pv = (100 * prev.filter(entryMissed).length) / prev.length;
              cv = (100 * cur.filter(entryMissed).length) / cur.length;
            } else if (name === 'mean rubric') {
              pv = mean(prev.map(f));
              cv = mean(cur.map(f));
            } else if (name === 'success %') {
              const ps = successOf(prev);
              const cs = successOf(cur);
              pv = ps.n ? (100 * ps.k) / ps.n : null;
              cv = cs.n ? (100 * cs.k) / cs.n : null;
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
  const rows = annotateSiblingWorktree(annotateCrossLane(annotateContamination(readRows(files))));
  if (!rows.length) refuse(`${files.join(', ')}: no rows`);
  const { unmeasured } = classify(rows);
  if (unmeasured.length) refuse(`${unmeasured.length} row(s) neither measured nor excluded: ${unmeasured.map((r) => `${r.arm}/${r.model}/${r.taskKey}#${r.rep} (${r.sessionId}) ${r.measureError ?? 'no firstRequestTokens'}`).join('; ')}. Fix the measurement or set it aside with exclude.mjs --reason.`);
  const present = ARMS.filter((a) => rows.some((r) => r.arm === a));
  for (const a of present) if (!rows.some((r) => r.arm === a && !setAside(r) && typeof r.firstRequestTokens === 'number')) refuse(`arm ${a} has rows but none measured`);
  const wanted = (arg('arms') ?? '').split(',').filter(Boolean);
  for (const a of wanted) if (!rows.some((r) => r.arm === a)) refuse(`arm ${a} has zero rows`);
  const baseline = arg('baseline') ? annotateContamination(readRows([arg('baseline')])) : null;
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
