// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Group, Vector3 } from 'three';
import type { MapModel, MapPlace } from '../map-model';
import { emptyTasklandMotion, reconcileTasklandMotion, type TasklandMotionInput } from '../taskland-motion';
import { applyTasklandFrame, useTasklandMotion } from './TasklandMotion';

vi.mock('@react-three/fiber', () => ({ useFrame: vi.fn() }));
vi.mock('./MapAsset', () => ({ MapAsset: () => null }));
function input(effectId = 1): TasklandMotionInput {
  const place: MapPlace = {id:'root',entityId:'root',kind:'task',title:'Root',parentId:null,depth:0,groupId:'working',x:0,z:0,
    radius:1,footprint:1,compoundBounds:{minX:-1,maxX:1,minZ:-1,maxZ:1},status:'working',progress:.5,constructionStage:'walls',
    workStatus:'working',role:'entity',assetKey:'task.working',label:'Root',badges:[],mailbox:null,attention:0};
  const model: MapModel = {id:'taskland',type:'taskland',scope:{kind:'story',id:'story'},places:[place],groups:[],roads:[],paths:[],robots:[],decor:[],portals:[],
    bounds:{minX:-10,maxX:30,minZ:-10,maxZ:20},layout:{containers:{}},warnings:[]};
  return {previousModel:model,model:{...model,places:[{...place,x:10,status:'blocked',groupId:'blocked'}]},
    effect:{id:effectId,taskEvents:[{type:'task.status_changed',taskId:'root',from:'working',to:'blocked'}]}};
}
describe('Taskland scene motion hook', () => {
  it('publishes suppression in the same render as cargo and releases it exactly at completion', () => {
    const props=input();
    const {result,rerender}=renderHook(p=>useTasklandMotion(p),{initialProps:props});
    expect(result.current.transitions).toHaveLength(1);
    expect([...result.current.suppressedPlaceIds]).toEqual(['root']);
    act(()=>result.current.finishTransition('1:root'));
    expect(result.current.transitions).toEqual([]);
    expect(result.current.suppressedPlaceIds.size).toBe(0);
    rerender({...props});
    expect(result.current.transitions).toEqual([]);
  });
  it('disposes both suppression and cargo immediately when reduced motion changes', () => {
    const props=input();
    const {result,rerender}=renderHook(p=>useTasklandMotion(p),{initialProps:props});
    rerender({...props,reducedMotion:true});
    expect(result.current.transitions).toEqual([]);
    expect(result.current.suppressedPlaceIds.size).toBe(0);
    rerender({...props,reducedMotion:false});
    expect(result.current.transitions).toEqual([]);
  });
  it('cannot let a stale completion callback remove replacement cargo', () => {
    const props=input();
    const {result,rerender}=renderHook(p=>useTasklandMotion(p),{initialProps:props});
    const oldFinish=result.current.finishTransition;
    rerender({previousModel:props.model,model:{...props.model,places:[{...props.model.places[0]!,x:20,status:'in_review',groupId:'in_review'}]},
      effect:{id:2,taskEvents:[{type:'task.status_changed',taskId:'root',from:'blocked',to:'in_review'}]}});
    act(()=>oldFinish('1:root'));
    expect(result.current.transitions[0]!.key).toBe('2:root');
    expect(result.current.suppressedPlaceIds.has('root')).toBe(true);
  });
  it('clears on a recovery snapshot and does not replay its repeated effect', () => {
    const props=input();
    const {result,rerender}=renderHook(p=>useTasklandMotion(p),{initialProps:props});
    rerender({...props,previousModel:null});
    expect(result.current.transitions).toEqual([]);
    rerender(props);
    expect(result.current.transitions).toEqual([]);
  });
  it('uses a shared injected clock for deterministic synthetic frames', () => {
    const props={...input(),now:()=>2000};
    const {result}=renderHook(p=>useTasklandMotion(p),{initialProps:props});
    expect(result.current.transitions[0]!.startedAt).toBe(2000);
  });
});
describe('Taskland Three frame application', () => {
  it('moves root and relative cargo in world space and hides the transient on arrival', () => {
    const props=input();
    const state=reconcileTasklandMotion(emptyTasklandMotion(props),props,100);
    const transition=state.transitions[0]!;
    const root=new Group(),cargo=new Group(),member=new Group();
    root.add(cargo);cargo.add(member);
    const objects={root,cargo,dust:null,members:new Map([['root',member]])};
    expect(applyTasklandFrame(transition,100+transition.duration/2,objects)).toBe(false);
    root.updateMatrixWorld(true);
    expect(member.getWorldPosition(new Vector3()).toArray()).toEqual([5,.44,0]);
    expect(root.visible).toBe(true);
    expect(applyTasklandFrame(transition,100+transition.duration,objects)).toBe(true);
    expect(root.visible).toBe(false);
  });
  it('collapses old cargo vertically and expands dust while current rubble stays separate', () => {
    const props=input();
    props.model={...props.model,places:[{...props.previousModel!.places[0]!,status:'cancelled',constructionStage:'rubble'}]};
    props.effect={id:2,taskEvents:[{type:'task.status_changed',taskId:'root',from:'working',to:'cancelled'}]};
    const transition=reconcileTasklandMotion(emptyTasklandMotion(props),props,0).transitions[0]!;
    const root=new Group(),cargo=new Group(),dust=new Group(),member=new Group();
    const objects={root,cargo,dust,members:new Map([['root',member]])};
    applyTasklandFrame(transition,450,objects);
    expect(cargo.scale.toArray()).toEqual([1,.5,1]);
    expect(dust.visible).toBe(true);
    expect(dust.scale.x).toBe(1.25);
    expect(transition.suppressedPlaceIds).toEqual([]);
    applyTasklandFrame(transition,900,objects);
    expect(root.visible).toBe(false);
    expect(dust.visible).toBe(false);
  });
});
