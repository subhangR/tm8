import { describe, it, expect } from 'vitest';
import { HISTORY_PART_WINDOW, HISTORY_TURN_WINDOW, SNAPSHOT_SEAL_BYTES, projectHistory, readPortableHistory, sameCoverage, type HistoricalTurn } from '../src/chat/continuity.js';
import type { Db } from '../src/db/types.js';
const turn=(ordinal:number,overrides:Partial<HistoricalTurn>={}):HistoricalTurn => ({turnId:`t${ordinal}`,ordinal,
  userMessageId:`u${ordinal}`,agentMessageId:`a${ordinal}`,input:{body:`request ${ordinal}`,attachments:['image-ref'],actorId:'member'},
  assistantBody:'duplicate body',parts:[{seq:0,kind:'text',payload:{text:'answer'}}],state:'completed',failure:null,model:'recorded-model',...overrides});
const options={snapshotId:'snapshot',currentTurnOrdinal:2,captureHighWater:9,authorityScopeDigest:'authority',maxBytes:16000};
describe('portable history',() => {
  it('excludes current/future queued input, emits earlier body once and retains source attribution',() => {
    const result=projectHistory([turn(3),turn(1),turn(2)],options);
    expect(result.renderedContext).toContain('request 1');
    expect(result.renderedContext).not.toContain('request 2');
    expect(result.renderedContext).not.toContain('request 3');
    expect(result.renderedContext).not.toContain('duplicate body');
    expect(result.renderedContext).toContain('image-ref');
    expect(result.renderedContext).toContain('member');
    expect(result.coverage.throughTurnOrdinal).toBe(1);
  });
  it('folds replacement snapshots without duplicating text',() => {
    const result=projectHistory([turn(1,{parts:[
      {seq:0,kind:'text',payload:{itemId:'x',revision:1,operation:'append',text:'hel'}},
      {seq:1,kind:'text',payload:{itemId:'x',revision:2,operation:'append',text:'lo'}},
      {seq:2,kind:'text',payload:{itemId:'x',revision:3,operation:'replace',text:'hello!'}},
    ]})],options);
    expect(result.renderedContext).toContain('hello!');
    expect(result.renderedContext).not.toContain('hellohello');
  });
  it('folds tool observations as inert evidence and preserves unknown effects',() => {
    const result=projectHistory([turn(1,{state:'error',failure:{code:'delivery_unknown'},parts:[
      {seq:0,kind:'tool_call',payload:{id:'call',name:'shell',args:{cmd:'change'},state:'running'}},
      {seq:1,kind:'tool_call',payload:{id:'call',name:'shell',args:{cmd:'change'},state:'completed'}},
      {seq:2,kind:'tool_result',payload:{tool_call_id:'call',content:'done',is_error:false}},
      {seq:3,kind:'tool_call',payload:{id:'unknown',name:'write',args:{},state:'running'}},
    ]})],options);
    expect(result.manifest.filter(x => x.sourceId.includes(':tool:'))).toHaveLength(2);
    expect(result.renderedContext).toContain('"executable":false');
    expect(result.renderedContext).toContain('effect_unknown');
    expect(result.renderedContext).toContain('delivery_unknown');
  });
  it("keeps a failure's operator detail out of the next turn's context",() => {
    const result=projectHistory([turn(1,{state:'error',failure:{code:'preparation_failed',message:'Chat runtime could not prepare this turn.',
      detail:{step:'launch preparation',error:{name:'Error',message:'operator-only internals'}}}})],options);
    expect(result.renderedContext).toContain('preparation_failed');
    expect(result.renderedContext).toContain('Chat runtime could not prepare this turn.');
    expect(result.renderedContext).not.toContain('operator-only internals');
    expect(result.renderedContext).not.toContain('launch preparation');
  });
  it('reduces deterministically within budget and cites omitted details',() => {
    const input=turn(1,{input:{body:'x'.repeat(50000)}});
    const a=projectHistory([input],{...options,maxBytes:2048});
    const b=projectHistory([input],{...options,maxBytes:2048});
    expect(a).toEqual(b); expect(Buffer.byteLength(a.renderedContext)).toBeLessThanOrEqual(2048);
    expect(a.manifest.some(x => x.treatment==='summarized')).toBe(true);
  });
  it('drops the oldest turns behind one notice when a long chat outgrows the budget (prod craft chat, 2026-10-18)',() => {
    // 60 turns x 40 tool calls: even the smallest extract keeps a source ref per
    // record, so shrinking alone cannot fit 32KB. Every turn used to fail with
    // continuity_context_overflow ("Chat runtime could not prepare this turn").
    const calls=(ordinal:number)=>Array.from({length:40},(_,i)=>[
      {seq:i*2,kind:'tool_call',payload:{id:`c${ordinal}-${i}`,name:'shell',args:{cmd:'x'.repeat(300)},state:'completed'}},
      {seq:i*2+1,kind:'tool_result',payload:{tool_call_id:`c${ordinal}-${i}`,content:'y'.repeat(600),is_error:false}},
    ]).flat();
    const turns=Array.from({length:60},(_,i)=>turn(i+1,{parts:[{seq:999,kind:'text',payload:{text:`answer ${i+1}`}},...calls(i+1)]}));
    const result=projectHistory(turns,{...options,currentTurnOrdinal:61,maxBytes:32768});
    expect(Buffer.byteLength(result.renderedContext)).toBeLessThanOrEqual(32768);
    expect(result.renderedContext).toContain('omittedTurns');
    expect(result.renderedContext).toContain('request 60');
    expect(result.renderedContext).not.toContain('"request 1"');
    expect(result.manifest.some(x => x.treatment==='reference' && x.sourceId==='u1')).toBe(true);
    expect(result.coverage.throughTurnOrdinal).toBe(60);
    expect(projectHistory(turns,{...options,currentTurnOrdinal:61,maxBytes:32768})).toEqual(result);
  });
  it('keeps the sealed snapshot under the DB cap when thousands of tool records are dropped (UHN AI main chat, 2026-11-08)',() => {
    // The full read window (256 turns x 16 tool parts = 4096) used to put one
    // manifest row per dropped record in the bootstrap: ~560 KB against
    // seal_chat_turn_snapshot's 256 KiB, so every turn failed "snapshot seal failed".
    const calls=(ordinal:number)=>Array.from({length:8},(_,i)=>[
      {seq:i*2,kind:'tool_call',payload:{id:`toolu_${ordinal}_${i}_${'k'.repeat(24)}`,name:'Bash',args:{command:'ls'}}},
      {seq:i*2+1,kind:'tool_result',payload:{tool_call_id:`toolu_${ordinal}_${i}_${'k'.repeat(24)}`,content:'y'.repeat(200)}},
    ]).flat();
    const id=(prefix:string,n:number)=>`${prefix}${String(n).padStart(35,'0')}`;
    const turns=Array.from({length:256},(_,i)=>turn(i+1,{userMessageId:id('u',i+1),agentMessageId:id('a',i+1),parts:calls(i+1)}));
    const result=projectHistory(turns,{...options,currentTurnOrdinal:257,maxBytes:32768});
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(SNAPSHOT_SEAL_BYTES);
    const references=result.manifest.filter(x => x.treatment==='reference');
    expect(references.length).toBeGreaterThan(0);
    expect(references.every(x => x.sourceId.startsWith('u'))).toBe(true);
    expect(new Set(references.map(x => x.sourceId)).size).toBe(references.length);
  });
  it('ignores excluded future-input capture changes for semantic resume equality',() => {
    const a=projectHistory([turn(1)],options).coverage;
    expect(sameCoverage(a,{...a,captureHighWater:100})).toBe(true);
    expect(sameCoverage(a,{...a,authorityScopeDigest:'other'})).toBe(false);
  });
  it('labels requested model and storage excerpts honestly and omits private bearer-row provenance',()=>{
    const result=projectHistory([turn(1,{input:{body:'prior input',authSessionId:'private-human-session'},parts:[
      {seq:0,kind:'text',payload:{text:'excerpt',omittedDetail:true,sourceRef:'a1:part:0'}},
    ]})],options);
    expect(result.renderedContext).toContain('requested_only');
    expect(result.renderedContext).toContain('"observedModel":null');
    expect(result.renderedContext).not.toContain('private-human-session');
    expect(result.manifest.find(row=>row.sourceId==='a1')?.treatment).toBe('summarized');
  });

  it('reads a long chat as its newest window instead of refusing every later turn (readyai-main went silent, 2026-10-24)',async () => {
    // 300 turns x 40 assistant parts: past BOTH read windows. The read used to
    // throw `continuity_unavailable`, so every new message to the chat failed in
    // "history read" and the WhatsApp bridge only ever saw "no reply yet".
    const total=300; const perMessage=40; const queries:string[]=[];
    const rows=Array.from({length:total},(_,i)=>({turn_id:`t${i+1}`,turn_ordinal:String(i+1),user_message_id:`u${i+1}`,
      agent_message_id:`a${i+1}`,input_snapshot:null,user_body:`request ${i+1}`,attachments:[],author_id:'member',
      assistant_body:`answer ${i+1}`,assistant_available:true,assistant_edited:false,user_available:true,state:'completed',failure:null,model:'m'}));
    const limitOf=(sql:string)=>Number(/limit (\d+)/.exec(sql)![1]);
    const db={tx:async(_claims:unknown,fn:(q:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,params:unknown[])=>{
      queries.push(sql);
      if (sql.includes('count(*)')) return [{count:String(rows.filter(r=>Number(r.turn_ordinal)<Number(params[1])).length)}];
      if (sql.includes('from public.chat_turns t')) {
        expect(sql).toContain('order by t.turn_ordinal desc');
        return rows.filter(r=>Number(r.turn_ordinal)<Number(params[1])).reverse().slice(0,limitOf(sql));
      }
      const ids=params[0] as string[];
      return ids.flatMap(id=>Array.from({length:perMessage},(_,seq)=>({message_id:id,seq,kind:seq===0 ? 'text' : 'tool_call',
        payload:seq===0 ? {text:`text of ${id}`} : {id:`${id}-c${seq}`,name:'shell',args:{},state:'completed'}}))).slice(0,limitOf(sql));
    }})} as unknown as Db;
    const turns=await readPortableHistory(db,{identityId:'member'},'chat',total+1,1000);
    expect(turns).toHaveLength(HISTORY_TURN_WINDOW);
    expect(turns[0]!.ordinal).toBe(total-HISTORY_TURN_WINDOW+1);
    expect(turns[0]!.omittedEarlierTurns).toBe(total-HISTORY_TURN_WINDOW);
    expect(turns.at(-1)!.ordinal).toBe(total);
    // The newest messages keep every part; the one the part window cut through
    // and everything older keep their bodies with an explicit omission notice.
    const full=Math.floor(HISTORY_PART_WINDOW/perMessage);
    expect(turns.at(-1)!.parts).toHaveLength(perMessage);
    expect(turns.find(t=>t.ordinal===total-full+1)!.parts).toHaveLength(perMessage);
    const cut=turns.find(t=>t.ordinal===total-full)!;
    expect(cut.parts).toEqual([]); expect(cut.assistantNotice).toMatch(/omitted/);
    expect(turns[0]!.parts).toEqual([]);
    const projected=projectHistory(turns,{...options,currentTurnOrdinal:total+1,maxBytes:32768});
    expect(projected.renderedContext).toContain('request 300');
    expect(projected.renderedContext).toContain('omittedTurns');
    expect(projected.renderedContext).not.toContain('"request 1"');
    expect(Buffer.byteLength(projected.renderedContext)).toBeLessThanOrEqual(32768);
  });
  it('reads a short chat whole, with no omission notice',async () => {
    const rows=[1,2].map(n=>({turn_id:`t${n}`,turn_ordinal:String(n),user_message_id:`u${n}`,agent_message_id:`a${n}`,input_snapshot:null,
      user_body:`request ${n}`,attachments:[],author_id:'member',assistant_body:`answer ${n}`,assistant_available:true,assistant_edited:false,
      user_available:true,state:'completed',failure:null,model:'m'}));
    let counted=false;
    const db={tx:async(_c:unknown,fn:(q:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,params:unknown[])=>{
      if (sql.includes('count(*)')) { counted=true; return [{count:'0'}]; }
      if (sql.includes('from public.chat_turns t')) return [...rows].reverse();
      return (params[0] as string[]).map(id=>({message_id:id,seq:0,kind:'text',payload:{text:`text of ${id}`}}));
    }})} as unknown as Db;
    const turns=await readPortableHistory(db,{identityId:'member'},'chat',3,1000);
    expect(turns.map(t=>t.ordinal)).toEqual([1,2]);
    expect(turns.map(t=>t.parts.length)).toEqual([1,1]);
    expect(turns[0]!.omittedEarlierTurns).toBeUndefined(); expect(turns[0]!.assistantNotice).toBeNull();
    expect(counted).toBe(false);
  });
});

