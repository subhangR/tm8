/** Existing production asset kit, explicitly labelled as procedural by MapAsset. */
import { useEffect, useMemo } from 'react';
import { buildAsset } from '../assets/prototypes';
import { KIT_GEOMETRIES } from '../assets/geometry';
import type { AssetType } from '../assets/registry';
import type { Palette } from '../palette';
const PALETTE:Palette={ink:'#354b47',ink3:'#718077',surface:'#ecead7',card:'#fff7dc',line:'#d4ceb7',line2:'#aaa891',brand:'#a5784f',run:'#608954',info:'#6b939e',block:'#c47b55',wait:'#bd9950',merged:'#9384a5'};
const TYPES:Record<string,AssetType>={plaque:'session-stele',mailbox:'task-mailbox','library.book':'doc-lectern','library.drawing':'drawing-easel','library.artifact':'artifact-vitrine','library.file':'file-crate','factory.pull-request':'pr-tollgate','factory.commit':'commit-milestone','factory.worktree':'worktree-branch'};
export function ProceduralProp({id}:{id:string}){
  const asset=useMemo(()=>buildAsset(TYPES[id]??'unknown-cairn',PALETTE,{state:'done'}),[id]);
  const geometries=useMemo(()=>new Map([...new Set(asset.parts.map(p=>p.geo))].map(geo=>[geo,KIT_GEOMETRIES[geo]()])),[asset]);
  useEffect(()=>()=>{geometries.forEach(g=>g.dispose());},[geometries]);
  return <group scale={1/(asset.footprint*2)}>{asset.parts.map((p,i)=><mesh key={i} geometry={geometries.get(p.geo)} position={[p.x,p.y,p.z]} rotation={[p.rx,p.ry,p.rz]} scale={[p.sx,p.sy,p.sz]} castShadow receiveShadow><meshStandardMaterial color={p.color} roughness={.8}/></mesh>)}</group>;
}
