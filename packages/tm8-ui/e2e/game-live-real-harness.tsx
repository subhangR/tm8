/** All records and events originate from a disposable real server. */
import { createRoot } from 'react-dom/client';
import { GateApp } from '../src/views/GateApp';
import { createRealSeam } from '../src/data/real/seam-real';
import { browserWebSocketFactory } from '../src/data/real/socket';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
const setup=(window as any).__GAME_LIVE_SETUP__;
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
Object.assign(window,{__gameLive:{events,reads,seam,
 delayReads:()=>{delayed=true;},releaseReads:()=>{delayed=false;pending.splice(0).forEach(resolve=>resolve());},pending:()=>pending.length}});
if(!location.hash)location.hash=`#/s/${setup.spaceId}/work`;
createRoot(document.getElementById('root')!).render(<GateApp seam={seam}/>);
