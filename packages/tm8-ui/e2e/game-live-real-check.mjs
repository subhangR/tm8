import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const fixture=JSON.parse(await readFile(process.env.GAME_FIXTURE_FILE??'/tmp/tm8-live-verifier-infra-01a11c29/fixture.json','utf8'));
const output=process.env.GAME_EVIDENCE_DIR??'/tmp/tm8-live-verifier-evidence-01a11c29';await mkdir(output,{recursive:true});
const checks=[],errors=[],responses=[];
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:process.env.GAME_REDUCED_MOTION==='1'?'reduce':'no-preference'});
page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/v2/'))responses.push({url:new URL(r.url()).pathname,status:r.status()});});
await page.addInitScript(setup=>window.__GAME_LIVE_SETUP__=setup,fixture);
const record=text=>{checks.push(text);console.log(text);};
const rpc=async(op,args,sessionId)=>{const response=await fetch(fixture.controlUrl,{method:'POST',body:JSON.stringify({op,args,sessionId})});const body=await response.json();if(!response.ok)throw new Error(`${op}: ${JSON.stringify(body)}`);return body;};
const save=()=>page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('tm8:game:v1:'));return key?JSON.parse(localStorage.getItem(key)):null;});
const host=page.getByTestId('walking-map');
const enter=async title=>{const details=host.locator('details.walking-places');if(await details.count()&&!await details.evaluate(el=>el.open))await details.locator('summary').click();await host.getByRole('button',{name:`Enter ${title}`,exact:true}).click();};
const waitMap=async(type,kind,id)=>{await expect.poll(async()=>{const v=await save();return v?.current;}).toMatchObject({type,scope:{kind,id}});await expect(host).toHaveAttribute('data-map-id',`map:${kind}:${id}:${type}`);await host.locator('canvas[data-engine]').waitFor();};
try{
 await page.goto('http://127.0.0.1:18533/e2e/game-live-real-harness.html');
 await page.getByTestId('tws-view-select').click();await page.getByRole('menuitemradio',{name:'Game',exact:true}).click();
 await waitMap('hub','space',fixture.spaceId);await enter('Taskland');await waitMap('taskland','space',fixture.spaceId);
 record('Shipping GateApp/GameScreen/GameMode space Taskland loaded through real seam');
 await page.screenshot({path:`${output}/initial-space.png`});
 await writeFile(`${output}/probe.json`,JSON.stringify({checks,errors,responses,text:await page.locator('body').innerText()},null,2));
 if(process.env.GAME_PROBE_ONLY==='1')process.exitCode=0;
 else throw new Error('Full journey pending owner heads');
}catch(error){await page.screenshot({path:`${output}/failure.png`});await writeFile(`${output}/report.json`,JSON.stringify({passed:false,checks,errors,responses,failure:String(error),text:await page.locator('body').innerText()},null,2));throw error;}
finally{await browser.close();}
