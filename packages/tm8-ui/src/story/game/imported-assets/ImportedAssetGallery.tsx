import { readStudioPalette } from '../studioPalette';
const colors = readStudioPalette();
import { useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import { IMPORTED_ASSETS, PROCEDURAL_ASSET_GAPS, type ImportedAssetId } from './registry';
import { LoadedGameAsset } from './LoadedGameAsset';
const groups: Record<string, readonly ImportedAssetId[]> = {
  Town: ['hub','office','library','code-factory','task-building','task-building-blue','task-building-yellow','shipping-yard'],
  Construction: ['construction-lot','construction-foundation','construction-scaffolding','construction-walls-up','construction-topped-out','construction-done','rubble'],
  Landscape: ['terrain-grass','path-straight','path-crossing','tree','tree-pine','rock','gate','fence'],
  Crew: ['worker','robot','desk','cart','crate'],
};
function ProjectLabels({ ids, host }: { ids: readonly string[]; host: RefObject<HTMLDivElement | null> }) {
  const { camera, size } = useThree();
  const point = new Vector3();
  useFrame(() => {
    ids.forEach((id,i) => {
      const el=host.current?.querySelector<HTMLElement>(`[data-asset-label="${id}"]`);
      if (!el) return;
      point.set((i%4-1.5)*5.4,0,(Math.floor(i/4)-.5)*11+2.6).project(camera);
      el.style.left=`${(point.x+1)*size.width/2}px`;
      el.style.top=`${(1-point.y)*size.height/2}px`;
    });
  });
  return null;
}
export function ImportedAssetGallery({ reduced = false }: { reduced?: boolean }) {
  const labels=useRef<HTMLDivElement>(null);
  const [category,setCategory] = useState('Town');
  const ids = groups[category]!;
  const models = ids.map(id => IMPORTED_ASSETS.find(a=>a.id===id)!).filter(Boolean);
  return <section style={{flex:1,minHeight:0,display:'flex',flexDirection:'column',background:colors.gallerySurface,color:colors.galleryInk}} data-imported-gallery>
    <div style={{padding:'14px 24px',display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
      <b>Downloaded CC0 collection</b>
      {Object.keys(groups).map(group=><button key={group} onClick={()=>setCategory(group)} aria-pressed={category===group} style={{padding:'7px 14px',border:`1px solid ${colors.galleryBorder}`,borderRadius:7,background:category===group?colors.galleryAccent:colors.white,color:category===group?colors.white:colors.galleryAccent,cursor:'pointer'}}>{group}</button>)}
      <span style={{marginLeft:'auto',fontSize:12}}>Drag to orbit · scroll to zoom · {IMPORTED_ASSETS.length} semantic assets</span>
    </div>
    <div style={{flex:1,minHeight:440,position:'relative'}}>
      <Canvas shadows orthographic camera={{position:[0,26,22],zoom:42,near:.1,far:200}} dpr={[1,1.5]} gl={{antialias:true,preserveDrawingBuffer:true}}>
        <color attach="background" args={[colors.galleryGround]} />
        <hemisphereLight args={[colors.gallerySkyLight,colors.galleryGroundLight,2]} />
        <directionalLight position={[-8,20,12]} intensity={3} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-16} shadow-camera-right={16} shadow-camera-top={14} shadow-camera-bottom={-14} shadow-normalBias={.035}/>
        <mesh rotation-x={-Math.PI/2} position-y={-.05} receiveShadow><planeGeometry args={[200,200]}/><meshStandardMaterial color={colors.galleryGround} roughness={1}/></mesh>
        {models.map((asset,i)=> {
          const x=(i%4-1.5)*5.4, z=(Math.floor(i/4)-.5)*11;
          return <group key={asset.id} position={[x,0,z]}>
            <LoadedGameAsset assetId={asset.id} scale={asset.id==='worker'||asset.id==='robot'?3:3.8} clip={asset.id==='worker'?'Interact':asset.id==='robot'?'Wave':undefined} reducedMotion={reduced}/>

          </group>;
        })}
        <ProjectLabels ids={ids} host={labels} />
        <OrbitControls target={[0,1,0]} maxPolarAngle={Math.PI*.47} minZoom={20} maxZoom={100}/>
      </Canvas>
      <div ref={labels} style={{position:'absolute',inset:0,pointerEvents:'none'}}>{models.map(asset => (
            <div key={asset.id} data-asset-label={asset.id} style={{position:'absolute',transform:'translate(-50%,-50%)',pointerEvents:'none',width:205,textAlign:'center',fontFamily:'system-ui',fontSize:12,color:colors.galleryLabel}}>
              <strong style={{display:'block',fontSize:14,textTransform:'capitalize'}}>{asset.label}</strong>
              <span>{asset.id==='robot'?'Quaternius · fallback':asset.source.includes('kenney')?'Kenney':'KayKit'} · {Math.round(asset.bytes/1024)} KiB</span>
              {asset.id==='worker'&&<small style={{display:'block'}}>Recoloured humanoid · Interact clip</small>}
              {asset.id==='rubble'&&<small style={{display:'block'}}>Cancelled only</small>}
            </div>
      ))}</div>
    </div>
    <footer style={{padding:'10px 24px',fontSize:12,borderTop:`1px solid ${colors.galleryDivider}`}}>
      Progress selects the construction stage. Blocked is an overlay. Procedural gaps: {Object.entries(PROCEDURAL_ASSET_GAPS).map(([id,gap])=>`${id} (${gap.assetType})`).join('; ')}. Sources and licence evidence: public/game/cc0/LICENSES.json.
    </footer>
  </section>;
}
