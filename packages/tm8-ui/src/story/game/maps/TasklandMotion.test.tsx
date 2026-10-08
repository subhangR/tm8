// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MapModel, MapPlace } from '../map-model';
import type { TasklandMotionInput } from '../taskland-motion';
import { useTasklandMotion } from './TasklandMotion';

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
});
