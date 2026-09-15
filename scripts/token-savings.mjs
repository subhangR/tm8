#!/usr/bin/env node
/**
 * token-savings — what compaction actually saved, counted from the turns that
 * happened, and what it cost to do it.
 *
 * THE QUESTION THIS ANSWERS. "You would have spent X on your own key; you spent
 * Y here." Everywhere else that sentence is a projection. Here it is arithmetic
 * over real provider `usage` records, because a compaction leaves a measurable
 * scar: the conversation prefix drops from `pre` to `post` in one step, and
 * EVERY LATER TURN re-reads the smaller prefix instead of the larger one.
 *
 *     avoided cache-read = SUM over turns of (counterfactual prefix - actual prefix)
 *
 * THE COUNTERFACTUAL IS CAPPED AT THE CONTEXT WALL, AND THIS IS THE WHOLE
 * POINT. The naive version of this script replays the session with the dropped
 * tokens added back and never removed, which produces a very large number and
 * an impossible world: a 2,000-turn session cannot carry a monotonically
 * growing prefix, because the model's own window stops it. Left uncapped, that
 * arithmetic claimed $13,922 of "would have spent" on this corpus against
 * $7,449 actually spent — a 46.5% saving that no one could have realised,
 * because the alternative was not "spend more", it was "the API refuses the
 * request".
 *
 * So the counterfactual is SIMULATED, not extrapolated. Each turn it grows by
 * the growth that turn actually had (or, on a compacting turn, by the session's
 * median growth, since the real delta there is the compaction itself). When it
 * reaches the model's window it compacts, exactly as the harness's own default
 * would have — measured at a median prefix of 965,524 on 1M models. The
 * counterfactual therefore pays for its own compactions too, and those are
 * CREDITED BACK, because a world that compacts late still compacts.
 *
 * What is left is the only thing this can honestly claim: the difference
 * between compacting at a 200k window and compacting at the wall.
 *
 * WHAT IT COSTS, SUBTRACTED HONESTLY. Compaction is not free and this script
 * refuses to hide that. Writing the summary is output tokens on the compacting
 * turn; re-establishing the trimmed prefix is cache-creation on the turn after
 * the boundary. Both are charged against the saving. The headline is NET.
 *
 * THE ONE ASSUMPTION, STATED. This counts the same turns with and without
 * compaction. If working from a summary makes an agent redo work, the turn
 * count rises and the real saving is smaller than this number — a risk measured
 * at a 100k window (a read-heavy task dropped one of eight files). Only a live
 * A/B on $/completed-task can close that gap, and this script prints the
 * assumption next to the total rather than burying it.
 *
 * THE WALL PER MODEL. 1,000,000 tokens for the models that carry a native 1M
 * window, 200,000 otherwise, and never below a prefix the session was actually
 * observed to reach — a session that ran to 529k proves its own window is at
 * least that, whatever the catalog says.
 *
 * DETECTION. A compaction is read from `compactMetadata.preTokens` where the
 * transcript records one, and otherwise from the prefix itself: a drop to under
 * 60% of the previous turn's prefix, from above 50k. Both are reported, so a
 * reader can see how much of the total rests on the heuristic. A `/clear` looks
 * the same to the second rule and is counted the same way, which is correct —
 * the tokens were avoided either way — but it is not attributable to the
 * compaction window, so cleared sessions are flagged.
 *
 * ATTRIBUTION IS BY MECHANISM AND IS NEVER GENEROUS. Only the compaction
 * window has an instrument today. graphify and the memory layer have no
 * measurable effect on this corpus and are reported as "no instrument", never
 * as zero and never folded into the total. A saving with nobody's name on it is
 * not evidence.
 *
 *   node scripts/token-savings.mjs [--roots dirA,dirB] [--json out.json] [--days N]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const ROOTS = (flag('--roots') ?? [process.env.HOME + '/.claude/projects',
  (process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME + '/.claude') + '/projects'].join(',')).split(',');
const JSON_OUT = flag('--json');
const DAYS = Number(flag('--days', '0')) || 0;

/** Per-model rates, USD per million tokens. Cache write is the 1-hour tier (2x base),
 *  which is what every usage record on this node reports. Read 2026-09-15. */
