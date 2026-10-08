import { readStudioPalette } from '../studioPalette';
const colors = readStudioPalette();
import { Suspense, useEffect, useMemo, useRef, type ReactNode, type ComponentRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { BufferGeometry, Float32BufferAttribute, OrthographicCamera, Vector3 } from 'three';
import type { MapModel, MapPlace, MapRendererProps, MapType } from '../map-model';
import { MapAsset } from './MapAsset';

export const MAP_META: Record<MapType, { title: string; subtitle: string; color: string; ground: string }> = {
  hub: { title: 'The living atlas', subtitle: 'One world. Every place connected.', color: colors.hubAccent, ground: colors.hubGround },
  taskland: { title: 'Taskland', subtitle: 'Small steps, growing neighbourhoods.', color: colors.tasklandAccent, ground: colors.tasklandGround },
  office: { title: 'The Office', subtitle: 'A campus for the people doing the work.', color: colors.officeAccent, ground: colors.officeGround },
  library: { title: 'The Library', subtitle: 'Ideas collected. Knowledge made visible.', color: colors.libraryAccent, ground: colors.libraryGround },
  factory: { title: 'Code Factory', subtitle: 'From workshop to working software.', color: colors.factoryAccent, ground: colors.factoryGround },
  town: { title: 'Completed Town', subtitle: 'A home for everything brought to life.', color: colors.townAccent, ground: colors.townGround },
};
export const STATUS_COLORS: Record<string, string> = { working: colors.working, blocked: colors.blocked, done: colors.done, complete: colors.done, to_do: colors.todo, in_review: colors.review };
export interface RenderStats { calls: number; triangles: number; frameMs: number; geometries: number; textures: number; medianMs: number; p95Ms: number; samples: number }
export interface MapSceneProps extends MapRendererProps {
  lighting?: 'morning' | 'noon' | 'evening'; hierarchy?: boolean; footprints?: boolean;
  fitToken?: number; focus?: MapPlace | null; gallery?: boolean;
  onHover?: (id: string | null) => void; onStats?: (stats: RenderStats) => void;
}
function Box({ position, size, color, children }: { position: [number, number, number]; size: [number, number, number]; color: string; children?: ReactNode }) {
  return <mesh position={position} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={.85}/>{children}</mesh>;
}
function CameraRig({ model, fitToken, focus, gallery }: Pick<MapSceneProps, 'model'|'fitToken'|'focus'|'gallery'>) {
  const control = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, size } = useThree();
  useEffect(() => {
    if (!(camera instanceof OrthographicCamera)) return;
    let b=model.bounds;
    if(focus){const ids=new Set([focus.entityId]);let changed=true;while(changed){changed=false;for(const p of model.places)if(p.parentId&&ids.has(p.parentId)&&!ids.has(p.entityId)){ids.add(p.entityId);changed=true;}}const nodes=model.places.filter(p=>ids.has(p.entityId));b={minX:Math.min(...nodes.map(p=>p.x-p.radius-2)),maxX:Math.max(...nodes.map(p=>p.x+p.radius+2)),minZ:Math.min(...nodes.map(p=>p.z-p.radius-2)),maxZ:Math.max(...nodes.map(p=>p.z+p.radius+2))};}
    const x=(b.minX+b.maxX)/2,z=(b.minZ+b.maxZ)/2;
    const w=Math.max(16,b.maxX-b.minX+(focus?6:14)),d=Math.max(16,b.maxZ-b.minZ+(focus?6:14));
    camera.position.set(x+(gallery?0:w*.8), Math.max(w,d)*.85, z+d*.95);
    camera.zoom = Math.min(size.width/(w*1.25), size.height/(d*.95+w*.35));
    camera.near = .1; camera.far = Math.max(2000, (w+d)*5); camera.updateProjectionMatrix();
    camera.lookAt(x,0,z); control.current?.target.set(x,0,z); control.current?.update();
  }, [camera, model, size.width, size.height, fitToken, focus, gallery]);
  return <OrbitControls ref={control} makeDefault maxPolarAngle={Math.PI*.46} minPolarAngle={.2} minZoom={.7} maxZoom={80} enableDamping dampingFactor={.12}/>;
}
function Metrics({ onStats, model }: Pick<MapSceneProps,'onStats'|'model'>) {
  const samples = useRef({ elapsed: 0, frames: 0, timings: [] as number[] });
  useEffect(()=>{samples.current={elapsed:0,frames:0,timings:[]};},[model]);
  useFrame(({ gl }, delta) => { const s = samples.current; s.elapsed += delta; s.frames++; s.timings.push(delta*1000); if(s.timings.length>60)s.timings.shift(); if(s.elapsed < 1) return; onStats?.({ calls: gl.info.render.calls, triangles: gl.info.render.triangles, frameMs: s.elapsed/s.frames*1000, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, medianMs:[...s.timings].sort((a,b)=>a-b)[Math.floor(s.timings.length/2)]??0,p95Ms:[...s.timings].sort((a,b)=>a-b)[Math.floor(s.timings.length*.95)]??0,samples:s.timings.length }); s.elapsed=0;s.frames=0; });
  return null;
}
function Plot({ p, model, selected, hierarchy, footprints, onSelect, onHover }: { p: MapPlace; model: MapModel; selected: boolean; hierarchy?: boolean; footprints?: boolean; onSelect?: (id:string)=>void; onHover?: (id:string|null)=>void }) {
  const meta=MAP_META[model.type], color=STATUS_COLORS[p.status ?? ''] ?? meta.color;
  const b=p.compoundBounds;
  const boundary:[number,number,number][]=[[b.minX-p.x,.015,b.minZ-p.z],[b.maxX-p.x,.015,b.minZ-p.z],[b.maxX-p.x,.015,b.maxZ-p.z],[b.minX-p.x,.015,b.maxZ-p.z],[b.minX-p.x,.015,b.minZ-p.z]];
  const children = model.places.some(q=>q.parentId===p.entityId);
  const size=Math.max(1.6,p.radius*1.9), y=.18+p.depth*.07;
  return <group position={[p.x,y,p.z]} onClick={e=>{e.stopPropagation();onSelect?.(p.entityId);}} onPointerOver={e=>{e.stopPropagation();onHover?.(p.entityId);document.body.style.cursor='pointer';}} onPointerOut={()=>{onHover?.(null);document.body.style.cursor='';}}>
    <mesh position-y={-.02} receiveShadow><cylinderGeometry args={[size*.72,size*.72,.13,6]}/><meshStandardMaterial color={selected?colors.selectedPlot:colors.plot}/></mesh>
    <Box position={[0,.07,size*.64]} size={[size*1.1,.12,.13]} color={color}/>
    {footprints && <Line points={[[-p.footprint,0,-p.footprint],[p.footprint,0,-p.footprint],[p.footprint,0,p.footprint],[-p.footprint,0,p.footprint],[-p.footprint,0,-p.footprint]]} color={color} lineWidth={1} dashed dashSize={.3} gapSize={.3}/>}
    <mesh rotation-x={-Math.PI/2} position-y={.025}><circleGeometry args={[size*.6,24]}/><meshBasicMaterial color={colors.contactShadow} transparent opacity={.12} depthWrite={false}/></mesh><MapAsset assetKey={p.assetKey} stage={p.constructionStage} status={p.status} size={size} />

    {hierarchy && children && <Line points={boundary} color={colors.compoundBoundary} lineWidth={2}/>}
    {p.status==='blocked' && <group position={[size*.58,.7,0]}><Box position={[0,0,0]} size={[.1,1.2,.1]} color={colors.flagPost}/><Box position={[.15,.38,0]} size={[.5,.35,.08]} color={colors.flag}/></group>}
  </group>;
}
function HexGrid({width,depth,x,z}:{width:number;depth:number;x:number;z:number}){
  const geometry=useMemo(()=>{const points:number[]=[];const radius=Math.max(2.3,width/38,depth/38);const dx=radius*1.5,dz=radius*Math.sqrt(3);for(let c=0;c<width/dx;c++)for(let r=0;r<depth/dz;r++){const cx=x-width/2+c*dx,cz=z-depth/2+r*dz+(c%2)*dz/2;for(let i=0;i<6;i++){const a=i*Math.PI/3,b=(i+1)*Math.PI/3;points.push(cx+Math.cos(a)*radius,.045,cz+Math.sin(a)*radius,cx+Math.cos(b)*radius,.045,cz+Math.sin(b)*radius);}}const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(points,3));return g;},[width,depth,x,z]);
  useEffect(()=>()=>geometry.dispose(),[geometry]);
  return <lineSegments geometry={geometry}><lineBasicMaterial color={colors.hexGrid} transparent opacity={.16}/></lineSegments>;
}
function Landscape({ model, gallery }: {model:MapModel;gallery?:boolean}) {
  const b=model.bounds, w=b.maxX-b.minX+13,d=b.maxZ-b.minZ+13,cx=(b.minX+b.maxX)/2,cz=(b.minZ+b.maxZ)/2;
  return <group>
    <Box position={[cx,-.62,cz]} size={[w,1.15,d]} color={colors.islandSide}/>
    <Box position={[cx,-.08,cz]} size={[w,.2,d]} color={MAP_META[model.type].ground}/><HexGrid width={w} depth={d} x={cx} z={cz}/>
    <Box position={[cx,-.72,cz]} size={[w+2,.2,d+2]} color={colors.islandRim}/>
    <mesh rotation-x={-Math.PI/2} position={[cx,-1.03,cz]} receiveShadow><planeGeometry args={[w*10,d*10]}/><meshStandardMaterial color={colors.water} roughness={.65}/></mesh>
    {!gallery&&Array.from({length:16},(_,i)=>{const horizontal=i<8;const n=i%8; const x=horizontal?cx-w*.43+n*w*.12:(i%2?b.minX-4:b.maxX+4);const z=horizontal?(i%2?b.minZ-4:b.maxZ+4):cz-d*.43+n*d*.12;return <group key={i} position={[x,0,z]}><MapAsset assetKey={i%3?(i%2?'tree-pine':'decor.tree'):'decor.rock'} size={i%3?2.1:1.2}/></group>;})}
  </group>;
}
function Route({ points, dependency }: {points:{x:number;z:number}[];dependency?:boolean}) {
  return <Line points={points.map(p=>[p.x,dependency ? .42 : .13,p.z] as [number,number,number])} color={dependency?colors.dependency:colors.path} lineWidth={dependency?2:7} dashed={dependency} dashSize={.7} gapSize={.4}/>;
}
function SceneContent(props:MapSceneProps & {labels:WorldLabel[];nodes:MutableRefObject<Map<string,HTMLDivElement>>}) {
  const {model}=props;
  const span=Math.max(model.bounds.maxX-model.bounds.minX,model.bounds.maxZ-model.bounds.minZ,30);
  const cx=(model.bounds.minX+model.bounds.maxX)/2,cz=(model.bounds.minZ+model.bounds.maxZ)/2;
  const warmth=props.lighting==='evening'?colors.eveningLight:props.lighting==='noon'?colors.noonLight:colors.morningLight;
  return <>
    <color attach="background" args={[colors.sky]}/><hemisphereLight args={[colors.hemisphereSky,colors.hemisphereGround,1.4]}/>
    <directionalLight position={[cx-span*.5,span,cz+span*.3]} color={warmth} intensity={2.5} castShadow shadow-mapSize={[1024,1024]} shadow-camera-left={-span} shadow-camera-right={span} shadow-camera-top={span} shadow-camera-bottom={-span} shadow-camera-far={span*4} shadow-normalBias={.05}/>
    <Landscape model={model} gallery={props.gallery}/>{model.type!=='hub'&&!props.gallery&&<group position={[model.bounds.minX+3,.15,model.bounds.minZ-3]}><MapAsset assetKey={model.type==='town'?'shipping-yard':model.type==='taskland'?'cart':model.type==='factory'?'code-factory':model.type} size={model.type==='taskland'?3:6}/></group>}
    {props.hierarchy && model.groups.map(g=><group key={g.id}><Line points={[[g.bounds.minX,.08,g.bounds.minZ],[g.bounds.maxX,.08,g.bounds.minZ],[g.bounds.maxX,.08,g.bounds.maxZ],[g.bounds.minX,.08,g.bounds.maxZ],[g.bounds.minX,.08,g.bounds.minZ]]} color={g.depth?colors.childBoundary:colors.rootBoundary} lineWidth={g.depth?1:3}/></group>)}
    {model.paths.map(p=><Route key={p.id} points={p.points}/>)}
    {!props.gallery&&model.places.filter(p=>p.parentId).map(p=>{const parent=model.places.find(q=>q.entityId===p.parentId);return parent?<Route key={`walk:${p.id}`} points={[{x:parent.x,z:parent.z+parent.radius},{x:p.x,z:p.z-p.radius}]}/>:null;})}
    {model.roads.map(p=><Route key={p.id} points={p.points} dependency/>)}
    {model.places.map(p=><Plot key={p.id} p={p} model={model} selected={props.selectedEntityId===p.entityId} hierarchy={props.hierarchy} footprints={props.footprints} onSelect={props.onSelectEntity} onHover={props.onHover}/>)}
    {model.portals.map(p=><group key={p.id} position={[p.x,.12,p.z]} onClick={e=>{e.stopPropagation();props.onEnterPortal?.(p);}} onPointerOver={()=>{document.body.style.cursor='pointer';}} onPointerOut={()=>{document.body.style.cursor='';}}><Box position={[0,0,0]} size={[p.radius*2,.25,p.radius*2]} color={colors.portalPad}/><MapAsset assetKey={p.assetKey} size={p.radius*1.5}/></group>)}
    {model.decor.filter(p=>!model.portals.some(q=>q.x===p.x&&q.z===p.z)).map(p=><group key={p.id} position={[p.x,.12,p.z]}><MapAsset assetKey={p.assetKey} size={p.radius*1.5}/></group>)}
    {model.robots.map(p=><group key={p.id} position={[p.x,.2,p.z]}><MapAsset assetKey={p.assetKey} size={1.2} status={p.pose}/></group>)}

    <LabelProjector labels={props.labels} nodes={props.nodes}/><CameraRig model={model} fitToken={props.fitToken} focus={props.focus} gallery={props.gallery}/><Metrics model={model} onStats={props.onStats}/>
  </>;
}
interface WorldLabel {id:string;title:string;detail:string;x:number;y:number;z:number;selected?:boolean;priority:number}
function LabelProjector({labels,nodes}:{labels:WorldLabel[];nodes:MutableRefObject<Map<string,HTMLDivElement>>}){
  const point=useRef(new Vector3());
  useFrame(({camera,size})=>{const occupied:{x:number;y:number;width:number}[]=[];for(const label of labels){const node=nodes.current.get(label.id);if(!node)continue;point.current.set(label.x,label.y,label.z).project(camera);const x=(point.current.x*.5+.5)*size.width,y=(-point.current.y*.5+.5)*size.height;const width=label.detail==='Imported CC0'?110:158;const hidden=point.current.z>1||x<30||x>size.width-30||y<100||y>size.height-65||(!label.selected&&occupied.some(p=>Math.abs(p.x-x)<(p.width+width)/2+5&&Math.abs(p.y-y)<43));node.style.display=hidden?'none':'block';if(!hidden){occupied.push({x,y,width});node.style.transform=`translate(${x}px,${y}px) translate(-50%,0)`;}}});
  return null;
}
export function MapScene(props:MapSceneProps) {
  const nodes=useRef(new Map<string,HTMLDivElement>());
  useEffect(()=>()=>{document.body.style.cursor='';},[props.model]);
  const labels=useMemo(()=>{
    const result:WorldLabel[]=props.model.places.filter(p=>p.depth<2||props.focus||p.entityId===props.selectedEntityId).map(p=>({id:p.id,title:p.title,detail:p.kind==='asset'?'Imported CC0':`${p.parentId?'Nested · ':''}${p.progress===null?'Progress unknown':`${Math.round(p.progress*100)}%`}${p.status?` · ${p.status.replaceAll('_',' ')}`:''}`,x:p.x,y:.7,z:p.z+p.radius*1.2+1.3,selected:p.entityId===props.selectedEntityId,priority:p.entityId===props.selectedEntityId?-1:p.depth}));
    result.push(...props.model.portals.map(p=>({id:p.id,title:p.label,detail:'Enter map ↗',x:p.x,y:.5,z:p.z+p.radius+1.4,priority:0})));
    if(props.hierarchy)result.push(...props.model.groups.filter(g=>g.depth===0&&g.placeIds.length>1).map(g=>({id:g.id,title:g.label,detail:'Compound district',x:g.bounds.minX,y:.4,z:g.bounds.maxZ+2,priority:10})));
    return result.sort((a,b)=>a.priority-b.priority);
  },[props.model,props.selectedEntityId,props.hierarchy,props.focus]);
  return <><Canvas shadows onCreated={({gl})=>{const context=gl.getContext(),ext=context.getExtension('WEBGL_debug_renderer_info');if(ext&&/swiftshader/i.test(String(context.getParameter(ext.UNMASKED_RENDERER_WEBGL))))gl.shadowMap.enabled=false;}} orthographic camera={{position:[40,50,40],zoom:10,far:3000}} dpr={1} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}}><Suspense fallback={null}><SceneContent {...props} labels={labels} nodes={nodes}/></Suspense></Canvas><div style={{position:'absolute',inset:0,pointerEvents:'none',overflow:'hidden'}}>{labels.map(l=><div key={l.id} ref={node=>{if(node)nodes.current.set(l.id,node);else nodes.current.delete(l.id);}} style={{position:'absolute',left:0,top:0,display:'none'}}><div className="ms-label" style={l.detail==='Imported CC0'?{maxWidth:110,fontSize:10}:undefined} data-selected={l.selected}>{l.title}<small>{l.detail}</small></div></div>)}</div>{props.model.places.length===0&&props.model.portals.length===0&&<div className="ms-loading">No entities in this map’s scope.</div>}</>;
}
