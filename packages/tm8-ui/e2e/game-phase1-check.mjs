/** Run against game-phase1-harness.html in the combined Phase 1 checkout. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.GAME_HARNESS_URL ?? 'http://127.0.0.1:4631/e2e/game-phase1-harness.html';
const evidence = process.env.GAME_EVIDENCE_DIR ?? '/tmp/tm8-game-phase1-evidence';
await mkdir(evidence, { recursive: true });
const report = [];
for (const fallback of [false, true]) {
  const browser = await chromium.launch({headless:true,
    ...(process.env.GAME_CHROMIUM ? {executablePath:process.env.GAME_CHROMIUM} : {}),
    args:['--no-sandbox','--no-zygote','--single-process','--use-angle=swiftshader','--enable-unsafe-swiftshader', ...(fallback?['--disable-webgl']:[])]});
  const page = await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const began=Date.now();
    await page.goto(base);
    await page.getByTestId('tws-view-select').click();
    await page.getByRole('menuitemradio',{name:'Game',exact:true}).click();
    const host=page.getByTestId('walking-map');
    await host.waitFor();
    const save=()=>page.evaluate(()=>{
      const key=Object.keys(localStorage).find(key=>key.startsWith('tm8:game:v1:'));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    });
    const expectedRenderer=fallback?'dom':'webgl';
    await expect(host).toHaveAttribute('data-renderer',expectedRenderer);
    if (!fallback) await host.locator('canvas').first().waitFor();
    const openPlaces=async()=>{
      const details=host.locator('details.walking-places');
      if(await details.count() && !(await details.evaluate(node=>node.open))) await details.locator('summary').click();
    };
    const enter=async title=>{await openPlaces();await host.getByRole('button',{name:`Enter ${title}`,exact:true}).click();};
    const back=async()=>{await host.focus();await page.keyboard.press('Escape');};
    const waitMap=async(type,kind,id)=>{
      await expect.poll(async()=>{const value=await save();return value?.current;}).toMatchObject({type,scope:{kind,...(id?{id}:{})}});
      const current=(await save()).current;
      await expect(host).toHaveAttribute('data-map-id',`map:${kind}:${current.scope.id}:${type}`);
      if(!fallback) await host.locator('canvas[data-engine]').waitFor();
    };
    const types=[['Taskland','taskland'],['Office','office'],['Library','library'],['Code Factory','factory'],['Completed Town','town']];
    expect(await page.evaluate(()=>window.__phase1GameHarness.graphQueries.filter(query=>query.edgeTypes?.includes('working_on')).length)).toBe(0);
    await page.screenshot({path:`${evidence}/${expectedRenderer}-hub.png`});
    for (const kind of ['space','story']) {
      if(kind==='story'){await enter('Harness story');await waitMap('hub','story');}
      for(const [title,type] of types){
        await enter(title);await waitMap(type,kind);await host.waitFor();
        await expect(host.getByText('No entities in this map yet.',{exact:true})).toHaveCount(0);
        if(type==='taskland' && kind==='story'){
          await openPlaces();
          const title='Harness story task';
          // Travel with the real renderer, then inspect using E with its host focused.
          const walk=fallback?host.getByRole('button',{name:`Walk to ${title}`,exact:true}):host.getByRole('button',{name:title,exact:true});
          await walk.click();
          await expect(host.getByRole('region',{name:'Nearby place'}).getByText(title,{exact:true})).toBeVisible({timeout:30000});
          await host.focus();await page.keyboard.press('e');
          const panel=page.getByTestId('game-inspection');
          await expect(panel.getByText(title,{exact:true})).toBeVisible({timeout:15000});
          await page.screenshot({path:`${evidence}/${expectedRenderer}-inspection.png`});
          await expect(host).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(panel).toHaveCount(0);await waitMap(type,kind);await expect(host).toBeFocused();
          // Palette Escape must consume the event even if focus returns to the map.
          await page.keyboard.press('/');await page.getByTestId('command-palette').waitFor();
          await host.focus();await page.keyboard.press('Escape');
          await expect(page.getByTestId('command-palette')).toHaveCount(0);await waitMap(type,kind);
        }
        await back();await waitMap('hub',kind);
      }
    }
    await enter('Nested harness story');await waitMap('hub','story');
    const nested=(await save()).current.scope.id;
    await enter('Taskland');await waitMap('taskland','story',nested);await host.waitFor();
    await host.focus();await page.keyboard.down('d');await page.waitForTimeout(180);await page.keyboard.up('d');
    if(!fallback){await host.locator('canvas').first().hover();await page.mouse.wheel(0,120);await page.waitForTimeout(250);}
    await expect.poll(async()=>{const value=await save();const key=JSON.stringify([value.current.scope.kind,value.current.scope.id,value.current.type]);return value.maps[key]?.position;},{timeout:15000}).toBeDefined();
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    const before=await save();
    const preReloadQueries=await page.evaluate(()=>window.__phase1GameHarness.queries);
    await writeFile(`${evidence}/${expectedRenderer}-before-reload.json`,JSON.stringify(before,null,2));
    await page.reload();await host.waitFor();await waitMap('taskland','story',nested);
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    const after=await save();
    await writeFile(`${evidence}/${expectedRenderer}-after-reload.json`,JSON.stringify(after,null,2));
    expect(after.current).toEqual(before.current);expect(after.stack).toEqual(before.stack);
    const key=JSON.stringify([before.current.scope.kind,before.current.scope.id,before.current.type]);
    expect(after.maps[key].position).toEqual(before.maps[key].position);
    if(before.maps[key].camera) expect(after.maps[key].camera).toEqual(before.maps[key].camera);
    await back();await waitMap('hub','story',nested);
    await back();await waitMap('hub','story');expect((await save()).current.scope.id).not.toBe(nested);
    await back();await waitMap('hub','space');
    expect(await page.evaluate(()=>location.hash)).toMatch(/\/game$/);
    const queries=[...preReloadQueries,...await page.evaluate(()=>window.__phase1GameHarness.queries)];
    expect(queries.some(query=>query.cursor)).toBe(true);
    const graphCount=await page.evaluate(()=>window.__phase1GameHarness.graphQueries.filter(query=>query.edgeTypes?.includes('working_on')).length);
    expect(graphCount).toBeLessThanOrEqual(1); // only the reloaded Taskland read survives page reload
    expect(errors).toEqual([]);
    report.push({renderer:expectedRenderer,elapsedMs:Date.now()-began,queryCount:queries.length,graphCount,checks:'selector, all five maps at space/story scopes, focused E/inspection/Escape, palette Escape, nested Back, exact pose/camera/stack reload',errors});
    await writeFile(`${evidence}/report.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({renderer:expectedRenderer,stage:'passed'}));
  } catch(error) { await page.screenshot({path:`${evidence}/${fallback?'dom':'webgl'}-failure.png`}); await writeFile(`${evidence}/failure.txt`,String(error)+'\n'+(await page.locator('body').innerText())); throw error; } finally {await browser.close();}
}
await writeFile(`${evidence}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