const RATE = {
  'claude-opus-5': { in: 5, out: 25, cr: 0.5, cw: 10 },
  'claude-opus-4-8': { in: 5, out: 25, cr: 0.5, cw: 10 },
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25, cw: 20 },
  'claude-fable-5': { in: 10, out: 50, cr: 1.0, cw: 20 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2, cw: 4 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cr: 0.1, cw: 2 },
};
const rateFor = (m) => RATE[m] ?? RATE[Object.keys(RATE).find((k) => m?.startsWith(k.slice(0, 14)))] ?? null;

const files = [];
for (const root of ROOTS) {
  let ds = []; try { ds = readdirSync(root); } catch { continue; }
  for (const d of ds) {
    let inner = []; try { inner = readdirSync(join(root, d)); } catch { continue; }
    for (const f of inner) if (f.endsWith('.jsonl')) files.push(join(root, d, f));
  }
}

const DROP_RATIO = 0.6, DROP_FLOOR = 50_000;
/** Models with a native 1M window on this node; everything else gets 200k. A
 *  session's own observed peak overrides both — it is proof, not a guess. */
const BIG_WINDOW = /^claude-(opus-5|opus-4-8|fable-5|fable-5-1|sonnet-5)/;
const wallFor = (m, observedPeak) =>
  Math.max(BIG_WINDOW.test(m ?? '') ? 1_000_000 : 200_000, observedPeak);
/** The harness compacts a little before the wall, not at it (window minus a
 *  summary buffer). 0.92 is the measured ratio: a median 965,524 of 1,048,576. */
const WALL_TRIGGER = 0.92;
const median = (xs) => { if (!xs.length) return 0; const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1]; };
let sessions = 0, withCompaction = 0, compactions = 0, fromMarker = 0, fromDrop = 0;
let avoidedTok = 0, avoidedUsd = 0, costUsd = 0, actualUsd = 0, turnsAll = 0;
let cfCompactionsAll = 0, cfCreditUsd = 0, naiveUsd = 0;
const perDay = new Map(), perModel = new Map(), top = [];
const cutoff = DAYS ? Date.now() - DAYS * 864e5 : 0;

