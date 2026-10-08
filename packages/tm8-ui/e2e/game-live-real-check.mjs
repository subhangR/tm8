import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const fixture=JSON.parse(await readFile(process.env.GAME_FIXTURE_FILE??'/tmp/tm8-live-verifier-infra-01a11c29/fixture.json','utf8'));
const output=process.env.GAME_EVIDENCE_DIR??'/tmp/tm8-live-verifier-evidence-01a11c29';await mkdir(output,{recursive:true});
const checks=[],errors=[],responses=[],timings=[],sessions=[],scenes=[];
const pendingAssets=new Set(),assetFailures=[];
const fallback=process.env.GAME_FALLBACK==='1',noScreenshots=process.env.GAME_NO_SCREENSHOTS==='1';
console.log('Launching isolated Chromium');
const browser=await chromium.launch({headless:true,executablePath:process.env.GAME_CHROMIUM,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',...(fallback?['--disable-webgl','--disable-gpu']:[]),...(process.env.GAME_SINGLE_PROCESS==='1'?['--no-zygote','--single-process']:[])]});
console.log('Chromium launched');
process.on('SIGTERM',()=>browser.close().finally(()=>process.exit(143)));
const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:process.env.GAME_REDUCED_MOTION==='1'?'reduce':'no-preference'});
console.log('Page created');page.setDefaultTimeout(60000);page.on('pageerror',e=>{errors.push(e.message);console.log('Browser error',e.message);});
page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/v2/'))responses.push({url:new URL(r.url()).pathname,status:r.status()});});
page.on('request',request=>{if(/\.(glb|gltf|bin)(\?|$)/.test(request.url()))pendingAssets.add(request);});
page.on('requestfinished',request=>pendingAssets.delete(request));
page.on('requestfailed',request=>{if(pendingAssets.delete(request))assetFailures.push(request.failure()?.errorText??'Asset failed');});
await page.addInitScript(setup=>window.__GAME_LIVE_SETUP__=setup,{...fixture,narrow:process.env.GAME_NARROW==='1'});
const record=text=>{checks.push(text);console.log(text);};
const rpc=async(op,args,sessionId)=>{const response=await fetch(fixture.controlUrl,{method:'POST',body:JSON.stringify({op,args,sessionId})});const body=await response.json();if(!response.ok)throw new Error(`${op}: ${JSON.stringify(body)}`);return body;};
const save=()=>page.evaluate(spaceId=>{for(const key of Object.keys(localStorage)){if(!key.startsWith('tm8:game:v1:'))continue;const value=JSON.parse(localStorage.getItem(key));if(value.spaceId===spaceId)return value;}return null;},fixture.spaceId);
const host=page.getByTestId('walking-map');
const enter=async title=>{const details=host.locator('details.walking-places');if(await details.count())await details.evaluate(el=>el.open=true);await host.getByRole('button',{name:`Enter ${title}`,exact:true}).evaluate(el=>setTimeout(()=>el.click(),0));};
let expectedNavigation,driver;
const waitMap=async(type,kind,id)=>{expectedNavigation={type,scope:{kind,id}};console.log('Waiting for map',expectedNavigation);await expect.poll(async()=>{const v=await save();return v?.current;},{timeout:60000}).toMatchObject(expectedNavigation);await expect(host).toHaveAttribute('data-map-id',`map:${kind}:${id}:${type}`);await expect(host).toHaveAttribute('data-renderer',fallback?'dom':'webgl');if(!fallback){await host.locator('canvas').first().waitFor();await expect.poll(()=>host.locator('.ms-label').evaluateAll(nodes=>nodes.filter(n=>n.parentElement.style.display!=='none').length),{timeout:60000}).toBeGreaterThan(0);}};
const back=()=>host.getByRole('button',{name:/^Back/}).first().evaluate(el=>setTimeout(()=>el.click(),0));
const event=async(type,id)=>expect.poll(()=>page.evaluate(({type,id})=>window.__gameLive.events.some(e=>e.type===type&&(!id||[e.taskId,e.sessionId,e.entity?.id,e.edge?.source?.id,e.sourceId].includes(id))),{type,id}),{timeout:30000}).toBe(true);
const work=(id,status,sessionId)=>rpc('set_work_state',[id,status,null,null,'Synthetic journey',crypto.randomUUID(),false,true],sessionId);
const spawn=async(taskId,title)=>{
 const sessionId=await page.evaluate(async input=>window.__gameLive.spawn(input),{clientMutationId:crypto.randomUUID(),spaceId:fixture.spaceId,teamMemberId:fixture.teamMemberId,
  taskIds:[taskId],workdir:{mode:'scratch'},mode:'worker',model:'claude-sonnet-4-5',agentTool:'claude-code',accessMode:'fullAccess',credentialSources:{anthropic:'node',github:'node'},title,harnessSurface:'minimal',cols:80,rows:24});
 if(!sessionId)throw new Error('No native synthetic session created');sessions.push(sessionId);await event('session.process_changed',sessionId);return sessionId;
};
const claimId=async(sessionId,taskId)=>{
 await expect.poll(()=>page.evaluate(({sessionId,taskId})=>window.__gameLive.events.filter(e=>e.type==='edge.upsert'&&e.edge.type==='working_on'&&e.edge.source.id===sessionId&&e.edge.target.id===taskId).at(-1)?.edge.id,{sessionId,taskId}),{timeout:30000}).toBeTruthy();
 return page.evaluate(({sessionId,taskId})=>window.__gameLive.events.filter(e=>e.type==='edge.upsert'&&e.edge.type==='working_on'&&e.edge.source.id===sessionId&&e.edge.target.id===taskId).at(-1).edge.id,{sessionId,taskId});
};
const showWorker=async(id,text)=>{const row=host.locator(`[data-worker-id="robot:${id}"]`);await row.waitFor({state:'attached'});await host.locator('details.walking-workers').evaluate(el=>el.open=true);if(text)await expect(row).toContainText(text);return row;};
const scene=()=>page.evaluate(()=>window.__gameLive.sceneSnapshot());
const closeWorker=async(workerId,taskTitle)=>{
 if(fallback)return null;
 const before=await scene(),workerBefore=before.workers.find(worker=>worker.id===`robot:${workerId}`);expect(workerBefore).toBeTruthy();
 const details=host.locator('details.walking-places');await details.evaluate(el=>el.open=true);
 await host.getByTitle(`Walk to ${taskTitle}`,{exact:true}).evaluate(el=>setTimeout(()=>el.click(),0));await details.evaluate(el=>el.open=false);
 let previous=await scene(),stationary=0;
 await expect.poll(async()=>{const current=await scene();if(current.frames<=previous.frames)return false;
  const worker=current.workers.find(item=>item.id===`robot:${workerId}`);expect(worker?.uuid).toEqual(workerBefore.uuid);
  const ready=worker?.visible&&worker.inView&&worker.skinnedMeshes>0&&Math.hypot(current.player.position.x-worker.position.x,current.player.position.z-worker.position.z)<12&&current.cameraPose.zoom>20;
  stationary=ready&&JSON.stringify(current.player.position)===JSON.stringify(previous.player.position)?stationary+1:0;previous=current;return stationary>=3;
 },{timeout:60000,intervals:[200,400,800]}).toBe(true);
 const after=await scene();expect(after.sceneId).toEqual(before.sceneId);expect(after.cameraId).toEqual(before.cameraId);expect(after.player.id).toEqual(before.player.id);expect(after.workers.find(worker=>worker.id===`robot:${workerId}`).uuid).toEqual(workerBefore.uuid);
 return {input:'Production Places Walk-to after behavioral assertions',taskTitle,workerId:`robot:${workerId}`,workerUuid:workerBefore.uuid,before,after};
};
const shot=async(name,workerId,closeFrame)=>{let capture,viewAdjustment;if(!fallback&&workerId){const before=await scene();if(before?.workers.some(worker=>worker.id===`robot:${workerId}`&&!worker.inView)){if(await host.getByRole('button',{name:/^Map overview/}).count()){await host.focus();await page.keyboard.press('m');viewAdjustment='Production Map overview key after behavioral assertions';}else{await expect(host.getByRole('button',{name:/^Back to explorer/})).toHaveAttribute('aria-pressed','true');viewAdjustment='Production Map overview already active';}}}if(!fallback){await host.locator('.sgm-stage canvas[data-engine]').waitFor();await expect.poll(()=>host.locator('.ms-label').evaluateAll(nodes=>nodes.filter(n=>n.parentElement.style.display!=='none').length),{timeout:30000}).toBeGreaterThan(0);await expect.poll(async()=>{const s=await scene();return !!s&&s.frames>0&&s.calls>0&&s.width>400&&s.height>300&&s.assets.pending===0&&s.assets.failed===0&&pendingAssets.size===0&&assetFailures.length===0&&(!workerId||s.workers.some(w=>w.id===`robot:${workerId}`&&w.visible&&w.inView&&w.skinnedMeshes>0));},{timeout:30000}).toBe(true);await page.evaluate(()=>document.fonts.ready);capture={name,viewAdjustment,closeFrame,startedAt:Date.now(),...await scene()};scenes.push(capture);}if(!noScreenshots)await page.screenshot({path:`${output}/${name}.png`,timeout:90000});if(capture){capture.afterCapture=await scene();capture.captureMs=Date.now()-capture.startedAt;}};
const tick=async(taskId,done)=>page.evaluate(async({taskId,done})=>{
 const detail=await window.__gameLive.seam.entity(taskId);const response=await fetch(`/v2/entities/${taskId}/commands/tick`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientMutationId:crypto.randomUUID(),expectedVersion:detail.version,criterionIds:['proof'],done})});
 if(!response.ok)throw new Error(`Tick failed ${response.status}: ${await response.text()}`);
},{taskId,done});
const pose=async()=>{await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));const value=await save();return value.maps[JSON.stringify([value.current.scope.kind,value.current.scope.id,value.current.type])];};
const cameraTolerance=0.0001;
const maxDelta=(a,b)=>Math.max(...a.map((value,index)=>Math.abs(value-b[index])));
const equalSavedPose=(actual,expected)=>{expect(actual.position).toEqual(expected.position);if(fallback)expect(actual).toEqual(expected);else{expect(maxDelta(actual.camera.position,expected.camera.position)).toBeLessThan(cameraTolerance);expect(maxDelta(actual.camera.target,expected.camera.target)).toBeLessThan(cameraTolerance);expect(Math.abs(actual.camera.zoom-expected.camera.zoom)).toBeLessThan(cameraTolerance);}};
const settlePose=async(initialPosition)=>{
 await expect.poll(async()=>JSON.stringify((await pose())?.position??null),{timeout:30000}).not.toEqual(JSON.stringify(initialPosition));
 if(fallback)return;
 let previous=await scene(),stationary=0;
 await expect.poll(async()=>{const current=await scene();if(!current?.player?.id||current.frames-previous.frames<2)return false;
  const stable=maxDelta(current.cameraPose.position,previous.cameraPose.position)<cameraTolerance/10&&maxDelta(current.cameraPose.quaternion,previous.cameraPose.quaternion)<cameraTolerance/10&&Math.abs(current.cameraPose.zoom-previous.cameraPose.zoom)<cameraTolerance/10;previous=current;
  const saved=await pose();stationary=stable&&!!saved?.camera&&saved.position.x===current.player.position.x&&saved.position.z===current.player.position.z&&maxDelta(saved.camera.position,current.cameraPose.position)<cameraTolerance?stationary+1:0;return stationary>=3;
 },{timeout:60000,intervals:[200,400,800]}).toBe(true);
};
try{
 await page.goto('http://127.0.0.1:18533/e2e/game-live-real-harness.html');
 console.log('Real harness loaded');
 if(process.env.GAME_EXACT_HEAD){expect(fixture.sourceHead).toEqual(process.env.GAME_SERVER_HEAD??process.env.GAME_EXACT_HEAD);expect(await page.evaluate(()=>window.__gameLive.head)).toEqual(process.env.GAME_EXACT_HEAD);}
 console.log('Initial body', (await page.locator('body').innerText()).slice(0,1000));
 if(process.env.GAME_NARROW!=='1'){await page.getByTestId('tws-view-select').click();await page.getByRole('menuitemradio',{name:'Game',exact:true}).click();}
 await waitMap('hub','space',fixture.spaceId);await enter('Taskland');await waitMap('taskland','space',fixture.spaceId);
 record(`Shipping ${process.env.GAME_NARROW==='1'?'GameScreen/useGateData':'GateApp/GameScreen'}/GameMode space Taskland loaded through real seam`);
 await shot('initial-space');
 if(!fallback){driver=await page.evaluate(()=>{
  const canvas=document.querySelector('.sgm-stage canvas[data-engine]'),gl=canvas?.getContext('webgl2');
  const measuredOn='ready connected production scene canvas';
  if(!gl)return {renderer:null,vendor:null,rawRenderer:null,rawVendor:null,version:null,shadingLanguageVersion:null,debugExtension:false,reason:'Existing WebGL2 scene context unavailable',measuredOn};
  const ext=gl.getExtension('WEBGL_debug_renderer_info');
  return {renderer:ext?String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)):null,vendor:ext?String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)):null,rawRenderer:String(gl.getParameter(gl.RENDERER)),rawVendor:String(gl.getParameter(gl.VENDOR)),version:String(gl.getParameter(gl.VERSION)),shadingLanguageVersion:String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),debugExtension:!!ext,reason:ext?null:'WEBGL_debug_renderer_info unavailable',measuredOn};
 });console.log('Actual GL driver',JSON.stringify(driver));}
 await writeFile(`${output}/probe.json`,JSON.stringify({checks,errors,responses,text:await page.locator('body').innerText()},null,2));
 if(process.env.GAME_PROBE_ONLY!=='1'){
  for(const scope of ['space','story']){
   if(scope==='story'){await back();await waitMap('hub','space',fixture.spaceId);await enter('Synthetic live-worker story');await waitMap('hub','story',fixture.storyId);await enter('Taskland');await waitMap('taskland','story',fixture.storyId);}
   const prefix=`${scope}-${process.env.GAME_REDUCED_MOTION==='1'?'reduced':'motion'}`;
   const create=async title=>{const result=await rpc('create_task',[fixture.spaceId,title,null,'Synthetic fixture',{},null,null,'medium',JSON.stringify([{id:'proof',text:'Verification proof',done:false}]),3]);const id=result.entity.id;await rpc('set_collection_item',[fixture.storyId,id]);return id;};
   const taskA=await create(`${prefix} site A`),taskB=await create(`${prefix} site B`);
   await expect(host.getByText(`${prefix} site A`,{exact:true}).first()).toBeAttached({timeout:30000});
   record(`${scope}: authoritative task creation admitted and rendered`);
   const sessionId=await spawn(taskA,`${prefix} synthetic worker`),edgeA=await claimId(sessionId,taskA);
   await showWorker(edgeA,`${prefix} site A`);const startFrame=scope==='story'||process.env.GAME_REDUCED_MOTION==='1'?await closeWorker(edgeA,`${prefix} site A`):null;await shot(`${prefix}-start`,edgeA,startFrame);
   const sessionDetail=await page.evaluate(id=>window.__gameLive.seam.entity(id),sessionId);
   expect(sessionDetail.storyIds??[]).toEqual([]);
   record(`${scope}: native synthetic PTY claim starts rendered ${fallback?'worker HUD':'WorkerLayer'}, session has no storyIds`);
   const initialPosition=(!fallback?(await scene())?.player?.position:(await pose())?.position)??null;
   await host.focus();await page.keyboard.down('d');try{await expect.poll(async()=>JSON.stringify((fallback?(await pose())?.position:(await scene())?.player?.position)??null),{timeout:30000}).not.toEqual(JSON.stringify(initialPosition));}finally{await page.keyboard.up('d');}await settlePose(initialPosition);
   const before=await pose(),sceneBefore=fallback?null:await scene(),canvas=crypto.randomUUID(),surface=fallback?host:host.locator('.sgm-stage canvas[data-engine]');await surface.evaluate((el,id)=>el.__verificationIdentity=id,canvas);
   const begin=Date.now(),burstSample={scope,burstCommands:21,cameraTolerance,before,beforeScene:sceneBefore};timings.push(burstSample);
   for(let i=0;i<20;i++)await work(taskA,i%2?'working':'blocked',sessionId);
   await event('task.status_changed',taskA);const activeWorker=await showWorker(edgeA);await expect(activeWorker).not.toContainText('blocked');
   expect((await page.evaluate(id=>window.__gameLive.seam.entity(id),taskA)).state.status).toEqual('working');
   await expect(activeWorker).toHaveCount(1);
   const workerIds=await host.locator('[data-worker-id]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-worker-id')));
   expect(new Set(workerIds).size).toEqual(workerIds.length);
   await expect(page.locator('[data-effect-id]')).toContainText('map updates in the last minute');
   const effectId=await page.locator('[data-effect-id]').getAttribute('data-effect-id');
   await work(taskA,'blocked',sessionId);await showWorker(edgeA,'blocked');
   expect(await page.locator('[data-effect-id]').getAttribute('data-effect-id')).toEqual(effectId);
   expect(await surface.evaluate(el=>el.__verificationIdentity)).toEqual(canvas);
   const afterPose=await pose();Object.assign(burstSample,{elapsedMs:Date.now()-begin,after:afterPose,afterScene:fallback?null:await scene()});expect(afterPose.position).toEqual(before.position);
   if(sceneBefore){const after=await scene();expect(after.sceneId).toEqual(sceneBefore.sceneId);expect(after.cameraId).toEqual(sceneBefore.cameraId);expect(after.player.id).toEqual(sceneBefore.player.id);expect(after.player.position).toEqual(sceneBefore.player.position);expect(after.workers.find(w=>w.id===`robot:${edgeA}`).uuid).toEqual(sceneBefore.workers.find(w=>w.id===`robot:${edgeA}`).uuid);expect(maxDelta(after.cameraPose.position,sceneBefore.cameraPose.position)).toBeLessThan(cameraTolerance);expect(maxDelta(after.cameraPose.quaternion,sceneBefore.cameraPose.quaternion)).toBeLessThan(cameraTolerance);expect(maxDelta(afterPose.camera.position,before.camera.position)).toBeLessThan(cameraTolerance);expect(maxDelta(afterPose.camera.target,before.camera.target)).toBeLessThan(cameraTolerance);expect(Math.abs(afterPose.camera.zoom-before.camera.zoom)).toBeLessThan(cameraTolerance);}else expect(afterPose).toEqual(before);
   record(`${scope}: burst immediately updates worker pose, combines effects with stable identity and preserves canvas/player/camera`);
   await shot(`${prefix}-burst`,edgeA);
   await tick(taskA,true);await event('task.criterion_changed',taskA);await tick(taskA,false);
   await work(taskB,'working',sessionId);const edgeB=await claimId(sessionId,taskB);
   await rpc('release_task_claim',[taskA,'Synthetic move to next site'],sessionId);
   await showWorker(edgeB,`${prefix} site B`);await expect(host.locator(`[data-worker-id="robot:${edgeA}"]`)).toHaveCount(0);
   if(!fallback)await expect.poll(async()=>(await scene()).workers.some(w=>w.id===`robot:${edgeA}`),{timeout:30000}).toBe(false);
   record(`${scope}: real claim/release moves worker to second task and edge.ended removes first claim`);await shot(`${prefix}-move`,edgeB,await closeWorker(edgeB,`${prefix} site B`));
   await work(taskB,'in_review',sessionId);const receipt=await rpc('receipt',[sessionId]);
   await rpc('complete_work_session',[sessionId,receipt.messageId]);await event('session.outcome_changed',sessionId);
   await showWorker(edgeB,'Returning to Office');await shot(`${prefix}-complete`);
   const completed=await page.evaluate(id=>window.__gameLive.seam.entity(id),sessionId);
   expect(completed.state.outcome).toEqual('completed');expect(['running','idle']).toContain(completed.state.status);
   await work(taskA,'working',sessionId);await showWorker(edgeA,`${prefix} site A`);
   expect((await page.evaluate(id=>window.__gameLive.seam.entity(id),sessionId)).state.outcome).toEqual('open');
   record(`${scope}: completion ends claims while process remains running; new claim reopens same session and stable claim ID`);
   if(scope==='story'){
    await page.reload();await host.waitFor();await waitMap('taskland','story',fixture.storyId);await showWorker(edgeA,`${prefix} site A`);
    record('story: cold loader admits session through authoritative working_on without storyIds');
   }
   await shot(`${prefix}-reopened-close`,edgeA,await closeWorker(edgeA,`${prefix} site A`));
   await rpc('stop_work_session',[sessionId,'Synthetic stop']);await event('session.outcome_changed',sessionId);
   await expect(host.locator(`[data-worker-id="robot:${edgeA}"]`)).toHaveCount(0);await expect(host.getByText('Returning to Office',{exact:true})).toHaveCount(0);
   if(!fallback)await expect.poll(async()=>(await scene()).workers.some(w=>w.id===`robot:${edgeA}`||w.id===`robot:${edgeB}`),{timeout:30000}).toBe(false);
   record(`${scope}: stopped outcome removes worker without completion departure`);await shot(`${prefix}-stop`);
   const failed=await spawn(taskB,`${prefix} failing worker`);await work(taskB,'working',failed);const failedEdge=await claimId(failed,taskB);await showWorker(failedEdge);
   await rpc('processFail',[],failed);await event('session.process_changed',failed);
   await expect.poll(()=>page.evaluate(async id=>(await window.__gameLive.seam.entity(id)).state.status,failed),{timeout:30000}).toEqual('failed');
   await expect(host.locator(`[data-worker-id="robot:${failedEdge}"]`)).toHaveCount(0);record(`${scope}: actual synthetic process exit7 removes worker without completion departure`);
  }
  await page.evaluate(id=>window.__gameLive.seam.openSpace(id),fixture.foreignSpaceId);
  const before=await pose(),effect=await page.locator('[data-effect-id]').getAttribute('data-effect-id');
  const foreign=await rpc('create_task',[fixture.foreignSpaceId,'FOREIGN-SCOPE-REJECTED']);await event('entity.upsert',foreign.entity.id);
  await expect(host.getByText('FOREIGN-SCOPE-REJECTED',{exact:true})).toHaveCount(0);equalSavedPose(await pose(),before);expect(await page.locator('[data-effect-id]').getAttribute('data-effect-id')).toEqual(effect);
  record('Actual subscribed foreign-space event reaches seam and is rejected by active map');
  await page.evaluate(()=>window.__gameLive.delayReads());await back();await expect.poll(()=>page.evaluate(()=>window.__gameLive.pending()),{timeout:30000}).toBeGreaterThan(0);
  await page.evaluate(id=>{location.hash=`#/s/${id}/work`;window.__gameLive.releaseReads();},fixture.foreignSpaceId);
  await expect(host).toHaveAttribute('data-map-id',`map:space:${fixture.foreignSpaceId}:hub`);record('Route/scope navigation isolates pending old-map reads and callbacks');
  if(errors.length)throw new Error(`Browser runtime errors: ${errors.join('; ')}`);
  const stats=await page.evaluate(()=>({eventTypes:window.__gameLive.eventCounts,readsSinceLastReload:window.__gameLive.reads.length}));
  await writeFile(`${output}/report.json`,JSON.stringify({passed:true,bundleHead:process.env.GAME_EXACT_HEAD,runnerHead:process.env.GAME_RUNNER_HEAD,dependencies:process.env.GAME_DEPENDENCY_HEADS,renderer:fallback?'Production DOM fallback; no 3D WorkerLayer evidence':fixture.renderer,driver,headless:true,softwareRequested:true,nativeEligible:false,checks,timings,scenes,stats,responses,errors},null,2));
 }
}catch(error){console.log('Journey failed',String(error));const diagnostic=await page.evaluate(()=>({url:location.href,saves:Object.keys(localStorage).filter(k=>k.startsWith('tm8:game')).map(k=>({key:k,value:JSON.parse(localStorage.getItem(k))})),reads:window.__gameLive?.reads?.slice(-10),events:window.__gameLive?.events?.slice(-10)}));await writeFile(`${output}/report.json`,JSON.stringify({passed:false,bundleHead:process.env.GAME_EXACT_HEAD,runnerHead:process.env.GAME_RUNNER_HEAD,driver,headless:true,softwareRequested:true,nativeEligible:false,checks,timings,scenes,sceneAtFailure:fallback?null:await scene(),errors,responses,failure:String(error),expectedNavigation,diagnostic,text:await page.locator('body').innerText()},null,2));await page.screenshot({path:`${output}/failure.png`,timeout:10000}).catch(()=>{});throw error;}
finally{await browser.close();}
