/** Read-only production Player evidence. This module never calls a setter or a clock. */
export function createCameraAudit(currentRoot:()=>any, publishedMap:(props:any)=>any) {
 const identities=new WeakMap<object,string>();let nextIdentity=0,index=0,invalidCount=0;
 const identity=(object:any)=>object&&(typeof object==='object'||typeof object==='function')?(identities.get(object)??(identities.set(object,`observed:${++nextIdentity}`),identities.get(object))):null;
 const worlds:Record<string,any>={},publications:Record<string,any>={},frames:any[]=[],invalid:any[]=[],pending=new Map<string,any>();
 const modelFacts=(model:any)=>model?{identity:identity(model),id:model.id,type:model.type,scope:{...model.scope},bounds:{...model.bounds},
  places:model.places.map((p:any)=>({id:p.id,entityId:p.entityId,parentId:p.parentId,groupId:p.groupId,x:p.x,z:p.z,radius:p.radius,footprint:p.footprint,
   compoundBounds:{...p.compoundBounds},sizeBucket:p.sizeBucket,subtreeWeight:p.subtreeWeight,estimateMissing:p.estimateMissing,status:p.status,workStatus:p.workStatus,progress:p.progress,constructionStage:p.constructionStage})),
  groups:structuredClone(model.groups),layout:structuredClone(model.layout)}:null;
 const invalidSample=(sample:any)=>{invalid.push({index:++invalidCount,...sample});if(invalid.length>128)invalid.shift();};
 const read=():any=>{
  const root=currentRoot(),state=root?.store.getState();if(!state)return null;
  const stack=[root.fiber.current];let fiber:any=null;
  while(stack.length){const candidate=stack.pop();if(!candidate)continue;const props=candidate.memoizedProps;
   if(props?.control?.player&&props.playerPos?.current&&props.onPosition&&props.onCamera)fiber=candidate;
   if(candidate.child)stack.push(candidate.child);if(candidate.sibling)stack.push(candidate.sibling);
  }
  if(!fiber)return {observed:false,reason:'Actual attached Player fiber unavailable',frame:state.gl.info.render.frame};
  const props=fiber.memoizedProps,hooks:any[]=[];for(let hook=fiber.memoizedState;hook;hook=hook.next)hooks.push(hook);
  const ref=(i:number)=>hooks[i]?.memoizedState;
  const motionSlots=hooks.map((_,i)=>i).filter(i=>typeof ref(i)?.current?.moving==='boolean'&&typeof ref(i)?.current?.heading==='number'&&typeof ref(i)?.current?.arrival==='number');
  const knownSlots=hooks.map((_,i)=>i).filter(i=>ref(i)?.current instanceof Set);
  const motion=motionSlots[0],known=knownSlots[0];
  // Source scene.tsx216-245: consecutive useRef chains anchored by the unique
  // CharacterMotion object and known Set, then guarded by every adjacent shape.
  const valid=motionSlots.length===1&&knownSlots.length===1&&
   [1,2,7].every(offset=>typeof ref(motion+offset)?.current==='number')&&
   [3,4,5,8].every(offset=>ref(motion+offset)?.current?.isVector3===true)&&
   [9,10].every(offset=>typeof ref(motion+offset)?.current==='boolean')&&
   ref(motion+12)?.current?.onPosition===props.onPosition&&ref(motion+12)?.current?.onCamera===props.onCamera&&
   (ref(known+1)?.current===null||typeof ref(known+1)?.current==='string')&&
   [2,3,4].every(offset=>typeof ref(known+offset)?.current==='number')&&
   Array.isArray(ref(known+5)?.current)&&ref(known+5).current.length===2&&ref(known+5).current.every((v:any)=>typeof v==='number');
  if(!valid)return {observed:false,reason:'Source-anchored Player hook shape validation failed',frame:state.gl.info.render.frame,motionSlots,knownSlots};
  const nearId=ref(known+1).current,world=props.world,worldId=identity(world)!;
  if(!worlds[worldId])worlds[worldId]={identity:worldId,placesIdentity:identity(world.places),hubId:world.hubId,extent:world.extent,places:world.places.map((p:any)=>({id:p.id,x:p.x,z:p.z,footprint:p.footprint}))};
  const publication=publishedMap(props);if(!publication.observed)return {observed:false,reason:publication.reason,frame:state.gl.info.render.frame};
  const publicationId=identity(publication.live)!;
  if(!publications[publicationId])publications[publicationId]={identity:publicationId,source:publication.source,current:modelFacts(publication.model),previous:modelFacts(publication.previous),
   inputIdentity:identity(publication.input),input:{scope:publication.input.scope,taskHierarchyComplete:publication.input.taskHierarchyComplete,
    entities:publication.input.entities.map((e:any)=>({id:e.id,kind:e.kind,parentId:e.parentId,version:e.version,status:e.status,statusCategory:e.statusCategory,
     pointsEstimate:e.pointsEstimate,progress:e.progress,subtreeWeight:e.subtreeWeight,acceptance:e.acceptance,estimateTent:e.estimateTent,storyIds:e.storyIds,spaceId:e.spaceId})),
    edges:publication.input.edges.map((e:any)=>({...e}))}};
  const waypointSlots=hooks.map((_,i)=>i).filter(i=>Array.isArray(ref(i)?.current)&&ref(i).current.every((p:any)=>typeof p?.x==='number'&&typeof p?.z==='number'));
  if(waypointSlots.length!==1)return {observed:false,reason:'Unique actual Player waypoint ref unavailable',frame:state.gl.info.render.frame,waypointSlots};
  const nearPlace=nearId?world.byId.get(nearId):null,group=fiber.child?.stateNode?.object;
  if(!group?.isGroup||!group.uuid)return {observed:false,reason:'Actual Player attached group identity unavailable',frame:state.gl.info.render.frame};
  return {observed:true,source:'Attached production Player scene.tsx guarded ref chains; no inferred near ID',
   hookProvenance:{motionSlot:motion,knownSlot:known,nearSlot:known+1,zoomSlot:motion+1,saveTickSlot:known+2,revealTickSlot:known+3,waypointSlot:waypointSlots[0]},
   publicationId,publishedNearId:publication.nearId,playerTypeIdentity:identity(fiber.type),playerFiberIdentity:identity(fiber),playerGroupUuid:group?.uuid??null,worldId,controlIdentity:identity(props.control),nearRefIdentity:identity(ref(known+1)),zoomRefIdentity:identity(ref(motion+1)),
   sceneUuid:state.scene.uuid,cameraUuid:state.camera.uuid,frame:state.gl.info.render.frame,clockElapsed:state.clock.elapsedTime,at:performance.now(),
   player:{x:props.playerPos.current.x,z:props.playerPos.current.z},nearId,nearPlace:nearPlace?{id:nearPlace.id,x:nearPlace.x,z:nearPlace.z,footprint:nearPlace.footprint}:null,nearIdValid:nearId===null||!!nearPlace,
   approachFootprints:props.approachFootprints,hubId:world.hubId,canvas:{width:state.gl.domElement.width,height:state.gl.domElement.height,clientWidth:state.gl.domElement.clientWidth,clientHeight:state.gl.domElement.clientHeight},viewport:{width:state.size.width,height:state.size.height},
   cameraZoom:state.camera.zoom,zoomControl:ref(motion+1).current,intro:ref(motion+2).current,restored:ref(motion+9).current,
   overview:props.control.overview,duel:props.duel?{placeId:props.duel.placeId}:null,arena:!!(props.duel&&world.byId.get(props.duel.placeId)),reduced:props.reduced,
   waypointsLength:ref(waypointSlots[0]).current.length,order:props.control.order?{...props.control.order}:null,keys:[...props.control.keys],
   saveTick:ref(known+2).current,revealTick:ref(known+3).current,savedCamera:ref(motion+11).current?structuredClone(ref(motion+11).current):null,
   alertDisplay:props.alertNode.current?.style.display??null};
 };
 const before=()=>{const sample=read();if(sample?.observed)pending.set(sample.sceneUuid,sample);else if(sample)invalidSample({phase:"before",sample,at:performance.now()});};
 const after=()=>{const sample=read();if(!sample?.observed){if(sample)invalidSample({phase:'after',sample,at:performance.now()});return;}const before=pending.get(sample.sceneUuid);if(!before)return;
  const delta=sample.clockElapsed-before.clockElapsed,dt=Math.min(delta,.25),entering=before.reduced?0:Math.max(0,1-sample.intro/2.8);
  const world=worlds[before.worldId]; // All factors are actual production refs/props, never a recomputed near ID.
  const baseZoom=Math.max(22,Math.min(43,sample.viewport.height/18));
  const factors={baseZoom,zoomControl:before.zoomControl,nearMultiplier:before.nearId&&before.nearId!==world.hubId?1.09:1,arenaMultiplier:before.arena?1.55:1,entering,enteringMultiplier:1-entering*.35};
  const desired=before.overview&&!before.duel?Math.min(sample.viewport.width,sample.viewport.height)/(world.extent*2.5):baseZoom*before.zoomControl*factors.arenaMultiplier*factors.nearMultiplier*factors.enteringMultiplier;
  const expected=sample.restored?null:before.reduced?desired:desired+(before.cameraZoom-desired)*Math.exp(-3*dt);
  frames.push({index:++index,before,after:sample,delta,dt,desiredFactors:factors,desiredZoom:desired,expectedZoom:expected,zoomEquationError:expected===null?null:Math.abs(sample.cameraZoom-expected),
   alertMatchesPreviousNear:sample.alertDisplay===(before.nearId&&before.nearId!==before.hubId&&!before.duel?'grid':'none')});
  if(frames.length>4096)frames.shift();pending.delete(sample.sceneUuid);
  if(Object.keys(publications).length>512){const used=new Set(frames.flatMap(f=>[f.before.publicationId,f.after.publicationId]));for(const key of Object.keys(publications))if(!used.has(key))delete publications[key];}
  if(Object.keys(worlds).length>512){const used=new Set(frames.flatMap(f=>[f.before.worldId,f.after.worldId]));for(const key of Object.keys(worlds))if(!used.has(key))delete worlds[key];}
 };
 const snapshot=()=>structuredClone({index,invalidCount,frames,worlds,publications,invalid,source:'scene.tsx212-245/298-305/364-405',readOnly:true,bufferCapacity:4096});
 return {before,after,read,snapshot};
}