for (const f of files) {
  let lines;
  try { if (statSync(f).size > 400e6) continue; lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }

  // One entry per API message: the harness writes a record per content block and
  // repeats the same cumulative usage on each, a 2.09x over-count if summed raw.
  const byId = new Map(), order = [];
  let markerPre = [], lastTs = null, cleared = false;
  for (const line of lines) {
    if (line.length < 40) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.isCompactSummary) cleared = cleared || r?.message?.content === '';
    const pre = r?.compactMetadata?.preTokens ?? r?.compact_metadata?.pre_tokens;
    if (typeof pre === 'number') markerPre.push(pre);
    const u = r?.message?.usage; if (!u) continue;
    const id = r?.message?.id ?? ('L' + order.length);
    if (!byId.has(id)) order.push(id);
    byId.set(id, { u, m: r?.message?.model ?? '?', ts: r?.timestamp ?? lastTs });
    lastTs = r?.timestamp ?? lastTs;
  }
  if (byId.size < 2) continue;
  const stamp = byId.get(order[order.length - 1])?.ts;
  if (cutoff && stamp && Date.parse(stamp) < cutoff) continue;
  sessions++;

  const turns = order.map((id) => {
    const { u, m, ts } = byId.get(id);
    const cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
    const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0;
    return { prefix: cr + cw + inp, cr, cw, inp, out, m, ts };
  });
  turnsAll += turns.length;

  // Actual spend, so the saving can be quoted as a share of a real bill.
  let sessUsd = 0;
  for (const t of turns) {
    const r = rateFor(t.m); if (!r) continue;
    sessUsd += t.inp / 1e6 * r.in + t.out / 1e6 * r.out + t.cr / 1e6 * r.cr + t.cw / 1e6 * r.cw;
  }
  actualUsd += sessUsd;

  // Find the real compactions first: every step down in the prefix.
  const isCompaction = new Array(turns.length).fill(false);
  const growths = [], postSizes = [];
  let sCount = 0, sCostUsd = 0;
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1].prefix, now = turns[i].prefix;
    if (prev > DROP_FLOOR && now < prev * DROP_RATIO && prev - now > 0) {
      isCompaction[i] = true; sCount++; postSizes.push(now);
      if (markerPre.some((p) => Math.abs(p - prev) / prev < 0.15)) fromMarker++; else fromDrop++;
      // What it cost us: the summary written on the compacting turn, and the
      // trimmed prefix re-established as cache on the turn that follows it.
      const rPrev = rateFor(turns[i - 1].m), rNow = rateFor(turns[i].m);
      if (rPrev) sCostUsd += turns[i - 1].out / 1e6 * rPrev.out;
      if (rNow) sCostUsd += turns[i].cw / 1e6 * rNow.cw;
    } else if (now > prev) growths.push(now - prev);
  }
  if (!sCount) continue;

  // Replay the session as it would have run without the early window: the
  // prefix grows the same way, and compacts only when it reaches the wall.
  const peak = Math.max(...turns.map((t) => t.prefix));
  const wall = wallFor(turns[turns.length - 1].m, peak) * WALL_TRIGGER;
  const medGrowth = median(growths);
  const postSize = median(postSizes) || 20_000;
  let cf = turns[0].prefix, sCfCompactions = 0, sCfCreditUsd = 0;
  let sAvoidTok = 0, sAvoidUsd = 0, sNaiveUsd = 0, cumDropped = 0;
  for (let j = 1; j < turns.length; j++) {
    const r = rateFor(turns[j].m);
    const delta = turns[j].prefix - turns[j - 1].prefix;
    cf += isCompaction[j] ? medGrowth : Math.max(0, delta);
    if (cf >= wall) {
      // The world without an early window still hits the wall and still pays
      // to compact there. Credit that cost back rather than pocket it.
      cf = postSize; sCfCompactions++;
      const rPrev = rateFor(turns[j - 1].m);
      if (rPrev) sCfCreditUsd += turns[j - 1].out / 1e6 * rPrev.out;
      if (r) sCfCreditUsd += postSize / 1e6 * r.cw;
    }
    const avoided = Math.max(0, cf - turns[j].prefix);
    sAvoidTok += avoided;
    if (r) sAvoidUsd += avoided / 1e6 * r.cr;
    // The uncapped arithmetic, kept only so the report can show what capping cost.
    if (isCompaction[j]) cumDropped += turns[j - 1].prefix - turns[j].prefix;
    if (r) sNaiveUsd += cumDropped / 1e6 * r.cr;
  }
  cfCompactionsAll += sCfCompactions; cfCreditUsd += sCfCreditUsd; naiveUsd += sNaiveUsd;
  withCompaction++; compactions += sCount;
  // Net compaction cost: what OUR compactions cost, less what the late-compacting
  // world would have paid anyway. A session that compacts twice instead of once
  // is charged for one extra compaction, not for two.
  sCostUsd = Math.max(0, sCostUsd - sCfCreditUsd);
  avoidedTok += sAvoidTok; avoidedUsd += sAvoidUsd; costUsd += sCostUsd;

  const day = (stamp ?? '').slice(0, 10) || 'undated';
  const d = perDay.get(day) ?? { avoid: 0, cost: 0, actual: 0, n: 0 };
  d.avoid += sAvoidUsd; d.cost += sCostUsd; d.actual += sessUsd; d.n++; perDay.set(day, d);
  const mk = (turns[turns.length - 1].m ?? '?').replace('claude-', '');
  const pm = perModel.get(mk) ?? { avoidUsd: 0, costUsd: 0, n: 0 };
  pm.avoidUsd += sAvoidUsd; pm.costUsd += sCostUsd; perModel.set(mk, pm);
  top.push({ file: f.split('/').pop().slice(0, 8), model: mk, turns: turns.length,
    compactions: sCount, avoidUsd: sAvoidUsd, costUsd: sCostUsd, actualUsd: sessUsd, cleared });
}

