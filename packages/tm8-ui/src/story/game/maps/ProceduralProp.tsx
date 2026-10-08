import { readStudioPalette } from '../studioPalette';
const colors = readStudioPalette();
/** Existing production asset kit, explicitly labelled as procedural by MapAsset. */
import { useEffect, useMemo } from 'react';
import { buildAsset } from '../assets/prototypes';
import { KIT_GEOMETRIES } from '../assets/geometry';
import type { AssetType } from '../assets/registry';
import type { Palette } from '../palette';
const PALETTE:Palette={ink:colors.propInk,ink3:colors.propMuted,surface:colors.propSurface,card:colors.propCard,line:colors.propLine,line2:colors.propLineStrong,brand:colors.propBrand,run:colors.propRun,info:colors.propInfo,block:colors.propBlock,wait:colors.propWait,merged:colors.propMerged};
const TYPES:Record<string,AssetType>={plaque:'session-stele',mailbox:'task-mailbox','library.book':'doc-lectern','library.drawing':'drawing-easel','library.artifact':'artifact-vitrine','library.file':'file-crate','factory.pull-request':'pr-tollgate','factory.commit':'commit-milestone','factory.worktree':'worktree-branch'};
export function ProceduralProp({id}:{id:string}){
  const asset=useMemo(()=>buildAsset(TYPES[id]??'unknown-cairn',PALETTE,{state:'done'}),[id]);
  const geometries=useMemo(()=>new Map([...new Set(asset.parts.map(p=>p.geo))].map(geo=>[geo,KIT_GEOMETRIES[geo]()])),[asset]);
  useEffect(()=>()=>{geometries.forEach(g=>g.dispose());},[geometries]);
  return <group scale={1/(asset.footprint*2)}>{asset.parts.map((p,i)=><mesh key={i} geometry={geometries.get(p.geo)} position={[p.x,p.y,p.z]} rotation={[p.rx,p.ry,p.rz]} scale={[p.sx,p.sy,p.sz]} castShadow receiveShadow><meshStandardMaterial color={p.color} roughness={.8}/></mesh>)}</group>;
}
