import { readStudioPalette } from '../studioPalette';
const colors = readStudioPalette();
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildMapModel, type MapInput, type MapType, type MapPlace, type MapModel, type ConstructionStage } from '../map-model';
import { IMPORTED_ASSETS } from '../imported-assets';
import { MAP_META, MapScene, type RenderStats } from './MapScene';
import { useAssetReport } from './MapAsset';
import './studio.css';
const MAPS=Object.keys(MAP_META) as MapType[];
class RenderBoundary extends Component<{children:ReactNode},{error:string|null}>{state={error:null as string|null};static getDerivedStateFromError(error:Error){return {error:error.message};}render(){return this.state.error?<div className="ms-error">Map renderer unavailable: {this.state.error}</div>:this.props.children;}}
export interface MapStudioProps {input:MapInput; denseInput?:MapInput; nestedInput?:MapInput; provenance?:string; onInspect?:(id:string)=>void; onEnterStory?:(id:string)=>void; onImport?:(file:File)=>Promise<{input:MapInput;provenance:string}>; production?:boolean}
function assetGallery(base:MapModel):MapModel {
  const columns=6,spacing=9;
  return {...base,id:'asset-gallery',places:IMPORTED_ASSETS.map((a,i)=>({id:a.id,entityId:a.id,kind:'asset',title:a.label,parentId:null,depth:0,groupId:'gallery',x:i%columns*spacing,z:Math.floor(i/columns)*spacing,radius:1.7,footprint:2,compoundBounds:{minX:i%columns*spacing-2,maxX:i%columns*spacing+2,minZ:Math.floor(i/columns)*spacing-2,maxZ:Math.floor(i/columns)*spacing+2},status:null,progress:null,constructionStage:'complete',workStatus:null,role:'entity',assetKey:a.id,label:a.label,badges:[],mailbox:null,attention:0})),groups:[],roads:[],paths:[],portals:[],robots:[],decor:[],bounds:{minX:-4,minZ:-4,maxX:(columns-1)*spacing+4,maxZ:Math.ceil(IMPORTED_ASSETS.length/columns)*spacing}};
}
export function MapStudio({input,denseInput,nestedInput,provenance='Synthetic fixture · deterministic demonstration',onInspect,onImport,onEnterStory,production}:MapStudioProps){
  const params=new URLSearchParams(window.location.search);
  const [type,setType]=useState<MapType>(MAPS.includes(params.get('map') as MapType)?params.get('map') as MapType:'hub');
  const [preset,setPreset]=useState(params.get('preset')??'balanced');
  const [scope,setScope]=useState<'space'|'story'>(input.scope?.kind??'space');
  const [loaded,setLoaded]=useState<{input:MapInput;provenance:string}|null>(null),[error,setError]=useState<string|null>(null);
  const [lighting,setLighting]=useState<'morning'|'noon'|'evening'>('morning');
  const [hierarchy,setHierarchy]=useState(true),[footprints,setFootprints]=useState(false),[fit,setFit]=useState(0);
  const [selected,setSelected]=useState<string|null>(null),[hover,setHover]=useState<string|null>(null),[focus,setFocus]=useState<MapPlace|null>(null);
  const [stage,setStage]=useState('entity'),[status,setStatus]=useState('entity');
  const [stats,setStats]=useState<RenderStats|null>(null);
  const assets=useAssetReport();
  const previous=useRef(new Map<string,MapModel>());
  const source=loaded?.input??(preset==='dense'?denseInput:preset==='nested'?nestedInput:null)??input;
  const model=useMemo(()=>{
    const scoped=source.scope??{kind:scope,id:scope==='space'?'demo-space':'demo-story'};
    const cacheKey=`${preset}:${scoped.kind}:${scoped.id}:${type}`;
    const built=buildMapModel(source,{type,scope:scoped,previous:previous.current.get(cacheKey)});
    previous.current.set(cacheKey,built);
    if(preset==='gallery')return assetGallery(built);
    if(!production&&(stage!=='entity'||status!=='entity'))return {...built,places:built.places.map(p=>({...p,constructionStage:stage==='entity'?p.constructionStage:stage as ConstructionStage,status:status==='entity'?p.status:status}))};
    return built;
  },[source,type,scope,preset,stage,status,production]);
  useEffect(()=>setStats(null),[model]);
  const chosen=model.places.find(p=>p.entityId===selected),hovered=model.places.find(p=>p.entityId===hover);
  const pick=(id:string)=>setSelected(id);
  const changeMap=(next:MapType)=>{setType(next);setSelected(null);setFocus(null);setHover(null);};
  const actualProvenance=loaded?.provenance??provenance;
  return <div className="map-studio" data-testid="map-studio" data-map={type} data-preset={preset}>
    <header className="ms-header"><div className="ms-brand"><small>tm8 · world workshop</small>Living Atlas</div><div className="ms-header-note">A place for every idea. A world built by its work.</div><span className="ms-pill">{production?'Story map':'Design studio · preview'}</span></header>
    <aside className="ms-sidebar"><p className="ms-section-label">Explore the world</p><nav className="ms-nav">{MAPS.map((m,i)=><button key={m} data-testid={`map-${m}`} aria-pressed={m===type} onClick={()=>changeMap(m)}><b>0{i+1}</b>{MAP_META[m].title.replace('The living atlas','World hub').replace('The ','')}</button>)}</nav>
      <p className="ms-section-label">View settings</p>
      {!production&&<><label className="ms-field">Scope<select aria-label="Scope" value={source.scope?.kind??scope} disabled={!!loaded||!!input.scope} onChange={e=>{setScope(e.target.value as typeof scope);setFocus(null);}}><option value="space">Space</option><option value="story">Story</option></select></label><label className="ms-field">Scene preset<select aria-label="Scene preset" value={preset} onChange={e=>{previous.current.clear();setPreset(e.target.value);setLoaded(null);setSelected(null);setFocus(null);}}><option value="balanced">Balanced neighbourhoods</option><option value="nested">Nested compounds</option><option value="dense">Dense map</option><option value="gallery">Imported asset gallery</option></select></label></>}
      <label className="ms-field">Lighting<select aria-label="Lighting" value={lighting} onChange={e=>setLighting(e.target.value as typeof lighting)}><option value="morning">Warm morning</option><option value="noon">Clear noon</option><option value="evening">Golden hour</option></select></label>
      <label className="ms-check"><input type="checkbox" checked={hierarchy} onChange={e=>setHierarchy(e.target.checked)}/>Compound boundaries</label><label className="ms-check"><input type="checkbox" checked={footprints} onChange={e=>setFootprints(e.target.checked)}/>Layout footprints</label>
      {!production&&preset!=='gallery'&&<><label className="ms-field">Construction preview<select aria-label="Construction preview" value={stage} onChange={e=>setStage(e.target.value)}>{['entity','lot','foundation','scaffolding','walls','topped-out','complete'].map(s=><option key={s} value={s}>{s==='entity'?'From entity progress':s}</option>)}</select></label><label className="ms-field">Status preview<select aria-label="Status preview" value={status} onChange={e=>setStatus(e.target.value)}>{['entity','to_do','working','blocked','in_review','done'].map(s=><option key={s} value={s}>{s==='entity'?'From entity status':s.replaceAll('_',' ')}</option>)}</select></label></>}
      <div className="ms-assets" data-testid="asset-report"><strong>{assets.used.length-assets.fallbacks.length} / {assets.used.length} assets ready</strong><br/>{assets.instances} instances · {assets.fallbacks.length} fallback types{assets.loading&&<p>Loading imported models…</p>}{assets.errors.length>0&&<p role="status">Asset load errors: {assets.errors.join(", ")}</p>}{assets.fallbacks.length>0&&<details open><summary>Procedural fallbacks active</summary><ul>{assets.fallbacks.map(id=><li key={id}>{id}</li>)}</ul></details>}<details><summary>Imported CC0 asset ledger</summary><ul>{IMPORTED_ASSETS.map(a=><li key={a.id}>{a.label} · {a.source}{a.adaptation?` · ${a.adaptation}`:''}</li>)}</ul></details></div>
      <div className="ms-provenance" data-testid="provenance">{actualProvenance}<br/>{source.entities.length} entities · {source.edges.length} edges{!production&&(stage!=='entity'||status!=='entity')&&<p>Construction/status overrides are visual previews only.</p>}</div>
      {onImport&&<label className="ms-field">Open local snapshot<input aria-label="Open local snapshot" type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{const imported=await onImport(file);previous.current.clear();setLoaded(imported);setError(null);setPreset('snapshot');setFocus(null);setSelected(null);}catch(err){setError(err instanceof Error?err.message:String(err));}}}/></label>}
      <details className="ms-entity-picker"><summary>{model.places.length} visible entities</summary>{model.places.map(p=><button key={p.id} onClick={()=>{setSelected(p.entityId);setFocus(p);}}>{p.title}</button>)}</details>
    </aside>
    <main className="ms-stage"><div className="ms-map-title"><p className="ms-section-label">{preset==='gallery'?'Shared asset collection':`${model.scope.kind} / ${type}`}</p><h1>{preset==='gallery'?'The building blocks':MAP_META[type].title}</h1><p>{preset==='gallery'?'Downloaded CC0 geometry · normalized scale & pivots':MAP_META[type].subtitle}</p>{loaded&&<p style={{marginTop:8,fontWeight:600}}>Local snapshot · {model.scope.kind} scope · read only</p>}</div><div className="ms-toolbar"><button onClick={()=>{setFit(f=>f+1);setFocus(null);}}>Fit view</button>{chosen&&<button onClick={()=>setFocus(chosen)}>Focus selected</button>}</div>
      <RenderBoundary><MapScene model={model} gallery={preset==='gallery'} lighting={lighting} hierarchy={hierarchy} footprints={footprints} fitToken={fit} focus={focus} selectedEntityId={selected} onSelectEntity={pick} onHover={setHover} onStats={setStats} onEnterPortal={p=>{if(p.entityId){if(onEnterStory)onEnterStory(p.entityId);else setError('This portal points to another story. Open that story’s snapshot to explore it.');}else changeMap(p.target.type);}}/></RenderBoundary>
      {error&&<div className="ms-error">{error}</div>}{model.warnings.length>0&&<div className="ms-hover">{model.warnings.length} model notices: {model.warnings[0]}</div>}{hovered&&<div className="ms-hover">{hovered.title} · click to select</div>}
      <div className="ms-legend"><span><i className="ms-dot" style={{background:colors.legendCompound}}/>Compounds</span><span><i className="ms-dot" style={{background:colors.legendPath}}/>Paths</span><span><i className="ms-dot" style={{background:colors.dependency}}/>Dependencies</span></div>
      {chosen&&<section className="ms-inspect" aria-label="Selected entity"><div className="ms-section-label">{chosen.kind} · {chosen.status??'no status'}</div><h3>{chosen.title}</h3><p>{chosen.progress===null?'Progress unknown':`${Math.round(chosen.progress*100)}% complete`} · {chosen.constructionStage}</p><p>Depth {chosen.depth} · {chosen.parentId?'Nested in a parent compound':'Root compound'}</p><p>{chosen.entityId}</p>{chosen.outcome&&<p>Outcome: {chosen.outcome}</p>}{chosen.processState&&<p>Process: {chosen.processState}</p>}{onInspect&&<button onClick={()=>onInspect(chosen.entityId)}>Inspect entity ↗</button>}<button onClick={()=>{setSelected(null);setFocus(null);}}>Close detail</button></section>}
    </main>
    <footer className="ms-footer"><span>Drag to orbit · right-drag to pan · scroll to zoom</span><span data-testid="renderer-stats" data-samples={stats?.samples??0} data-median-ms={stats?.medianMs??0} data-p95-ms={stats?.p95Ms??0}>{stats?`${stats.calls} draw calls · ${stats.triangles.toLocaleString()} triangles · ${stats.medianMs.toFixed(1)} ms median · ${stats.p95Ms.toFixed(1)} ms p95`:'Starting WebGL renderer…'}</span><span>Three.js · WebGL</span></footer>
  </div>;
}