const net = avoidedUsd - costUsd;
const wouldHave = actualUsd + net;
const pct = wouldHave > 0 ? net / wouldHave * 100 : 0;
const $ = (x) => `$${x.toFixed(2)}`;
const M = (x) => `${(x / 1e6).toFixed(1)}M`;

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), sessions, withCompaction, compactions,
    detection: { fromMarker, fromDrop }, turns: turnsAll,
    avoidedTokens: avoidedTok, avoidedUsd, compactionCostUsd: costUsd, netUsd: net,
    actualUsd, wouldHaveUsd: wouldHave, savedPct: pct,
    byDay: Object.fromEntries([...perDay.entries()].sort()),
    byModel: Object.fromEntries(perModel),
    topSessions: top.sort((a, b) => b.avoidUsd - a.avoidUsd).slice(0, 15),
    mechanisms: {
      compactionWindow: { instrumented: true, netUsd: net },
      graphify: { instrumented: false, reason: 'projection never run on this node; nothing consumes its output' },
      agentMemory: { instrumented: false, reason: 'no memory records the session that wrote it, so re-derivation cannot be counted' },
    },
  }, null, 2) + '\n');
}

console.log(`\n  TOKEN SAVINGS — measured from provider usage, de-duplicated by message.id`);
console.log(`  ${files.length} transcripts · ${sessions} sessions · ${turnsAll} turns${DAYS ? ` · last ${DAYS} days` : ''}`);
console.log(`\n  COMPACTION WINDOW  ${withCompaction}/${sessions} sessions compacted · ${compactions} compactions`);
console.log(`    detection: ${fromMarker} from a recorded boundary · ${fromDrop} from the prefix drop alone`);
console.log(`    counterfactual: the same session compacting only at the wall (${cfCompactionsAll} forced compactions)`);
console.log(`    cache-read avoided      ${M(avoidedTok)} tokens   ${$(avoidedUsd)}`);
console.log(`    compacting cost, net of what the late world would pay anyway   −${$(costUsd)}`);
console.log(`    NET                                            ${$(net)}`);
console.log(`\n    for comparison, the UNCAPPED arithmetic claims ${$(naiveUsd)} — an impossible`);
console.log(`    world where the prefix grows past the context window forever. Not used.`);
console.log(`\n  WOULD HAVE SPENT  ${$(wouldHave)}      ACTUALLY SPENT  ${$(actualUsd)}      SAVED  ${$(net)} (${pct.toFixed(1)}%)`);
console.log(`\n  BY MECHANISM`);
console.log(`    compaction window   ${$(net)}   instrumented`);
console.log(`    graphify            no instrument — the projection has never been run on this node`);
console.log(`    agent memory        no instrument — no memory records the session that wrote it`);
if (perDay.size) {
  console.log(`\n  BY DAY  (sessions that compacted)`);
  for (const [d, v] of [...perDay.entries()].sort().slice(-14))
    console.log(`    ${d}  ${String(v.n).padStart(3)} sessions   saved ${$(v.avoid - v.cost).padStart(9)}   of ${$(v.actual + v.avoid - v.cost)}`);
}
if (top.length) {
  console.log(`\n  BIGGEST SAVINGS`);
  for (const t of top.sort((a, b) => b.avoidUsd - a.avoidUsd).slice(0, 8))
    console.log(`    ${t.file}  ${t.model.padEnd(18)} ${String(t.turns).padStart(4)} turns  ${String(t.compactions).padStart(2)} compactions  net ${$(t.avoidUsd - t.costUsd).padStart(9)}${t.cleared ? '  (includes a /clear)' : ''}`);
}
console.log(`\n  ASSUMPTION: the same turns with and without compaction. If working from a`);
console.log(`  summary makes an agent redo work, the real saving is smaller than this.`);
console.log(`  Only an A/B on dollars per COMPLETED task can close that gap.\n`);
