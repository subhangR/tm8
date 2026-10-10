import { describe, it, expect } from 'vitest';
import { projectHistory, sameCoverage, type HistoricalTurn } from '../src/chat/continuity.js';
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
  it('reduces deterministically within budget and cites omitted details',() => {
    const input=turn(1,{input:{body:'x'.repeat(50000)}});
    const a=projectHistory([input],{...options,maxBytes:2048});
    const b=projectHistory([input],{...options,maxBytes:2048});
    expect(a).toEqual(b); expect(Buffer.byteLength(a.renderedContext)).toBeLessThanOrEqual(2048);
    expect(a.manifest.some(x => x.treatment==='summarized')).toBe(true);
  });
  it('ignores excluded future-input capture changes for semantic resume equality',() => {
    const a=projectHistory([turn(1)],options).coverage;
    expect(sameCoverage(a,{...a,captureHighWater:100})).toBe(true);
    expect(sameCoverage(a,{...a,authorityScopeDigest:'other'})).toBe(false);
  });
});
