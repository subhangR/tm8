#!/usr/bin/env node
/**
 * session-usage-report — the REAL bill, from provider usage in Claude Code
 * transcripts, one record per message.id.
 *
 * WHY THIS AND NOT THE CLI JOURNAL. The journal's token fields are chars/4 at
 * the CLI boundary and, per packages/contract/src/contract.ts, "can NEVER be
 * presented as the session's token spend" — they were ~1% of real input-side
 * flow when compared. This reads the provider's own `usage` block instead.
 *
 * TWO TRAPS THIS AVOIDS, both of which produced wrong numbers on 2026-09-15:
 *   1. A streamed assistant message is several JSONL lines sharing one
 *      message.id and the same cumulative usage. Summing per line over-counts
 *      by ~2.1x. Dedupe by id, last wins.
 *   2. Cache writes here are on the 1-hour tier (usage.cache_creation shows
 *      ephemeral_1h only), billed at 2x base, not the 1.25x 5-minute rate.
 *
 * Rates are the first-party pricing page as of 2026-09-15 and must be updated
 * by hand; the output names them. Transcript roots are this node's; pass
 * --roots to override. Transcripts are files and get cleaned up (a sibling
 * audit found 46.8% of ended sessions' transcripts gone) — treat totals as a
 * floor for the period, and ratios as the robust part.
 *
 *   node scripts/session-usage-report.mjs [--roots dirA,dirB]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const argv=process.argv.slice(2); const ri=argv.indexOf('--roots');
const ROOTS = ri===-1 ? [process.env.HOME+'/.claude/projects', (process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME+'/.claude')+'/projects'] : argv[ri+1].split(',');
const files=[]; for(const root of ROOTS){let ds=[];try{ds=readdirSync(root)}catch{continue}
 for(const d of ds){let inner=[];try{inner=readdirSync(join(root,d))}catch{continue} for(const f of inner) if(f.endsWith('.jsonl')) files.push(join(root,d,f));}}
const RATE={'claude-opus-5':{in:5,out:25,cr:0.5,cw:10},'claude-opus-4-8':{in:5,out:25,cr:0.5,cw:10},
 'claude-fable-5-1':{in:10,out:50,cr:0.25,cw:20},'claude-fable-5':{in:10,out:50,cr:1.0,cw:20},
 'claude-sonnet-5':{in:2,out:10,cr:0.2,cw:4},'claude-haiku-4-5-20251001':{in:1,out:5,cr:0.1,cw:2}};
const txt=(c)=>typeof c==='string'?c:Array.isArray(c)?c.map(b=>typeof b==='string'?b:(b?.text??b?.content??'')).map(x=>typeof x==='string'?x:JSON.stringify(x)).join(''):JSON.stringify(c??'');
let linesWithUsage=0, msgs=0, sessions=0; const usd={in:0,out:0,cr:0,cw:0}; const byModel=new Map();
let crAll=0, ccAll=0, outAll=0; const BANDS=[50e3,100e3,200e3,500e3,Infinity]; const crBand=new Array(5).fill(0);
const CAPS=[60e3,100e3,150e3]; const saved=new Array(3).fill(0); let over250=0;
let toolRaw=0, toolW=0, tm8W=0; const perSessionUsd=[]; let turnsAll=0;
for(const f of files){
  let lines; try{ if(statSync(f).size>400e6) continue; lines=readFileSync(f,'utf8').split('\n'); }catch{continue}
  const byId=new Map(); const order=[]; const events=[]; const useById=new Map();
  for(const line of lines){ if(line.length<40) continue; let r; try{r=JSON.parse(line)}catch{continue}
    if(r?.type==='assistant'||r?.type==='user') events.push(r);
    if(r?.type==='assistant'&&Array.isArray(r?.message?.content)) for(const b of r.message.content) if(b?.type==='tool_use'&&b.id) useById.set(b.id,{name:b.name,input:b.input});
    const u=r?.message?.usage; if(!u) continue; linesWithUsage++;
    const id=r?.message?.id??('L'+linesWithUsage); if(!byId.has(id)) order.push(id); byId.set(id,{u,m:r?.message?.model??'?'});
  }
  if(byId.size<2) continue;
  sessions++; let sessUsd=0, maxPrefix=0, first=null;
  for(const id of order){ const {u,m}=byId.get(id); msgs++; turnsAll++;
    const cr=u.cache_read_input_tokens??0, cc=u.cache_creation_input_tokens??0, inp=u.input_tokens??0, out=u.output_tokens??0;
    const prefix=cr+cc+inp; if(first===null) first=prefix; if(prefix>maxPrefix) maxPrefix=prefix;
    crAll+=cr; ccAll+=cc; outAll+=out;
    crBand[BANDS.findIndex(x=>prefix<x)]+=cr; for(let i=0;i<3;i++) if(cr>CAPS[i]) saved[i]+=cr-CAPS[i];
    const rate=RATE[m]; if(rate){ const c=inp/1e6*rate.in+out/1e6*rate.out+cr/1e6*rate.cr+cc/1e6*rate.cw; sessUsd+=c;
      usd.in+=inp/1e6*rate.in; usd.out+=out/1e6*rate.out; usd.cr+=cr/1e6*rate.cr; usd.cw+=cc/1e6*rate.cw; byModel.set(m,(byModel.get(m)??0)+c); } }
  perSessionUsd.push(sessUsd); if(maxPrefix>250000) over250++;
  // weighted tool results: turns remaining = DISTINCT assistant message ids after position i
  const asstIdAt=events.map(e=>e.type==='assistant'?(e.message?.id??null):null);
  const seenAfter=new Array(events.length+1).fill(0); const seen=new Set();
  for(let i=events.length-1;i>=0;i--){ const id=asstIdAt[i]; if(id&&!seen.has(id)) seen.add(id); seenAfter[i]=seen.size; }
  for(let i=0;i<events.length;i++){ const c=events[i]?.message?.content; if(!Array.isArray(c)) continue;
    for(const blk of c){ if(blk?.type!=='tool_result') continue; const s=txt(blk.content); const est=Math.round(s.length/4); if(est<=0) continue;
      const w=est*seenAfter[i+1]; toolRaw+=est; toolW+=w;
      const use=useById.get(blk.tool_use_id); const cmd=String(use?.input?.command??'');
      if(/"spaceId"\s*:|"activityAt"\s*:|"schemaVersion"\s*:\s*"tm8\.|\[journal: ~/.test(s)||(use?.name==='Bash'&&/(^|\s)tm8(\s|$)/.test(cmd))) tm8W+=w; } }
}
const M=x=>`${(x/1e6).toFixed(1)}M`, P=(a,b)=>`${(a/b*100).toFixed(1)}%`; const tot=usd.in+usd.out+usd.cr+usd.cw;
perSessionUsd.sort((a,b)=>a-b); const q=p=>perSessionUsd[Math.floor(perSessionUsd.length*p)];
console.log(`\n  DEDUPED BY message.id — lines with usage ${linesWithUsage} → distinct messages ${msgs} (over-count factor ${(linesWithUsage/msgs).toFixed(2)}x)`);
console.log(`  sessions ${sessions} · turns ${turnsAll} (mean ${(turnsAll/sessions).toFixed(0)}) · cache_read ${M(crAll)} · cache_write ${M(ccAll)} · output ${M(outAll)}`);
console.log(`\n  BILL  uncached $${usd.in.toFixed(0)} (${P(usd.in,tot)}) · cache write $${usd.cw.toFixed(0)} (${P(usd.cw,tot)}) · cache read $${usd.cr.toFixed(0)} (${P(usd.cr,tot)}) · output $${usd.out.toFixed(0)} (${P(usd.out,tot)})`);
console.log(`  TOTAL $${tot.toFixed(0)} → mean $${(tot/sessions).toFixed(2)}/session · median $${q(.5).toFixed(2)} · p90 $${q(.9).toFixed(2)} · max $${perSessionUsd[perSessionUsd.length-1].toFixed(0)}`);
console.log(`  by model: `+[...byModel.entries()].sort((a,b)=>b[1]-a[1]).map(([m,v])=>`${m.replace('claude-','')} $${v.toFixed(0)}`).join(' · '));
console.log(`\n  CACHE_READ BY PREFIX BAND  <50k ${P(crBand[0],crAll)} · 50-100k ${P(crBand[1],crAll)} · 100-200k ${P(crBand[2],crAll)} · 200-500k ${P(crBand[3],crAll)} · >500k ${P(crBand[4],crAll)}`);
console.log(`  cap prefix at 60k → −${P(saved[0],crAll)} · 100k → −${P(saved[1],crAll)} · 150k → −${P(saved[2],crAll)} of cache_read`);
console.log(`  sessions ever above 250k prefix: ${over250}/${sessions} (${P(over250,sessions)})`);
console.log(`\n  TOOL RESULTS raw ${M(toolRaw)} · weighted ${M(toolW)} = ${P(toolW,crAll)} of cache_read (multiplier ${(toolW/toolRaw).toFixed(0)}x) · tm8 share ${P(tm8W,crAll)}\n`);
