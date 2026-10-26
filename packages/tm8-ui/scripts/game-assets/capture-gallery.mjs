/** node capture-gallery.mjs /absolute/evidence-dir [URL]; use CHROMIUM_PATH / LD_LIBRARY_PATH if required. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]??'asset-evidence');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-zygote','--single-process','--use-gl=angle','--use-angle=swiftshader','--enable-webgl']});
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const errors=[],failures=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
await page.goto(process.argv[3]??'http://127.0.0.1:4627/asset-catalog-dev.html?sheet=imported&reduced=1',{waitUntil:'networkidle'});
await page.locator('[data-imported-gallery] canvas').waitFor();
for(const name of (process.env.GALLERY_SHEETS?.split(',')??['Town','Construction','Landscape','Crew'])){
 await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(1500);
 await page.screenshot({path:resolve(out,`gallery-${name.toLowerCase()}.png`)});
}
const measurements=await page.evaluate(()=>({
 navigation:performance.getEntriesByType('navigation').map(r=>({domContentLoadedMs:r.domContentLoadedEventEnd,loadMs:r.loadEventEnd})),
 resources:performance.getEntriesByType('resource').filter(r=>r.name.includes('.glb')||r.name.includes('game-cc0-inline')).map(r=>({file:r.name.split('/').pop(),durationMs:r.duration,transferBytes:r.transferSize,bodyBytes:r.decodedBodySize})),
 inlineModels:Object.keys(globalThis.__TM8_GAME_ASSETS__??{}).length,
}));
await writeFile(resolve(out,'browser-report.json'),JSON.stringify({browser:browser.version(),capturedAt:new Date().toISOString(),viewport:[1440,1000],renderer:'Chromium ANGLE SwiftShader',errors,failures,...measurements,note:'Localhost resource transfer timings. No network throttling. Screenshots include software-rendered GLTF pixels; navigation time is not GPU first-frame time.'},null,2));
await browser.close();console.log(JSON.stringify({out,errors,failures,...measurements},null,2));if(errors.length||failures.length)process.exitCode=1;
