import { describe, expect, it } from 'vitest';
import type { MapModel, MapPlace } from './map-model';
import { emptyTasklandMotion, reconcileTasklandMotion, sampleTasklandPlace, sampleTasklandTransition, suppressedTasklandPlaces,
  type TasklandMotionInput, type TasklandMotionEffect } from './taskland-motion';

function place(id: string, x: number, z = 0, parentId: string | null = null, status = 'working'): MapPlace {
  return { id, entityId: id, kind: 'task', title: id, x, z, parentId, depth: parentId ? 1 : 0, groupId: status,
    radius: 1, footprint: 1, compoundBounds: { minX:x-1,maxX:x+1,minZ:z-1,maxZ:z+1 }, status, progress: .5,
    constructionStage:'walls', workStatus:status, role:'entity', assetKey:'task.working', label:id, badges:[], mailbox:null, attention:0 };
}
function model(places: MapPlace[], type: MapModel['type'] = 'taskland'): MapModel {
  return { id:type, type, scope:{kind:'story',id:'story'}, places, groups:[],roads:[],paths:[],robots:[],decor:[],portals:[],
    bounds:{minX:-10,maxX:50,minZ:-20,maxZ:30},layout:{containers:{}},warnings:[] };
}
function effect(id: number, ...changes: [string,string,string][]): TasklandMotionEffect {
  return { id, taskEvents:changes.map(([taskId,from,to]) => ({type:'task.status_changed',taskId,from,to})) };
}
function plan(previousModel: MapModel, current: MapModel, update: TasklandMotionEffect, extra: Partial<TasklandMotionInput> = {}) {
  const input = {previousModel, model:current, effect:update, ...extra};
  return reconcileTasklandMotion(emptyTasklandMotion(input),input,0);
}
describe('Taskland authoritative motion planner', () => {
  it('carries a root compound and preserves relative footprints without moving its neighbour', () => {
    const previous = model([place('root',0),place('child',3,2,'root'),place('grandchild',4,4,'child'),place('other',30)]);
    const current = model([place('root',12,0,null,'in_review'),place('child',15,2,'root'),place('grandchild',16,4,'child'),place('other',30)]);
    const saved = JSON.stringify([previous,current]);
    const state = plan(previous,current,effect(1,['root','working','in_review']));
    expect(state.transitions).toHaveLength(1);
    expect([...suppressedTasklandPlaces(state.transitions)]).toEqual(['root','child','grandchild']);
    const frame = sampleTasklandTransition(state.transitions[0]!,state.transitions[0]!.duration/2);
    expect(frame.members.map(m => m.position)).toEqual([{x:6,z:0},{x:9,z:2},{x:10,z:4}]);
    expect(JSON.stringify([previous,current])).toBe(saved);
  });
  it('moves only a nested compound in the parent mini-yard', () => {
    const previous = model([place('root',0),place('child',3,2,'root'),place('grand',4,4,'child'),place('sibling',-4,2,'root')]);
    const current = model([place('root',0),place('child',7,2,'root','blocked'),place('grand',8,4,'child'),place('sibling',-4,2,'root')]);
    const state=plan(previous,current,effect(2,['child','working','blocked']));
    expect(state.transitions[0]!.members.map(m=>m.place.id)).toEqual(['child','grand']);
    expect([...suppressedTasklandPlaces(state.transitions)]).toEqual(['child','grand']);
  });
  it('ships root and done child independently while keeping markers and open children visible', () => {
    const previous = model([place('root',0),place('done-child',3,2,'root'),place('open-child',-3,2,'root')]);
    const marker={...place('root',0,0,null,'done'),role:'shipped-marker' as const,constructionStage:'shipped-marker' as const};
    const current=model([marker,place('open-child',-3,2,'root')]);
    const state=plan(previous,current,effect(3,['root','working','done'],['done-child','working','done']));
    expect(state.transitions.map(t=>[t.kind,t.members.map(m=>m.place.id)])).toEqual([['ship-out',['root']],['ship-out',['done-child']]]);
    expect(suppressedTasklandPlaces(state.transitions).size).toBe(0);
    expect(state.transitions.every(t=>t.to.x > current.bounds.maxX)).toBe(true);
  });
  it('never carries the open family on a lone done child shipment', () => {
    const previous=model([place('root',0),place('child',3,2,'root'),place('open-grand',4,4,'child')]);
    const current=model([place('root',0),{...place('child',3,2,'root','done'),role:'shipped-marker'},place('open-grand',4,4,'child')]);
    const state=plan(previous,current,effect(4,['child','working','done']));
    expect(state.transitions[0]!.members.map(m=>m.place.id)).toEqual(['child']);
    expect([...suppressedTasklandPlaces(state.transitions)]).toEqual([]);
  });
  it('arrives at independent authoritative Town lots through the stable yard, including admitted products', () => {
    const previous=model([place('placed',25)],'town');
    const current={...model([place('placed',25),place('root',3,0,null,'done'),place('child',8,0,null,'done'),
      {...place('product',12),kind:'artifact',status:null}], 'town'),shippingYard:{position:{x:0,z:-12},waitingIds:['root','child','product']}};
    const state=plan(previous,current,effect(5,['root','working','done'],['child','working','done']));
    expect(state.transitions.map(t=>t.entityId)).toEqual(['root','child','product']);
    expect(state.transitions.every(t=>t.kind==='ship-in' && t.from.x===0 && t.from.z===-12 && t.members.length===1)).toBe(true);
    expect(state.transitions.map(t=>t.to.x)).toEqual([3,8,12]);
  });
  it('collapses the previous building over current rubble without suppressing the rubble', () => {
    const previous=model([place('root',0)]),current=model([{...place('root',0,0,null,'cancelled'),constructionStage:'rubble'}]);
    const state=plan(previous,current,effect(6,['root','working','cancelled']));
    const transition=state.transitions[0]!;
    expect(transition.kind).toBe('collapse');
    expect(transition.members[0]!.place.constructionStage).toBe('walls');
    expect(suppressedTasklandPlaces(state.transitions).size).toBe(0);
    expect(sampleTasklandTransition(transition,450).height).toBeCloseTo(.5);
  });
  it('shows immediate current state on reduced motion, map switch and recovery reads', () => {
    const previous=model([place('root',0)]),current=model([place('root',10,0,null,'blocked')]),update=effect(7,['root','working','blocked']);
    const active=plan(previous,current,update);
    for(const extra of [{reducedMotion:true},{previousModel:null},{resetKey:'new-route'},{model:model([],'town')}]) {
      expect(reconcileTasklandMotion(active,{previousModel:previous,model:current,effect:update,...extra},500).transitions).toEqual([]);
    }
  });
  it('coalesces a burst by final facts and never replays repeated or stale effects', () => {
    const previous=model([place('root',0)]),current=model([place('root',10,0,null,'in_review')]);
    const update=effect(8,['root','working','blocked'],['root','blocked','in_review']);
    const state=plan(previous,current,update);
    expect(state.transitions).toHaveLength(1);
    const repeated=reconcileTasklandMotion(state,{previousModel:previous,model:current,effect:update},400);
    expect(repeated.transitions[0]!.startedAt).toBe(0);
    const finished={...state,transitions:[]};
    expect(reconcileTasklandMotion(finished,{previousModel:previous,model:current,effect:update},400).transitions).toEqual([]);
    expect(reconcileTasklandMotion(state,{previousModel:previous,model:current,effect:effect(7,['root','working','blocked'])},400).transitions).toEqual([]);
    expect(plan(previous,previous,effect(9,['root','working','blocked'],['root','blocked','working'])).transitions).toEqual([]);
  });
  it('retargets interrupted carts from their displayed positions rather than replaying the old route', () => {
    const previous=model([place('root',0)]),middle=model([place('root',10,0,null,'blocked')]),next=model([place('root',20,0,null,'in_review')]);
    const active=plan(previous,middle,effect(10,['root','working','blocked']));
    const instant=active.transitions[0]!.duration/2;
    const displayed=sampleTasklandTransition(active.transitions[0]!,instant).members[0]!.position;
    const interrupted=reconcileTasklandMotion(active,{previousModel:middle,model:next,effect:effect(11,['root','blocked','in_review'])},instant);
    expect(interrupted.transitions).toHaveLength(1);
    expect(interrupted.transitions[0]!.from).toEqual(displayed);
    expect(sampleTasklandTransition(interrupted.transitions[0]!,instant).members[0]!.position).toEqual(displayed);
  });
  it('keeps unaffected cargo moving when a nested status interrupts a parent cart', () => {
    const previous=model([place('root',0),place('child',3,2,'root'),place('sibling',-3,2,'root')]);
    const middle=model([place('root',10,0,null,'blocked'),place('child',13,2,'root'),place('sibling',7,2,'root')]);
    const next=model([middle.places[0]!,place('child',15,2,'root','in_review'),middle.places[2]!]);
    const active=plan(previous,middle,effect(12,['root','working','blocked']));
    const interrupted=reconcileTasklandMotion(active,{previousModel:middle,model:next,effect:effect(13,['child','working','in_review'])},500);
    expect(interrupted.transitions.map(t=>t.members.map(m=>m.place.id))).toEqual([['root','sibling'],['child']]);
    expect(interrupted.transitions[0]!.startedAt).toBe(0);
  });
  it('disposes motion on changed authoritative targets and reversal instead of inventing a placement', () => {
    const previous=model([place('root',0)]),current=model([place('root',10,0,null,'blocked')]),update=effect(14,['root','working','blocked']);
    const active=plan(previous,current,update);
    expect(reconcileTasklandMotion(active,{previousModel:previous,model:model([place('root',30,0,null,'blocked')]),effect:update},500).transitions).toEqual([]);
    const departure=plan(previous,model([]),effect(15,['root','working','done']));
    expect(reconcileTasklandMotion(departure,{previousModel:previous,model:previous,effect:effect(15)},500).transitions).toEqual([]);
  });
  it('does not animate criterion facts as a fictitious status move', () => {
    const previous=model([place('root',0)]),current=model([{...place('root',0),progress:.8,constructionStage:'topped-out'}]);
    const state=plan(previous,current,{id:16,taskEvents:[{type:'task.criterion_changed',taskId:'root',criterionId:'ac1',criterionText:'Ready',isDone:true,done:8,total:10}]});
    expect(state.transitions).toEqual([]);
  });
  it('shows reopened markers and cancelled buildings directly from the current snapshot', () => {
    for (const before of [{...place('root',0,0,null,'done'),role:'shipped-marker' as const,constructionStage:'shipped-marker' as const},
      {...place('root',0,0,null,'cancelled'),constructionStage:'rubble' as const}]) {
      const previous=model([before]),current=model([place('root',10)]);
      expect(plan(previous,current,effect(17,['root',before.status!,'working'])).transitions).toEqual([]);
    }
  });
  it('samples moving worker sites by entity id and excludes shipment robot routes', () => {
    const previous=model([place('root',0)]),current=model([place('root',10,0,null,'blocked')]);
    const state=plan(previous,current,effect(18,['root','working','blocked']));
    const transition=state.transitions[0]!;
    expect(sampleTasklandPlace(state.transitions,'root',transition.duration/2)).toEqual({x:5,z:0});
    expect(sampleTasklandPlace(state.transitions,'claim-id',500)).toBeNull();
    const shipment=plan(previous,model([]),effect(19,['root','working','done']));
    expect(sampleTasklandPlace(shipment.transitions,'root',500)).toBeNull();
  });
  it('keeps neutral hierarchy markers stationary and outside cart suppression', () => {
    // The additive model checkpoint introduces this role; older snapshots lack it.
    const marker={...place('marker',3,2,'root','cancelled'),role:'hierarchy-marker',constructionStage:'foundation'} as unknown as MapPlace;
    const previous=model([place('root',0),marker]);
    const current=model([place('root',10,0,null,'blocked'),marker]);
    const state=plan(previous,current,effect(20,['root','working','blocked'],['marker','cancelled','done']));
    expect(state.transitions[0]!.members.map(m=>m.place.id)).toEqual(['root']);
    expect(state.transitions).toHaveLength(1);
    expect(suppressedTasklandPlaces(state.transitions).has('marker')).toBe(false);
    expect(plan(model([], 'town'),model([marker], 'town'),effect(21,['root','working','done'])).transitions).toEqual([]);
  });
});
