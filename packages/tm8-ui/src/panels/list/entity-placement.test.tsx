// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityListPanel } from '../EntityListPanel';
import { createFixtureSeam } from '../../data/fixtures/seam-fixture';
import { getKind } from '../../domain';
import { createDomainStore, projectRows } from '../../data/project/domain-store';
import { detail, event, SPACE, summary } from '../../data/project/test-support';
import { placementAction, useEntityPlacement, validPlacement } from './useEntityPlacement';
import type { EntitySummary } from '@tm8/contract';

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
const a = summary('a',{position:0}); const b=summary('b',{position:1024});
const child=summary('child',{parentId:a.id,position:0});

function Harness({ move = vi.fn().mockResolvedValue(undefined), click = vi.fn(), rows = [a,b,child] }: { move?: ReturnType<typeof vi.fn>; click?: ReturnType<typeof vi.fn>; rows?: EntitySummary[] }) {
  const placement=useEntityPlacement({rows,selectedId:b.id,canMove:()=>true,move});
  return <div ref={placement.root}>{placement.controls}{rows.map((row,i)=><div key={row.id} data-placement-row={row.id} tabIndex={0}>
    <div data-testid={`card-${row.id}`} onClick={click} ref={(element)=>{
      if(element) element.getBoundingClientRect=()=>({top:i*100,bottom:i*100+80,left:0,right:300,width:300,height:80,x:0,y:i*100,toJSON:()=>({})});
    }}>{row.title}<button>Existing control</button></div>
  </div>)}</div>;
}
function pointer(target: Element|Window,type:string,x:number,y:number) {
  const e=new Event(type,{bubbles:true,cancelable:true});
  Object.assign(e,{pointerId:1,button:0,clientX:x,clientY:y}); fireEvent(target,e);
}

describe('placement interaction on unchanged cards',()=>{
  it('quick clicks open, scroll cancels pickup, controls never pick up, and long press drops relative to the target',async()=>{
    vi.useFakeTimers(); const move=vi.fn().mockResolvedValue(undefined); const click=vi.fn();
    render(<Harness move={move} click={click}/>);
    const card=screen.getByTestId('card-b');
    pointer(card,'pointerdown',50,130); pointer(window,'pointerup',50,130); fireEvent.click(card); expect(click).toHaveBeenCalledTimes(1);
    pointer(card,'pointerdown',50,130); pointer(window,'pointermove',50,141); act(()=>vi.advanceTimersByTime(500)); pointer(window,'pointerup',50,10); expect(move).not.toHaveBeenCalled();
    pointer(card.querySelector('button')!,'pointerdown',50,130); act(()=>vi.advanceTimersByTime(500)); pointer(window,'pointerup',50,10); expect(move).not.toHaveBeenCalled();
    pointer(card,'pointerdown',50,130); act(()=>vi.advanceTimersByTime(450)); fireEvent.contextMenu(card); pointer(window,'pointermove',50,10); pointer(window,'pointerup',50,10); fireEvent.click(card);
    expect(move).toHaveBeenCalledWith(b,{targetId:a.id,relation:'before'}); expect(click).toHaveBeenCalledTimes(1);
    await act(async()=>{});
  });
  it.each(['pointercancel','blur','escape'])('cancels long press on %s',async(reason)=>{
    vi.useFakeTimers(); const move=vi.fn().mockResolvedValue(undefined); render(<Harness move={move}/>);
    pointer(screen.getByTestId('card-b'),'pointerdown',50,130); act(()=>vi.advanceTimersByTime(450)); pointer(window,'pointermove',50,10);
    if(reason==='escape') fireEvent.keyDown(window,{key:'Escape'}); else fireEvent(window,new Event(reason));
    pointer(window,'pointerup',50,10); expect(move).not.toHaveBeenCalled();
  });
  it('offers keyboard and menu moves, excludes descendants and reports refusal without rearranging cards',async()=>{
    const move=vi.fn().mockRejectedValue(new Error('Changed by another user'));
    const {container}=render(<Harness move={move}/>);
    fireEvent.keyDown(container.querySelector('[data-placement-row="b"]')!,{key:'ArrowRight',altKey:true});
    await act(async()=>{}); expect(move).toHaveBeenCalledWith(b,{targetId:a.id,relation:'inside'});
    expect(screen.getByRole('status').textContent).toContain('Changed by another user');
    fireEvent.click(screen.getByRole('button',{name:'Move selected…'}));
    expect(screen.getByRole('button',{name:'Indent'})).toBeTruthy(); expect(screen.getByRole('button',{name:'Outdent'})).toBeTruthy();
    expect(validPlacement([a,b,child],a,child)).toBe(false);
    expect(placementAction([a,b,child],child,'outdent')).toEqual({targetId:a.id,relation:'after'});
    expect([...container.querySelectorAll('[data-placement-row]')].map(n=>n.getAttribute('data-placement-row'))).toEqual(['a','b','child']);
  });
  it('defaults to the All position view and preserves the exact production card markup when movement is enabled',()=>{
    const rowsFor=vi.fn(()=>[a,b]);
    const props={kind:'task',rowsFor,ctx:{spaceId:SPACE},capabilitiesOf:()=>({...detail('a').capabilities,canMove:true})};
    const view=render(<EntityListPanel {...props}/>);
    const cards=[...view.container.querySelectorAll('[data-testid="list-tile"]')].map(n=>n.outerHTML);
    expect(cards.length).toBe(2);
    view.rerender(<EntityListPanel {...props} onMoveEntity={async()=>{}}/>);
    expect([...view.container.querySelectorAll('[data-testid="list-tile"]')].map(n=>n.outerHTML)).toEqual(cards);
    expect(rowsFor.mock.calls.some((args:unknown[])=>args[1]==='position')).toBe(true);
    expect(getKind('work_session').list.defaultCategory).toBe('all');
  });
});

