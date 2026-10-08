import { expect,it,vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import { reloadListPrefix } from './reload-list-prefix';
import { summary,SPACE } from '../data/project/test-support';
it('reloads all previously loaded pages after a placement invalidates the cursor, with filters intact',async()=>{
  const query=vi.fn(async(input)=>({query:input,page:input.cursor ? {items:[summary('c'),summary('d')],nextCursor:'next',total:8} : {items:[summary('a'),summary('b')],nextCursor:'page2',total:8}}));
  const result=await reloadListPrefix(query,{spaceId:SPACE,kinds:['task'],sort:'position',filters:{words:'Test'}},4);
  expect(result.items.map(r=>r.id)).toEqual(['a','b','c','d']);expect(result.nextCursor).toBe('next');
  expect(query.mock.calls.every(([input])=>input.filters.words==='Test' && input.sort==='position')).toBe(true);
});
it('restarts a chain moved again during recovery and never duplicates rows',async()=>{
  let calls=0;
  const query=vi.fn(async(input)=>{
    calls++;if(calls===2)throw new CollabError('invalid_cursor','Moved again');
    return {query:input,page:{items:[summary(calls===1?'old':calls===3?'b':'a')],nextCursor:input.cursor?null:'page2'}};
  });
  const result=await reloadListPrefix(query,{spaceId:SPACE,kinds:['task']},2);
  expect(result.items.map(r=>r.id)).toEqual(['b','a']);
});
