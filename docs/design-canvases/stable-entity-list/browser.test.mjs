// Serve this directory first; see README.md. Uses the repo's Playwright version.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const browser = await chromium.launch({headless:true, timeout:15000, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.PROTOTYPE_URL || 'http://127.0.0.1:8787');
  await page.locator('#reset').click();
  const ids = () => page.locator('#tree .row').evaluateAll(rows => rows.map(r => r.dataset.id));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('tm8-stable-panel-design-v1')));
  await page.locator('#new').click();
  assert.equal(await page.locator('#tabs [role=tab]').count(),2);
  await page.locator('.inline-title').fill('A new parent');
  assert.equal(await page.locator('#detail-title').inputValue(),'A new parent');
  await page.locator('#detail-title').fill('A shared title');
  assert.equal(await page.locator('.inline-title').inputValue(),'A shared title');
  await page.locator('#detail-title').press('Enter');
  const parentId = (await ids())[0];
  assert.equal((await stored()).find(r => r.id === parentId).title,'A shared title');
  await page.locator('#add-child').click();
  await page.locator('.inline-title').fill('First subtask');
  await page.locator('.inline-title').press('Enter');
  assert.equal((await stored()).find(r => r.title === 'First subtask').parent,parentId);
  await page.locator('#new').click();
  await page.locator('.inline-title').fill('Discard me');
  await page.locator('.inline-title').press('Escape');
  assert.equal(await page.getByText('Discard me',{exact:true}).count(),0);
  // Explicit move, undo, keyboard indent/outdent.
  await page.locator('[data-id="task-5"] .row-menu').click();
  await page.getByRole('menuitem',{name:'Move to…'}).click();
  await page.locator('#destination').selectOption('task-0');
  assert.equal(await page.locator('#destination option[value="task-5"]').count(),0);
  await page.locator('#confirm-move').click();
  assert.equal((await stored()).find(r => r.id === 'task-5').parent,'task-0');
  await page.locator('#undo').click();
  assert.equal((await stored()).find(r => r.id === 'task-5').parent,null);
  await page.locator('[data-id="task-5"]').focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.equal((await stored()).find(r => r.id === 'task-5').parent,'task-4');
  await page.keyboard.press('Alt+ArrowLeft');
  assert.equal((await stored()).find(r => r.id === 'task-5').parent,null);
  // Pointer nesting and keyboard cancellation.
  await page.locator('#reset').click();
  let handle = await page.locator('[data-id="task-5"] .grip').boundingBox();
  let target = await page.locator('[data-id="task-0"]').boundingBox();
  await page.mouse.move(handle.x+5,handle.y+5); await page.mouse.down();
  await page.mouse.move(target.x+90,target.y+target.height/2,{steps:12});
  assert.equal(await page.locator('.drop-child').count(),1);
  await page.mouse.up();
  assert.equal((await stored()).find(r => r.id === 'task-5').parent,'task-0');
  await page.locator('#undo').click();
  const beforeCancel = await ids();
  handle = await page.locator('[data-id="task-5"] .grip').boundingBox();
  target = await page.locator('[data-id="task-0"]').boundingBox();
  await page.mouse.move(handle.x+5,handle.y+5); await page.mouse.down();
  await page.mouse.move(target.x+90,target.y+2,{steps:12});
  assert.equal(await page.locator('.drop-gap').count(),1);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await ids(),beforeCancel);
  // Sessions retain parent and sibling order through three lifecycle changes.
  await page.getByRole('tab',{name:'Sessions',exact:true}).click();
  const sessionIds = await ids();
  for (let i=0;i<3;i++) { await page.locator('#simulate').click(); assert.deepEqual(await ids(),sessionIds); }
  assert.equal((await stored()).find(r => r.id === 'session-0').unread,3);
  await page.reload(); await page.getByRole('tab',{name:'Sessions',exact:true}).click();
  assert.deepEqual(await ids(),sessionIds);
  await page.getByRole('tab',{name:'Docs',exact:true}).click();
  await page.locator('#new').click(); await page.locator('.inline-title').fill('Design rationale'); await page.locator('.inline-title').press('Enter');
  assert.equal((await stored()).find(r => r.title === 'Design rationale').kind,'doc');
  await page.locator('#search').fill('Placement');
  assert.equal(await page.locator('#tree .row').count(),2); // match + its ancestor
  assert.equal(await page.locator('#tree .grip:disabled').count(),2);
  await page.locator('#search').fill('');
  await page.locator('#reset').click();
  await page.screenshot({path:process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/stable-panel-light.png` : '/tmp/stable-panel-light.png',fullPage:true});
  await page.locator('#theme').click();
  await page.screenshot({path:process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/stable-panel-dark.png` : '/tmp/stable-panel-dark.png',fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.locator('#new').click(); await page.locator('.inline-title').fill('Mobile title'); await page.locator('.inline-title').press('Enter');
  await page.screenshot({path:process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/stable-panel-mobile.png` : '/tmp/stable-panel-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: creation, title sync, nesting, menu/keyboard/pointer moves, cancel, undo, stable sessions, reload, search, mobile, reduced motion; no page errors.');
} finally { await browser.close(); }