describe('independent client projections',()=>{
  it('both clients reorder loaded pages on a placement upsert and keep that order through status/activity updates and filtering',()=>{
    const subscribers=new Set<(e:ReturnType<typeof event>)=>void>();
    const seam={onEvent:(fn:(e:ReturnType<typeof event>)=>void)=>{subscribers.add(fn);return()=>{subscribers.delete(fn);};}};
    const clients=[createDomainStore(seam,{batchWindowMs:0}),createDomainStore(seam,{batchWindowMs:0})];
    for(const client of clients) client.store.getState().ingestSummaries([a,b,child]);
    const rows=(client:typeof clients[number],filter?:unknown)=>projectRows({ordered:['a','b','child'],entities:client.store.getState().entities,spaceId:SPACE,kind:'task',filter:filter as never});
    const moved={...b,position:-1024,version:2};
    // Deliver one durable upsert through two independent seam subscriptions.
    expect(subscribers.size).toBe(2);
    for(const receive of subscribers) receive(event('entity.upsert',{entity:moved}));
    expect(clients.map(c=>rows(c).map(r=>r.id))).toEqual([['b','a','child'],['b','a','child']]);
    for(const receive of subscribers) receive(event('entity.upsert',{entity:{...a,version:2,activityAt:'2099-01-01T00:00:00.000Z',state:{...a.state,status:'done'} as EntitySummary['state']}}));
    for(const client of clients){
      expect(rows(client).map(r=>[r.id,r.position,r.parentId])).toEqual([['b',-1024,null],['a',0,null],['child',0,'a']]);
      expect(rows(client,{status:['open']}).map(r=>r.id)).toEqual(['b','child']); client.dispose();
    }
  });
});

// Keep the local development seam faithful to the database insertion contract.
it('fixture roots and children also prepend in deterministic manual order',async()=>{
  const seam=createFixtureSeam(); const spaceId=(await seam.spaces())[0]!.id;
  const create=async(title:string,parentId?:EntitySummary['id'])=>(await seam.commands.createEntity({spaceId,kind:'task',title,parentId})).entity!;
  const root=await create('Placement parent'); const newer=await create('Placement new root');
  const first=await create('Placement first child',root.id); const second=await create('Placement second child',root.id);
  const rows=(await seam.query({spaceId,kinds:['task'],limit:500})).page.items;
  expect(rows.filter(r=>r.parentId===null).slice(0,2).map(r=>r.id)).toEqual([newer.id,root.id]);
  expect(rows.filter(r=>r.parentId===root.id).map(r=>r.id)).toEqual([second.id,first.id]);
});
