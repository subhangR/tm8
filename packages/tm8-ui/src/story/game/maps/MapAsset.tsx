import { useEffect, useSyncExternalStore } from 'react';
import { useProgress } from '@react-three/drei';
import { LoadedGameAsset, getImportedAsset, constructionAssetForStage, WORKER_POSES, type ImportedAssetId, type RobotPose } from '../imported-assets';
import { ProceduralProp } from './ProceduralProp';
import type { ConstructionStage } from '../map-model';
const listeners=new Set<()=>void>();
const mounted=new Map<string,number>(), fallbacks=new Map<string,number>();
let revision=0;
function update(map:Map<string,number>,key:string,delta:number){const n=(map.get(key)??0)+delta;if(n>0)map.set(key,n);else map.delete(key);revision++;listeners.forEach(fn=>fn());}
export function useAssetReport(){const progress=useProgress();useSyncExternalStore(fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},()=>revision);return {loading:progress.active,errors:progress.errors,used:[...mounted.keys()],fallbacks:[...fallbacks.keys()],instances:[...mounted.values()].reduce((a,b)=>a+b,0)};}
const aliases:Record<string,ImportedAssetId>={ 'office.plaque':'plaque','town.session-monument':'plaque', 'worker.robot':'worker', 'office.desk':'desk','office.staff':'worker','office.academy':'office','factory.project':'code-factory','entity.generic':'plaque','landmark.hub':'hub','landmark.taskland':'task-building','landmark.office':'office','landmark.library':'library','landmark.factory':'code-factory','landmark.town':'gate','portal.story':'gate','landmark.shipping-yard':'shipping-yard', 'decor.tree':'tree','decor.rock':'rock','decor.bench':'desk','decor.fountain':'hub','portal.taskland':'task-building','portal.office':'office','portal.library':'library','portal.factory':'code-factory','portal.town':'gate','portal.hub':'hub','task':'task-building','task-building.complete':'construction-done','doc':'library','artifact':'crate','file':'crate','drawing':'plaque','memory':'library','work_session':'desk','team_member':'robot','pull_request':'code-factory','commit':'crate','worktree':'code-factory','robot.working':'worker','robot.waiting':'worker','robot.blocked':'worker','robot.idle':'worker','robot.attention':'worker'};
function resolve(key:string,stage?:ConstructionStage):string{if(stage && key.startsWith('task.'))return stage==='shipped-marker'?'plaque':stage==='rubble'?'rubble':constructionAssetForStage(stage==='walls'?'walls-up':stage==='complete'?'done':stage);return aliases[key]??key;}
function Fallback({id}:{id:string}){useEffect(()=>{update(fallbacks,id,1);return()=>update(fallbacks,id,-1);},[id]);return <ProceduralProp id={id}/>;}
export function MapAsset({assetKey,size=1,stage,status}:{assetKey:string;size?:number;stage?:ConstructionStage;status?:string|null}){
  const id=resolve(assetKey,stage);const asset=getImportedAsset(id);
  useEffect(()=>{update(mounted,id,1);return()=>update(mounted,id,-1);},[id]);
  return <group scale={size}>{asset?<LoadedGameAsset assetId={asset.id} fallback={<Fallback id={id}/>} clip={id==='worker'?WORKER_POSES[(status??'idle') as RobotPose]??'Idle':undefined} reducedMotion={typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches}/>:<Fallback id={id}/>}</group>;
}
