/** All records and events originate from a disposable real server. */
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { GameScreen } from '../src/views/GameScreen';
import { useGateData } from '../src/views/useGateData';
import { createGameMapLoader } from '../src/data/game-maps';
import { resetNav } from '../src/stores/navStore';
import { writeLastSpace } from '../src/views/last-place';
import { nodeKeyOf } from '../src/data/launch-cache';
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
let delayed=false;
seam.onEvent(event=>events.push(structuredClone(event)));
for(const name of ['query','entity','graph'] as const){
 const original=seam[name].bind(seam) as Function;
 (seam as any)[name]=async(...args:unknown[])=>{
  const start=performance.now();const result=await original(...args);
  if(delayed)await new Promise<void>(resolve=>pending.push(resolve));
  reads.push({name,args,start,end:performance.now()});return result;
 };
}
Object.assign(window,{__gameLive:{events,reads,seam,head:__GAME_VERIFIER_HEAD__,spawn:async(input:any)=>createdIdOf(await seam.commands.spawn(input)),
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
