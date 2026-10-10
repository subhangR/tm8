import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {JSDOM} = await import(process.env.JSDOM_MODULE || 'jsdom');
test('prototype controls synchronize titles, preserve order, move, undo, and cancel drafts', async () => {
  const dom = new JSDOM(await readFile(new URL('./index.html',import.meta.url),'utf8'),{url:'http://localhost/'});
  const {window} = dom;
  for (const key of ['window','document','localStorage','HTMLElement']) globalThis[key] = window[key];
  globalThis.matchMedia = () => ({matches:true});
  globalThis.innerWidth=1440; globalThis.innerHeight=1000;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.animate = () => {};
  window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  await import('./app.mjs');
  const $ = s => document.querySelector(s);
  const click = s => { const el=$(s); assert.ok(el,s); el.click(); };
  const input = (s,value) => { $(s).value=value; $(s).dispatchEvent(new window.Event('input',{bubbles:true})); };
  const key = (s,key,altKey=false) => $(s).dispatchEvent(new window.KeyboardEvent('keydown',{key,altKey,bubbles:true}));
  const ids = () => [...document.querySelectorAll('#tree .row')].map(r => r.dataset.id);
  const stored = () => JSON.parse(localStorage.getItem('tm8-stable-panel-design-v1'));
  click('#new'); input('.inline-title','New parent');
  assert.equal($('#detail-title').value,'New parent');
  input('#detail-title','Synced parent'); assert.equal($('.inline-title').value,'Synced parent');
  key('#detail-title','Enter'); const parent=ids()[0];
  assert.equal(stored().find(r => r.id===parent).title,'Synced parent');
  click('#add-child'); input('.inline-title','Child title'); key('.inline-title','Enter');
  assert.equal(stored().find(r => r.title==='Child title').parent,parent);
  click('#new'); input('.inline-title','Cancelled');
  $('#description').value='draft description'; $('#description').dispatchEvent(new window.Event('change'));
  key('.inline-title','Escape'); assert.equal(stored().some(r => r.title==='Cancelled'),false);
  key('[data-id="task-5"]','ArrowRight',true);
  assert.equal(stored().find(r => r.id==='task-5').parent,'task-4');
  key('[data-id="task-5"]','ArrowLeft',true);
  assert.equal(stored().find(r => r.id==='task-5').parent,null);
  click('[data-id="task-5"] .row-menu'); click('[data-command="move"]');
  assert.equal($('#destination option[value="task-5"]'),null);
  $('#destination').value='task-0'; click('#confirm-move');
  assert.equal(stored().find(r => r.id==='task-5').parent,'task-0');
  click('#undo'); assert.equal(stored().find(r => r.id==='task-5').parent,null);
  click('[data-kind="session"]'); const stable=ids();
  for(let i=0;i<3;i++){click('#simulate');assert.deepEqual(ids(),stable);}
  assert.equal(stored().find(r => r.id==='session-0').unread,3);
  click('[data-kind="doc"]'); click('#new'); input('.inline-title','Doc title'); key('.inline-title','Enter');
  assert.equal(stored().find(r => r.title==='Doc title').kind,'doc');
  input('#search','Placement'); assert.equal(ids().length,2);
  assert.equal(document.querySelectorAll('#tree .grip').length,0);
  click('#reset'); assert.equal(ids().length,6);
  const pointer = (el,type,x=50,y=50) => el.dispatchEvent(new window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
  const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
  const title = $('[data-id="task-5"] .row-title');
  pointer(title,'pointerdown'); pointer(title,'pointerup');
  await wait(480); assert.equal($('.drag-ghost'),null); // quick press never lifts
  pointer(title,'pointerdown'); pointer(document,'pointermove',70,50);
  await wait(480); assert.equal($('.drag-ghost'),null); // swipe cancels pickup
  pointer(title,'pointerdown'); await wait(480);
  assert.ok($('.drag-ghost')); assert.ok(document.body.classList.contains('is-dragging'));
  key('#tree','Escape'); assert.equal($('.drag-ghost'),null);
  assert.equal(document.body.classList.contains('is-dragging'),false);
  const selectedBefore = $('#detail-title').value;
  title.click(); assert.equal($('#detail-title').value,selectedBefore); // no release click
  pointer($('[data-id="task-5"] .row-menu'),'pointerdown');
  await wait(480); assert.equal($('.drag-ghost'),null); // controls are excluded
  pointer(title,'pointerdown'); await wait(480); assert.ok($('.drag-ghost'));
  pointer(document,'pointercancel'); assert.equal($('.drag-ghost'),null);
  dom.window.close();
});
