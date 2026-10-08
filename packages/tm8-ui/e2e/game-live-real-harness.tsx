/** All records and events originate from a disposable real server. */
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { GameScreen } from '../src/views/GameScreen';
import { useGateData } from '../src/views/useGateData';
import { createGameMapLoader } from '../src/data/game-maps';
import { resetNav } from '../src/stores/navStore';
import { writeLastSpace } from '../src/views/last-place';
import { nodeKeyOf } from '../src/data/launch-cache';
import { _roots } from '@react-three/fiber';
import { DefaultLoadingManager } from 'three';
import { createRealSeam } from '../src/data/real/seam-real';
import { browserWebSocketFactory } from '../src/data/real/socket';
import { createdIdOf } from '../src/authoring/commands';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
const setup=(window as any).__GAME_LIVE_SETUP__;
declare const __GAME_VERIFIER_HEAD__: string;
if(!setup)throw new Error('Disposable fixture setup required');
const seam=createRealSeam({fetch:globalThis.fetch,origin:location.origin,
 webSocketFactory:browserWebSocketFactory(WebSocket),getAuthToken:()=>setup.token});
const events:unknown[]=[],reads:unknown[]=[],pending:Function[]=[];
const eventCounts:Record<string,number>=JSON.parse(sessionStorage.getItem('game-live-event-counts')??'{}');
window.addEventListener('pagehide',()=>sessionStorage.setItem('game-live-event-counts',JSON.stringify(eventCounts)));
const assetLoads={pending:0,started:0,failed:0};
for(const method of ['itemStart','itemEnd','itemError'] as const){
 const original=DefaultLoadingManager[method].bind(DefaultLoadingManager);
 DefaultLoadingManager[method]=(url:string)=>{if(method==='itemStart'){assetLoads.pending++;assetLoads.started++;}else if(method==='itemEnd')assetLoads.pending--;else assetLoads.failed++;original(url);};
}
const sceneSnapshot=()=>{
 const canvas=document.querySelector<HTMLCanvasElement>('.sgm-stage canvas[data-engine]');
 const root=canvas?_roots.get(canvas):undefined;
 const state=root?.store.getState();
 if(!state)return null;
 let player:any=null;
 const stack=[(root as any).fiber.current];
 while(stack.length){
  const fiber=stack.pop();if(!fiber)continue;
  const props=fiber.memoizedProps;
  if(props?.control?.player&&props.playerPos?.current&&props.onPosition&&props.onCamera){
   const group=fiber.child?.stateNode?.object;
   player={id:group?.uuid??null,position:{x:props.control.player.x,z:props.control.player.z}};
  }
  if(fiber.child)stack.push(fiber.child);if(fiber.sibling)stack.push(fiber.sibling);
 }
 const workers:any[]=[];
 state.scene.traverse(object=>{
  if(!object.name.startsWith('robot:'))return;
  const point=object.getWorldPosition(object.position.clone()),projected=point.clone().project(state.camera);
  let skinnedMeshes=0;object.traverse(node=>{if((node as any).isSkinnedMesh)skinnedMeshes++;});
  workers.push({id:object.name,uuid:object.uuid,sessionId:object.userData.sessionId,claimId:object.userData.claimId,position:{x:point.x,z:point.z},visible:object.visible,inView:Math.abs(projected.x)<1&&Math.abs(projected.y)<1&&projected.z<1,skinnedMeshes});
 });
 return {sceneId:state.scene.uuid,cameraId:state.camera.uuid,cameraPose:{position:state.camera.position.toArray(),quaternion:state.camera.quaternion.toArray(),zoom:state.camera.zoom},player,frames:state.gl.info.render.frame,calls:state.gl.info.render.calls,width:canvas!.width,height:canvas!.height,assets:{...assetLoads},workers};
};
let delayed=false;
seam.onEvent(event=>{events.push(structuredClone(event));eventCounts[event.type]=(eventCounts[event.type]??0)+1;});
for(const name of ['query','entity','graph'] as const){
 const original=seam[name].bind(seam) as Function;
 (seam as any)[name]=async(...args:unknown[])=>{
  const start=performance.now();const result=await original(...args);
  if(delayed)await new Promise<void>(resolve=>pending.push(resolve));
  reads.push({name,args,start,end:performance.now()});return result;
 };
}
Object.assign(window,{__gameLive:{events,eventCounts,reads,seam,head:__GAME_VERIFIER_HEAD__,sceneSnapshot,spawn:async(input:any)=>createdIdOf(await seam.commands.spawn(input)),
 delayReads:()=>{delayed=true;},releaseReads:()=>{delayed=false;pending.splice(0).forEach(resolve=>resolve());},pending:()=>pending.length}});
if(!location.hash)location.hash=`#/s/${setup.spaceId}/work`;
const route=()=>resetNav((location.hash.match(/^#\/s\/([^/]+)/)?.[1]??setup.spaceId) as any,{view:'workspace'});
const reasons={presenceHollow:'No viewers measured.',versionHistory:'History unavailable.',provenanceHollow:'No provenance.',shareUnavailable:'Sharing unavailable.',withdrawUnavailable:'Withdrawal unavailable.'};
function RealGame(){
 const data=useGateData({leftKind:'task',rightKind:'work_session',seam});
 const loadMap=useMemo(()=>createGameMapLoader(data.seam,data.spaceId),[data.seam,data.spaceId]);
 const onNotice=useCallback(()=>{},[]);
 useEffect(()=>{
  const select=()=>{const id=location.hash.match(/^#\/s\/([^/]+)/)?.[1]??setup.spaceId;if(data.spaces.some(space=>space.id===id)&&data.spaceId!==id)data.selectSpace(id as any);route();};
  select();window.addEventListener('hashchange',select);return()=>window.removeEventListener('hashchange',select);
 },[data.spaces,data.spaceId,data.selectSpace]);
 return data.ready&&data.viewerActor?<GameScreen key={`${data.spaceId}:${data.viewerActor.id}`} data={data} memberId={data.viewerActor.id} loadMap={loadMap} reasons={reasons} onNotice={onNotice}/>:<div>{data.bootError??`Loading real Game data (ready=${data.ready}, space=${data.spaceId}, viewer=${data.viewerActor?.id??'pending'})`}</div>;
}
const GateApp=lazy(()=>import('../src/views/GateApp').then(module=>({default:module.GateApp})));
if(setup.narrow){writeLastSpace(nodeKeyOf(undefined),location.hash.match(/^#\/s\/([^/]+)/)?.[1]??setup.spaceId);route();}
createRoot(document.getElementById('root')!).render(setup.narrow?<div className="cv2-root" data-theme="light" style={{height:'100vh',width:'100%',minHeight:0,display:'flex'}}><RealGame/></div>:<Suspense fallback="Loading production shell"><GateApp seam={seam}/></Suspense>);
