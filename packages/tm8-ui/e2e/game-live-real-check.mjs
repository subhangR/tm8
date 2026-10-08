import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const fixture=JSON.parse(await readFile(process.env.GAME_FIXTURE_FILE??'/tmp/tm8-live-verifier-infra-01a11c29/fixture.json','utf8'));
const output=process.env.GAME_EVIDENCE_DIR??'/tmp/tm8-live-verifier-evidence-01a11c29';await mkdir(output,{recursive:true});
const checks=[],errors=[],responses=[],timings=[],sessions=[],scenes=[],handoffs=[],mapReadiness=[];
const observerOverhead='Read-only worker traversals plus actual Player and DOM React-state traversals before/after each bundled R3F loop, with copied transforms, model/input geometry and bounded frame series. These instrumented timings are behavioral evidence, not performance evidence.';
const pendingAssets=new Set(),assetFailures=[];
const fallback=process.env.GAME_FALLBACK==='1',noScreenshots=process.env.GAME_NO_SCREENSHOTS==='1';
console.log('Launching isolated Chromium');
const browser=await chromium.launch({headless:true,executablePath:process.env.GAME_CHROMIUM,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',...(fallback?['--disable-webgl','--disable-gpu']:[]),...(process.env.GAME_SINGLE_PROCESS==='1'?['--no-zygote','--single-process']:[])]});
console.log('Chromium launched');
const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:process.env.GAME_REDUCED_MOTION==='1'?'reduce':'no-preference'});
process.on('SIGTERM',()=>page.evaluate(()=>window.__gameLive?.stopWorkerFrameAudit?.()).catch(()=>{}).finally(()=>browser.close().finally(()=>process.exit(143))));
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
let navigationSave=null;
const navigateButton=async(button,input)=>{
 await button.evaluate((el,{spaceId,input})=>{
  window.__navSave=null;
  setTimeout(()=>{
   let value=null;for(const key of Object.keys(localStorage)){if(!key.startsWith('tm8:game:v1:'))continue;const candidate=JSON.parse(localStorage.getItem(key));if(candidate.spaceId===spaceId){value=candidate;break;}}
   window.__navSave={input,value,capturedAt:performance.now(),capturedDate:Date.now(),source:'Production localStorage save copied immediately before the actual button click'};
   el.click();
  },0);
 },{spaceId:fixture.spaceId,input});
 await expect.poll(async()=>{navigationSave=await page.evaluate(()=>window.__navSave);return navigationSave;},{timeout:30000}).toBeTruthy();
};
const enter=async title=>{const details=host.locator('details.walking-places');if(await details.count())await details.evaluate(el=>el.open=true);await navigateButton(host.getByRole('button',{name:`Enter ${title}`,exact:true}),`Enter ${title}`);};
let expectedNavigation,driver;
const waitMap=async(type,kind,id)=>{
 expectedNavigation={type,scope:{kind,id}};console.log('Waiting for map',expectedNavigation);
 await expect.poll(async()=>{const v=await save();return v?.current;},{timeout:60000}).toMatchObject(expectedNavigation);
 const mapId=`map:${kind}:${id}:${type}`;await expect(host).toHaveAttribute('data-map-id',mapId);
 await expect(host).toHaveAttribute('data-renderer',fallback?'dom':'webgl');
 if(!fallback){
  await host.locator('canvas').first().waitFor();
  const readiness={mapId,expectedNavigation,navigationSave,rule:'Attached labels and two advancing actual frames on the expected map, with drawn calls, loaded assets and observed Player; visibility remains a screenshot gate'};mapReadiness.push(readiness);
  await expect.poll(async()=>{
   const actual=await scene();readiness.actual=actual;
   if(!actual?.proximity.observed||actual.proximity.modelId!==mapId||!actual.player?.id)return false;
   if(!readiness.baseline||readiness.baseline.sceneId!==actual.sceneId)readiness.baseline={sceneId:actual.sceneId,frames:actual.frames};
   readiness.attachedLabels=await host.locator('.ms-label').count();
   if(actual.frames<readiness.baseline.frames+2||actual.calls<=0||actual.assets.pending!==0||actual.assets.failed!==0||readiness.attachedLabels<=0)return false;
   const audit=await cameraAudit();readiness.firstObservedFrame=audit.frames.find(frame=>frame.after.sceneUuid===actual.sceneId&&audit.publications[frame.after.publicationId]?.current.id===mapId);
   expect(readiness.firstObservedFrame).toBeTruthy();
   readiness.passedAuditIndex=audit.index;expect(readiness.firstObservedFrame.index).toBeLessThanOrEqual(readiness.passedAuditIndex);
   if(process.env.GAME_REDUCED_MOTION==='1'){
    const first=readiness.firstObservedFrame,savedMapKey=JSON.stringify([kind,id,type]);
    readiness.reducedCheck={restored:first.after.restored,reduced:first.after.reduced,cameraZoom:first.after.cameraZoom,desiredZoom:first.desiredZoom,zoomEquationError:first.zoomEquationError,firstFrameIndex:first.index,savedMapKey,savedZoom:navigationSave?.value?.maps?.[savedMapKey]?.camera?.zoom};
    expect(first.after.reduced).toBe(true);
    if(first.after.restored){
     expect(readiness.reducedCheck.savedZoom).toEqual(expect.any(Number));
     expect(first.after.cameraZoom).toEqual(readiness.reducedCheck.savedZoom);
    }else{
     expect(first.after.cameraZoom).toEqual(first.desiredZoom);
     expect(first.zoomEquationError).toEqual(0);
    }
   }
   return true;
  },{timeout:60000}).toBe(true);
 }
};
const back=()=>navigateButton(host.getByRole('button',{name:/^Back/}).first(),'Back');
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
const frameAudit=()=>page.evaluate(()=>window.__gameLive.workerFrameAudit());
const cameraState=()=>page.evaluate(()=>window.__gameLive.playerCameraState());
const cameraAudit=()=>page.evaluate(()=>window.__gameLive.cameraAudit());
const clearStoryBaseline=async(taskId)=>{
 const audit=await cameraAudit(),actual=await cameraState(),publication=audit.publications[actual.publicationId],world=audit.worlds[actual.worldId];
 const task=publication.current.places.find(place=>place.id===taskId),container=publication.current.layout.containers['@roots'],slot=container.slots[taskId];
 expect(task.parentId).toBeNull();expect(publication.current.places.some(place=>place.parentId===taskId)).toBe(false);
 // Prospective safety envelope only: layout.ts uses 6-unit district offsets;
 // build.ts caps task buckets at 13 and radius at 1.8 + sqrt(bucket)*.4.
 // These points are never substituted for actual model/world observations.
 const grownFootprint=Math.max(task.footprint,1.8+Math.sqrt(13)*.4),groupIndex=container.groupKeys.indexOf(slot.group);
 expect(groupIndex).toBeGreaterThanOrEqual(0);
 const possibleSlots=container.groupKeys.map((group,index)=>({group,x:slot.x+6*(index-groupIndex),z:slot.z,footprint:grownFootprint}));
 const obstacles=[...world.places,...possibleSlots],clearance=position=>Math.min(...obstacles.map(place=>Math.hypot(position.x-place.x,position.z-place.z)-place.footprint));
 const required=1.6+.5,releaseMargin=9*.25,candidates=[];
 for(let z=publication.current.bounds.minZ;z<=publication.current.bounds.maxZ;z+=.5){const point={x:actual.player.x,z};if(clearance(point)>required+releaseMargin)candidates.push(point);}
 candidates.sort((a,b)=>Math.abs(a.z-actual.player.z)-Math.abs(b.z-actual.player.z));expect(candidates.length).toBeGreaterThan(0);
 const goal=candidates[0],keys=goal.z<actual.player.z?['w','d']:['a','s'];
 await host.focus();try{for(const key of keys)await page.keyboard.down(key);await expect.poll(async()=>{const state=await cameraState();expect(state.observed).toBe(true);return goal.z<actual.player.z?state.player.z<=goal.z:state.player.z>=goal.z;},{timeout:30000,intervals:[100,200]}).toBe(true);}finally{for(const key of keys)await page.keyboard.up(key);}
 const after=await cameraState();expect(clearance(after.player)).toBeGreaterThan(required);
 return {input:'Real paired walking keys; no state or model writes',before:actual,world,publication,prospectiveSafetyEnvelope:{source:'map-model/layout.ts group offset 6; build.ts radius and maximum bucket 13',possibleSlots,grownFootprint,required,releaseMargin},goal,keys,after,minimumClearance:clearance(after.player)};
};
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
const noticeSnapshot=()=>page.evaluate(()=>{const map=document.querySelector('.game-mode__map'),bounds=map?.getBoundingClientRect();return {map:bounds?{width:bounds.width,height:bounds.height}:null,nodes:[...document.querySelectorAll('.game-mode__notices .game-mode__notice')].map(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {tag:node.tagName,text:node.textContent,visible:style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};})};});
const shot=async(name,workerId,closeFrame)=>{let capture,viewAdjustment;if(!fallback&&workerId){const before=await scene();if(before?.workers.some(worker=>worker.id===`robot:${workerId}`&&!worker.inView)){if(await host.getByRole('button',{name:/^Map overview/}).count()){await host.focus();await page.keyboard.press('m');viewAdjustment='Production Map overview key after behavioral assertions';}else{await expect(host.getByRole('button',{name:/^Back to explorer/})).toHaveAttribute('aria-pressed','true');viewAdjustment='Production Map overview already active';}}}if(!fallback){await host.locator('.sgm-stage canvas[data-engine]').waitFor();await expect.poll(()=>host.locator('.ms-label').evaluateAll(nodes=>nodes.filter(n=>n.parentElement.style.display!=='none').length),{timeout:30000}).toBeGreaterThan(0);await expect.poll(async()=>{const s=await scene();return !!s&&s.frames>0&&s.calls>0&&s.width>400&&s.height>300&&s.assets.pending===0&&s.assets.failed===0&&pendingAssets.size===0&&assetFailures.length===0&&(!workerId||s.workers.some(w=>w.id===`robot:${workerId}`&&w.visible&&w.inView&&w.skinnedMeshes>0));},{timeout:30000}).toBe(true);await page.evaluate(()=>document.fonts.ready);capture={name,viewAdjustment,closeFrame,startedAt:Date.now(),...await scene()};capture.notices=await noticeSnapshot();scenes.push(capture);if(name.startsWith('story-')&&name.endsWith('-start'))expect(capture.notices.nodes.some(node=>node.tag==='DETAILS'&&node.visible&&node.text.includes('Map notices'))).toBe(true);}if(!noScreenshots)await page.screenshot({path:`${output}/${name}.png`,timeout:90000});if(capture){capture.afterCapture=await scene();capture.noticesAfterCapture=await noticeSnapshot();capture.captureMs=Date.now()-capture.startedAt;}};
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
 let previous=await scene(),stationary=0,baseline=null;
 await expect.poll(async()=>{const current=await scene();if(!current?.player?.id||current.frames-previous.frames<2)return false;
  const actual=await cameraState();expect(actual?.observed).toBe(true);expect(actual.nearIdValid).toBe(true);
  const stable=maxDelta(current.cameraPose.position,previous.cameraPose.position)<cameraTolerance/10&&maxDelta(current.cameraPose.quaternion,previous.cameraPose.quaternion)<cameraTolerance/10&&Math.abs(current.cameraPose.zoom-previous.cameraPose.zoom)<cameraTolerance/10;previous=current;
  const saved=await pose(),quiet=stable&&actual.nearId===actual.publishedNearId&&actual.waypointsLength===0&&actual.keys.length===0&&actual.intro>=2.8&&!!saved?.camera&&saved.position.x===current.player.position.x&&saved.position.z===current.player.position.z&&maxDelta(saved.camera.position,current.cameraPose.position)<cameraTolerance&&Math.abs(saved.camera.zoom-current.cameraPose.zoom)<cameraTolerance;
  if(!quiet){stationary=0;baseline=null;return false;}
  stationary++;baseline??={startIndex:(await cameraAudit()).index,invalidCount:(await cameraAudit()).invalidCount,at:actual.at,nearId:actual.nearId,sceneUuid:actual.sceneUuid};
  if(actual.nearId!==baseline.nearId||actual.sceneUuid!==baseline.sceneUuid){stationary=0;baseline=null;return false;}
  return stationary>=3&&actual.at-baseline.at>=1000;
 },{timeout:60000,intervals:[200,400,800]}).toBe(true);
 const audit=await cameraAudit(),samples=audit.frames.filter(frame=>frame.index>baseline.startIndex);
 expect(samples).toHaveLength(audit.index-baseline.startIndex);expect(samples.length).toBeGreaterThanOrEqual(2);
 for(const frame of samples){expect(frame.after.nearId).toEqual(baseline.nearId);expect(frame.after.nearIdValid).toBe(true);expect(frame.alertMatchesPreviousNear).toBe(true);}
 return {...baseline,endIndex:audit.index,frames:samples,saved:await pose(),actual:await cameraState()};
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
   let baselineWalk;
   if((scope==='story'||startFrame)&&!fallback)baselineWalk=await clearStoryBaseline(taskA);
   else{await host.focus();await page.keyboard.down('d');try{await expect.poll(async()=>JSON.stringify((fallback?(await pose())?.position:(await scene())?.player?.position)??null),{timeout:30000}).not.toEqual(JSON.stringify(initialPosition));}finally{await page.keyboard.up('d');}}
   const baseline=await settlePose(initialPosition);
   if(!fallback){expect(baseline.actual.nearId).not.toEqual(taskA);if(scope==='story'||startFrame){expect(baseline.actual.nearId).toBeNull();const audit=await cameraAudit(),world=audit.worlds[baseline.actual.worldId];baseline.clearances=world.places.map(place=>({id:place.id,clearance:Math.hypot(baseline.actual.player.x-place.x,baseline.actual.player.z-place.z)-place.footprint}));expect(Math.min(...baseline.clearances.map(place=>place.clearance))).toBeGreaterThan(1.6+.5);}}
   const before=await pose(),sceneBefore=fallback?null:await scene(),canvas=crypto.randomUUID(),surface=fallback?host:host.locator('.sgm-stage canvas[data-engine]');await surface.evaluate((el,id)=>el.__verificationIdentity=id,canvas);
   const begin=Date.now(),burstSample={scope,burstCommands:21,cameraTolerance,baseline,baselineWalk,before,beforeScene:sceneBefore,beforeCamera:fallback?null:await cameraState(),eventStartIndex:await page.evaluate(()=>window.__gameLive.events.length)};timings.push(burstSample);
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
   if(!fallback){const postAt=await page.evaluate(()=>performance.now()),postFrame=(await scene()).frames;
    await expect.poll(async()=>{const audit=await cameraAudit(),samples=audit.frames.filter(frame=>frame.after.at>=postAt);return samples.length>=3&&samples.at(-1).after.at-postAt>=1000&&samples.at(-1).after.frame>postFrame;},{timeout:30000}).toBe(true);
   }
   const afterPose=await pose();Object.assign(burstSample,{elapsedMs:Date.now()-begin,after:afterPose,afterScene:fallback?null:await scene(),afterCamera:fallback?null:await cameraState()});
   burstSample.events=await page.evaluate(({start,taskId})=>window.__gameLive.events.slice(start).map(e=>({type:e.type,seq:e.seq,occurredAt:e.occurredAt,taskId:e.taskId,from:e.from,to:e.to,total:e.total,done:e.done,entity:e.entity?{id:e.entity.id,version:e.entity.version,category:e.entity.category,state:e.entity.state,pointsEstimate:e.entity.pointsEstimate,acceptance:e.entity.acceptance,counters:e.entity.counters}:null})),{start:burstSample.eventStartIndex,taskId:taskA});
   if(!fallback){const audit=await cameraAudit();burstSample.cameraInterval={startIndex:baseline.startIndex,endIndex:audit.index,frames:audit.frames.filter(frame=>frame.index>baseline.startIndex),publications:audit.publications,worlds:audit.worlds,invalid:audit.invalid.filter(row=>row.at>=baseline.at)};
    const publicationIds=[...new Set([...burstSample.cameraInterval.frames].sort((a,b)=>a.index-b.index).flatMap(frame=>[frame.before.publicationId,frame.after.publicationId]))];
    const place=model=>model?.places.find(place=>place.id===taskA),rows=publicationIds.map(id=>{const publication=audit.publications[id];return {source:'publication previous/current',publicationId:id,before:place(publication.previous),after:place(publication.current),beforeLayout:publication.previous?.layout,layout:publication.current.layout};});
    for(let i=1;i<publicationIds.length;i++){const beforeId=publicationIds[i-1],id=publicationIds[i],before=audit.publications[beforeId].current,after=audit.publications[id].current;rows.push({source:'consecutive frame-observed publications',beforePublicationId:beforeId,publicationId:id,before:place(before),after:place(after),beforeLayout:before.layout,layout:after.layout});}
    const relocationKeys=new Set();burstSample.relocations=rows.filter(row=>{if(!row.before||!row.after||row.before.groupId===row.after.groupId||row.before.x===row.after.x)return false;const key=JSON.stringify([row.before.groupId,row.before.x,row.before.z,row.beforeLayout,row.after.groupId,row.after.x,row.after.z,row.layout]);if(relocationKeys.has(key))return false;relocationKeys.add(key);return true;});
    expect(burstSample.relocations.length).toBeGreaterThan(0);
    for(const row of burstSample.relocations){const fromKeys=row.beforeLayout.containers['@roots'].groupKeys,toKeys=row.layout.containers['@roots'].groupKeys,from=fromKeys.indexOf(row.before.groupId.replace('group:@roots:','')),to=toKeys.indexOf(row.after.groupId.replace('group:@roots:',''));expect(from).toBeGreaterThanOrEqual(0);expect(to).toBeGreaterThanOrEqual(0);row.expectedDistrictShift=6*(to-from);expect(Math.abs(row.after.x-row.before.x-row.expectedDistrictShift)).toBeLessThan(cameraTolerance);expect(Math.abs(row.after.z-row.before.z)).toBeLessThan(cameraTolerance);}
    if(scope==='story'||startFrame){const current=burstSample.afterCamera,world=audit.worlds[current.worldId],clearances=world.places.map(place=>({id:place.id,clearance:Math.hypot(current.player.x-place.x,current.player.z-place.z)-place.footprint}));burstSample.afterClearances=clearances;expect(Math.min(...clearances.map(place=>place.clearance))).toBeGreaterThan(1.6+.5);}
    expect(burstSample.cameraInterval.frames).toHaveLength(audit.index-baseline.startIndex);expect(burstSample.cameraInterval.invalid).toEqual([]);expect(audit.invalidCount).toEqual(baseline.invalidCount);
    expect(burstSample.afterCamera.nearId).toEqual(burstSample.beforeCamera.nearId);
    expect(burstSample.afterCamera.publishedNearId).toEqual(burstSample.afterCamera.nearId);
    for(const frame of burstSample.cameraInterval.frames){expect(frame.before.duel).toBeNull();expect(frame.after.duel).toBeNull();if(frame.zoomEquationError!==null)expect(frame.zoomEquationError).toBeLessThan(cameraTolerance);}
   }
   expect(afterPose.position).toEqual(before.position);
   if(sceneBefore){const after=await scene();expect(after.width).toEqual(sceneBefore.width);expect(after.height).toEqual(sceneBefore.height);expect(after.sceneId).toEqual(sceneBefore.sceneId);expect(after.cameraId).toEqual(sceneBefore.cameraId);expect(after.player.id).toEqual(sceneBefore.player.id);expect(after.player.position).toEqual(sceneBefore.player.position);expect(after.workers.find(w=>w.id===`robot:${edgeA}`).uuid).toEqual(sceneBefore.workers.find(w=>w.id===`robot:${edgeA}`).uuid);expect(maxDelta(after.cameraPose.position,sceneBefore.cameraPose.position)).toBeLessThan(cameraTolerance);expect(maxDelta(after.cameraPose.quaternion,sceneBefore.cameraPose.quaternion)).toBeLessThan(cameraTolerance);expect(maxDelta(afterPose.camera.position,before.camera.position)).toBeLessThan(cameraTolerance);expect(maxDelta(afterPose.camera.target,before.camera.target)).toBeLessThan(cameraTolerance);expect(Math.abs(afterPose.camera.zoom-before.camera.zoom)).toBeLessThan(cameraTolerance);}else expect(afterPose).toEqual(before);
   record(`${scope}: burst immediately updates worker pose, combines effects with stable identity and preserves canvas/player/camera`);
   await shot(`${prefix}-burst`,edgeA);
   await tick(taskA,true);await event('task.criterion_changed',taskA);await tick(taskA,false);
   const handoff={scope,expectation:'B earliest attached local x/z equals A last drawn local x/z within1e-4, same live-workers parent; normal first draw advances at most0.7; reduced first draw equals real motion target',releaseStartedAt:await page.evaluate(()=>performance.now()),beforeRelease:fallback?null:await scene(),auditBefore:fallback?null:await frameAudit()};handoffs.push(handoff);
   await rpc('release_task_claim',[taskA,'Synthetic move to next site'],sessionId);
   await expect(host.locator(`[data-worker-id="robot:${edgeA}"]`)).toHaveCount(0);
   if(!fallback){
    await expect.poll(async()=>(await scene()).workers.some(w=>w.id===`robot:${edgeA}`),{timeout:30000}).toBe(false);
    const aUuid=handoff.beforeRelease.workers.find(worker=>worker.id===`robot:${edgeA}`).uuid;
    await expect.poll(async()=>{const audit=await frameAudit(),current=await scene();return !!audit.records.find(record=>record.uuid===aUuid)?.detached&&current.frames>handoff.beforeRelease.frames;},{timeout:30000}).toBe(true);
   }
   handoff.absentAt=await page.evaluate(()=>performance.now());handoff.intermediateScene=fallback?null:await scene();
   await work(taskB,'working',sessionId);const edgeB=await claimId(sessionId,taskB);
   await showWorker(edgeB,`${prefix} site B`);handoff.claimObservedAt=await page.evaluate(()=>performance.now());
   handoff.events=await page.evaluate(({edgeA,edgeB})=>window.__gameLive.events.filter(e=>(e.type==='edge.ended'&&e.edgeId===edgeA)||(e.type==='edge.upsert'&&e.edge.id===edgeB)).map(e=>({type:e.type,seq:e.seq,edgeId:e.edgeId??e.edge.id,occurredAt:e.occurredAt})),{edgeA,edgeB});
   if(!fallback){
    await expect.poll(async()=>{const audit=await frameAudit();return audit.records.some(record=>record.id===`robot:${edgeB}`&&record.firstDrawn);},{timeout:30000}).toBe(true);
    handoff.auditAfter=await frameAudit();handoff.afterClaim=await scene();
    const aUuid=handoff.beforeRelease.workers.find(worker=>worker.id===`robot:${edgeA}`).uuid;
    const a=handoff.auditAfter.records.find(record=>record.uuid===aUuid),b=handoff.auditAfter.records.find(record=>record.id===`robot:${edgeB}`);
    Object.assign(handoff,{aLastDrawn:a.lastDrawn,bFirstAttached:b.firstAttached,bFirstDrawn:b.firstDrawn,aId:a.id,aUuid:a.uuid,bId:b.id,bUuid:b.uuid,target:b.motion?.target,realIntervalMs:handoff.claimObservedAt-handoff.absentAt});
    handoff.worldDrawnDisplacement=Math.hypot(...b.firstDrawn.worldTranslation.map((value,index)=>value-a.lastDrawn.worldTranslation[index]));
    expect(handoff.realIntervalMs).toBeLessThan(60000);expect(a.detached).toBeTruthy();expect(b.firstAttached.at).toBeGreaterThan(handoff.absentAt);
    expect(a.id).toEqual(`robot:${edgeA}`);expect(a.claimId).toEqual(edgeA);expect(a.lastDrawn.frame).toBeLessThanOrEqual(b.firstAttached.frame);expect(a.detached.frame).toBeLessThanOrEqual(b.firstAttached.frame);
    expect(b.firstAttached.parentUuid).toEqual(a.lastDrawn.parentUuid);expect(b.firstAttached.parentUuid).toBeTruthy();
    expect(maxDelta([b.firstAttached.localPosition[0],b.firstAttached.localPosition[2]],[a.lastDrawn.localPosition[0],a.lastDrawn.localPosition[2]])).toBeLessThan(cameraTolerance);
    expect(b.firstAttached.localPosition[1]).toEqual(.2);
    const loop=handoff.auditAfter.scenes[b.firstAttached.sceneId],beforeLoop=handoff.auditBefore.scenes[b.firstAttached.sceneId];
    handoff.loopProof={beforeEffects:loop.before-beforeLoop.before,afterEffects:loop.after-beforeLoop.after,actualGlFrames:loop.lastGlFrame-beforeLoop.lastGlFrame,baselineGlFrame:beforeLoop.lastGlFrame,afterFrameSeries:loop.afterFrames.filter(sample=>sample.index>beforeLoop.after),relationship:'Retained entire handoff interval: every after-effect has strictly advancing actual GL frame; composer may render multiple passes per loop'};
    expect([0,1]).toContain(handoff.loopProof.afterEffects-handoff.loopProof.beforeEffects);expect(handoff.loopProof.actualGlFrames).toBeGreaterThan(0);expect(handoff.loopProof.afterFrameSeries).toHaveLength(handoff.loopProof.afterEffects);
    let previousGlFrame=beforeLoop.lastGlFrame;for(const sample of handoff.loopProof.afterFrameSeries){expect(sample.frame).toBeGreaterThan(previousGlFrame);previousGlFrame=sample.frame;}expect(previousGlFrame).toEqual(loop.lastGlFrame);
    if(process.env.GAME_REDUCED_MOTION==='1')expect([b.firstDrawn.localPosition[0],b.firstDrawn.localPosition[2]]).toEqual([b.motion.target.x,b.motion.target.z]);
    else{expect(Math.hypot(b.firstDrawn.localPosition[0]-b.firstAttached.localPosition[0],b.firstDrawn.localPosition[2]-b.firstAttached.localPosition[2])).toBeLessThanOrEqual(.700001);expect(handoff.worldDrawnDisplacement).toBeLessThanOrEqual(.700001);}
    const ended=handoff.events.find(e=>e.type==='edge.ended'),claimed=handoff.events.find(e=>e.type==='edge.upsert');expect(ended).toBeTruthy();expect(claimed).toBeTruthy();expect(claimed.seq).toBeGreaterThan(ended.seq);
   }
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
    navigationSave={input:'Cold reload',value:await save(),capturedAt:await page.evaluate(()=>performance.now()),capturedDate:Date.now(),source:'Production localStorage save copied before page.reload'};
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
  await writeFile(`${output}/report.json`,JSON.stringify({passed:true,bundleHead:process.env.GAME_EXACT_HEAD,runnerHead:process.env.GAME_RUNNER_HEAD,dependencies:process.env.GAME_DEPENDENCY_HEADS,renderer:fallback?'Production DOM fallback; no 3D WorkerLayer evidence':fixture.renderer,driver,headless:true,softwareRequested:true,nativeEligible:false,checks,timings,scenes,handoffs,mapReadiness,observerOverhead,stats,responses,errors},null,2));
 }
}catch(error){console.log('Journey failed',String(error));const diagnostic=await page.evaluate(()=>({url:location.href,saves:Object.keys(localStorage).filter(k=>k.startsWith('tm8:game')).map(k=>({key:k,value:JSON.parse(localStorage.getItem(k))})),reads:window.__gameLive?.reads?.slice(-10),events:window.__gameLive?.events?.slice(-10)}));await writeFile(`${output}/report.json`,JSON.stringify({passed:false,bundleHead:process.env.GAME_EXACT_HEAD,runnerHead:process.env.GAME_RUNNER_HEAD,driver,headless:true,softwareRequested:true,nativeEligible:false,checks,timings,scenes,handoffs,mapReadiness,observerOverhead,sceneAtFailure:fallback?null:await scene(),errors,responses,failure:String(error),expectedNavigation,diagnostic,text:await page.locator('body').innerText()},null,2));await page.screenshot({path:`${output}/failure.png`,timeout:10000}).catch(()=>{});throw error;}
finally{if(!fallback)await writeFile(`${output}/camera-audit.json`,JSON.stringify(await cameraAudit(),null,2)).catch(()=>{});await page.evaluate(()=>window.__gameLive?.stopWorkerFrameAudit?.()).catch(()=>{});await browser.close();}
