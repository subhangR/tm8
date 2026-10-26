/** Run with: node packages/tm8-ui/src/story/game/maps/capture-studio.mjs <evidence-dir> [snapshot.json] */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]??'map-evidence');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-zygote','--single-process','--use-gl=angle','--use-angle=swiftshader','--enable-webgl']});
const page=await browser.newPage({viewport:{width:1600,height:1060},deviceScaleFactor:1});
const errors=[],failures=[],measurements=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
const url=process.env.STUDIO_URL??'http://127.0.0.1:4625/map-studio-dev.html';
await page.goto(url,{waitUntil:'networkidle'});
await page.getByTestId('renderer-stats').filter({hasText:'draw calls'}).waitFor();
async function capture(name,expectedMap){
  await expect(page.getByTestId('map-studio')).toHaveAttribute('data-map',expectedMap);
  await page.waitForFunction(()=>Number(document.querySelector('[data-testid="renderer-stats"]')?.getAttribute('data-samples'))>=15,{},{timeout:60000});
  await page.waitForTimeout(1000);
  await page.locator('.ms-sidebar').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:`${out}/${name}.png`});
  measurements.push({name,map:expectedMap,preset:await page.getByTestId('map-studio').getAttribute('data-preset'),stats:await page.getByTestId('renderer-stats').innerText(),assets:await page.getByTestId('asset-report').innerText(),provenance:await page.getByTestId('provenance').innerText()});
}
for(const map of ['hub','taskland','office','library','factory','town']){await page.getByTestId(`map-${map}`).click();await capture(`map-${map}`,map);}
await page.getByLabel('Scope',{exact:true}).selectOption('story');
await page.getByTestId('map-taskland').click();
await capture('story-taskland','taskland');
await page.getByLabel('Scene preset',{exact:true}).selectOption('nested');
await page.getByTestId('map-taskland').click();
await page.locator('.ms-entity-picker').evaluate(el=>el.open=true);
await page.locator('.ms-entity-picker button').filter({hasText:'Nested workshop · level 3'}).click();
await capture('taskland-nested-close','taskland');
await page.getByLabel('Scene preset',{exact:true}).selectOption('gallery');
await capture('imported-assets-gallery','taskland');
await page.getByLabel('Scene preset',{exact:true}).selectOption('dense');
await capture('taskland-dense','taskland');
await page.emulateMedia({reducedMotion:'reduce'});
await page.setViewportSize({width:1100,height:800});
await page.getByLabel('Scene preset',{exact:true}).selectOption('balanced');
await page.getByTestId('map-office').click();
await capture('office-resized-reduced-motion','office');
await page.setViewportSize({width:1600,height:1060});
await page.emulateMedia({reducedMotion:'no-preference'});
if(process.argv[3]){await page.getByLabel('Open local snapshot',{exact:true}).setInputFiles(resolve(process.argv[3]));await page.waitForTimeout(500);await page.getByTestId('map-taskland').click();await capture('actual-story-snapshot','taskland');await page.locator('.ms-entity-picker').evaluate(el=>el.open=true);await page.locator('.ms-entity-picker button').filter({hasText:'Story Game v1: build to the Design Rules'}).click();await capture('actual-story-subtree','taskland');}
await writeFile(`${out}/browser-measurements.json`,JSON.stringify({capturedAt:new Date().toISOString(),browser:browser.version(),renderer:'WebGL via Chromium ANGLE SwiftShader',errors,failures,measurements},null,2));
await browser.close();
console.log(JSON.stringify({out,errors,failures,measurements},null,2));
if(errors.length||failures.length)process.exitCode=1;
