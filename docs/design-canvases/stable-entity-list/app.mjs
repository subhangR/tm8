import {kinds, initialState, siblings, descendants, move, create, flatten} from './model.mjs';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageKey = 'tm8-stable-panel-design-v1';
let rows = initialState();
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (Array.isArray(saved) && saved.length && saved.every(r => kinds[r.kind] && typeof r.title === 'string')) rows = saved; } catch {}
let kind = 'task', selected = 'task-0', tabs = [selected], collapsed = new Set(), draft = null, history = [], query = '', menu = null, moveId = null, drag = null, suppressClickUntil = 0, toastTimer;
const rowOf = id => rows.find(r => r.id === id);
const tree = $('#tree');
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(rows.filter(r => r.id !== draft))); } catch { notify('Browser storage unavailable; changes last for this visit.'); } }
function notify(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast')?.classList.remove('visible'), 3200); }
function snapshot() { if (draft) return; history.push(structuredClone(rows)); if (history.length > 30) history.shift(); }
function positions() { return new Map([...tree.querySelectorAll('.row')].map(el => [el.dataset.id, el.getBoundingClientRect()])); }
function slide(before) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  tree.querySelectorAll('.row').forEach(el => { const old = before.get(el.dataset.id), now = el.getBoundingClientRect(); if (old && (old.top !== now.top || old.left !== now.left)) el.animate([{transform:`translate(${old.left-now.left}px, ${old.top-now.top}px)`},{transform:'translate(0,0)'}], {duration:200,easing:'cubic-bezier(.2,.8,.2,1)'}); });
}
function change(fn, message) { const before = positions(); snapshot(); rows = fn(); persist(); render(); slide(before); if (message) notify(message); }
function statusClass(row) { return row.status === 'Working' ? 'working' : row.status === 'Waiting for you' ? 'waiting' : ''; }
function visibleRows() {
  const all = flatten(rows, kind, query ? new Set() : collapsed);
  if (!query) return all;
  const keep = new Set();
  for (const r of all) if (r.title.toLowerCase().includes(query.toLowerCase())) { let current = r; while (current && !keep.has(current.id)) { keep.add(current.id); current = rowOf(current.parent); } }
  return all.filter(r => keep.has(r.id));
}
function renderTree() {
  const visible = visibleRows();
  $('#count').textContent = `${rows.filter(r => r.kind === kind).length} entities`;
  tree.innerHTML = visible.map(row => {
    const children = siblings(rows, kind, row.id), isDraft = draft === row.id;
    return `<div class="row ${selected === row.id ? 'selected' : ''}" data-id="${row.id}" data-depth="${row.depth}" style="margin-left:${row.depth*20}px" role="treeitem" aria-level="${row.depth+1}" aria-selected="${selected === row.id}" ${children.length ? `aria-expanded="${!collapsed.has(row.id)}"` : ''} tabindex="0" aria-label="${esc(row.title || 'New '+kinds[kind].singular)}">
      <button class="chevron" data-action="toggle" aria-label="${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${esc(row.title)}" ${!children.length ? 'disabled' : ''}>${children.length ? collapsed.has(row.id) ? '›' : '⌄' : ''}</button>
      <span class="row-icon">${kinds[kind].icon}</span><div class="row-content">${isDraft ? '<input class="inline-title" aria-label="New entity title" placeholder="Name this '+kinds[kind].singular+'…"><div class="draft-hint">Enter to save · Esc to cancel</div>' : `<span class="row-title">${esc(row.title)}</span><div class="row-meta ${statusClass(row)}"><span class="state-dot"></span>${esc(row.status)}${children.length ? `<span>· ${children.length} children</span>` : ''}${row.unread ? `<span class="unread">${row.unread} unread</span>` : ''}</div>`}</div>
      <button class="row-menu" data-action="menu" aria-label="Actions for ${esc(row.title || 'new entity')}" ${isDraft ? 'disabled' : ''}>···</button></div>`;
  }).join('') || '<p class="empty">No matches. Try another title.</p>';
  if (draft) { const input = $('.inline-title'); if (input) { input.value = rowOf(draft).title; input.addEventListener('input', () => updateDraft(input.value, 'list')); input.addEventListener('keydown', draftKeys); } }
}
function renderTabs() {
  tabs = tabs.filter(id => rowOf(id));
  $('#tabs').innerHTML = tabs.map(id => `<div class="tab ${selected === id ? 'selected' : ''}"><button role="tab" aria-selected="${selected === id}" data-tab="${id}">${esc(rowOf(id).title || 'Untitled '+kinds[rowOf(id).kind].singular)}${draft === id ? ' · draft' : ''}</button><button data-close="${id}" aria-label="Close ${esc(rowOf(id).title || 'draft')}">×</button></div>`).join('');
}
function renderDetail() {
  const row = rowOf(selected);
  if (!row) { $('#detail-body').innerHTML = '<h2>Make room for your next idea.</h2><p class="draft-empty">Select an entity or create one from the list.</p>'; return; }
  const children = siblings(rows, row.kind, row.id), parent = rowOf(row.parent);
  $('#detail-body').innerHTML = `<div class="breadcrumb">${kinds[row.kind].label} <span> / </span> ${parent ? esc(parent.title)+' / ' : ''}${draft === row.id ? 'New draft' : 'Details'}</div>
    <input id="detail-title" class="detail-title" aria-label="Entity title" placeholder="Untitled ${kinds[row.kind].singular}" value="${esc(row.title)}">
    <div class="detail-meta"><select id="status" aria-label="Entity status">${['Open','Working','Waiting for you','Completed'].map(s => `<option ${s === row.status ? 'selected' : ''}>${s}</option>`).join('')}</select><span class="badge">${kinds[row.kind].singular}</span><span class="badge">${draft === row.id ? 'Draft' : 'Manual placement'}</span></div>
    <label class="section-label" for="description">DESCRIPTION</label><textarea id="description" placeholder="Add a little context…">${esc(row.description)}</textarea>
    <div class="section-label">CHILDREN <span class="muted">${children.length}</span></div><div class="children-list">${children.map(r => `<button class="child-line" data-open="${r.id}"><span>${kinds[r.kind].icon}</span>${esc(r.title)}<small>${esc(r.status)} ↗</small></button>`).join('')}</div>
    <button class="add-child" id="add-child" ${draft ? 'disabled' : ''}>＋ Add ${row.kind === 'task' ? 'subtask' : 'child '+kinds[row.kind].singular}</button>
    <div class="detail-actions">${draft ? '<button id="save-draft">Save title ↵</button><button id="cancel-draft">Cancel draft</button>' : '<button id="move-detail">Move to…</button><button id="mark-read">Mark read</button>'}</div>
    <div class="context-note">${row.kind === 'session' ? 'A session can start, finish, or receive messages here. Its place in the tree stays the same.' : 'Created at the top. Kept where you put it.<br>Drag or use the row menu to change its place.'}</div>`;
  $('#detail-title').addEventListener('input', e => { if (draft === selected) updateDraft(e.target.value, 'detail'); });
  $('#detail-title').addEventListener('change', e => { if (draft === selected) return; const title = e.target.value.trim(); if (!title) { e.target.value = row.title; notify('A title is required'); return; } snapshot(); row.title = title; persist(); renderTree(); renderTabs(); });
  $('#detail-title').addEventListener('keydown', e => { if (draft === selected) draftKeys(e); });
  $('#description').addEventListener('change', e => { snapshot(); row.description = e.target.value; persist(); });
  $('#status').addEventListener('change', e => { snapshot(); row.status = e.target.value; persist(); renderTree(); notify('Status updated. Position unchanged.'); });
  $('#add-child').onclick = () => startCreate(row.id);
  $('#save-draft')?.addEventListener('click', commitDraft);
  $('#cancel-draft')?.addEventListener('click', cancelDraft);
  $('#move-detail')?.addEventListener('click', () => openMove(row.id));
  $('#mark-read')?.addEventListener('click', () => { row.unread = 0; persist(); renderTree(); notify('Marked as read. Position unchanged.'); });
  document.querySelectorAll('[data-open]').forEach(el => el.onclick = () => open(el.dataset.open));
}
function render() { renderTree(); renderTabs(); renderDetail(); $('#undo').disabled = !history.length || Boolean(draft); $('#kind-title').textContent = kinds[kind].label; $('#kinds').innerHTML = Object.entries(kinds).map(([key,val]) => `<button role="tab" aria-selected="${key === kind}" data-kind="${key}">${val.label}</button>`).join(''); }
function open(id) { if (draft && id !== draft && !commitDraft()) return; selected = id; const row = rowOf(id); kind = row.kind; if (!tabs.includes(id)) tabs.push(id); row.unread = 0; render(); }
function updateDraft(title, source) { rowOf(draft).title = title; if (source === 'list') $('#detail-title').value = title; else if ($('.inline-title')) $('.inline-title').value = title; renderTabs(); }
function draftKeys(e) { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); } }
function startCreate(parent = null) {
  if (draft) { $('.inline-title')?.focus(); notify('Save or cancel the current title first.'); return; }
  query = ''; $('#search').value = ''; snapshot(); draft = crypto.randomUUID(); rows = create(rows, kind, parent, draft); selected = draft; tabs.push(draft);
  if (parent) collapsed.delete(parent);
  const before = positions(); render(); slide(before); $('.inline-title')?.focus(); $('.inline-title')?.scrollIntoView({block:'nearest'});
}
function commitDraft() {
  if (!draft) return true;
  const row = rowOf(draft); if (!row.title.trim()) { notify('Give this entity a title, or press Escape to cancel.'); $('.inline-title')?.focus(); return false; }
  row.title = row.title.trim(); draft = null; persist(); render(); notify('Created at the top. Details are ready in its tab.'); return true;
}
function cancelDraft() { if (!draft) return; rows = rows.filter(r => r.id !== draft); tabs = tabs.filter(id => id !== draft); draft = null; selected = tabs.at(-1) ?? null; history.pop(); render(); notify('Draft cancelled'); }
function applyMove(id, parent, before = null) { try { const updated = move(rows,id,parent,before); change(() => updated, 'Moved. The whole subtree stays together.'); } catch(e) { notify(e.message); } }
function action(id, name) {
  closeMenu(); const row = rowOf(id); const peers = siblings(rows,row.kind,row.parent); const i = peers.findIndex(r => r.id === id);
  if (name === 'child') { kind = row.kind; startCreate(id); return; }
  if (query || draft) { notify('Finish the draft and clear search before moving.'); return; }
  if (name === 'move') openMove(id);
  if (name === 'up' && i > 0) applyMove(id,row.parent,peers[i-1].id);
  if (name === 'down' && i < peers.length-1) applyMove(id,row.parent,peers[i+2]?.id ?? null);
  if (name === 'indent' && i > 0) { collapsed.delete(peers[i-1].id); applyMove(id,peers[i-1].id,siblings(rows,kind,peers[i-1].id)[0]?.id ?? null); }
  if (name === 'outdent' && row.parent) { const parent = rowOf(row.parent), grandPeers = siblings(rows,kind,parent.parent), p = grandPeers.findIndex(r => r.id === parent.id); applyMove(id,parent.parent,grandPeers[p+1]?.id ?? null); }
}
function closeMenu() { menu?.remove(); menu = null; }
function showMenu(id, anchor) {
  closeMenu(); const row = rowOf(id), peers = siblings(rows,kind,row.parent), i = peers.findIndex(r => r.id === id), locked = Boolean(query || draft);
  menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role','menu');
  const items = [['child','Add child','',false],['move','Move to…','',locked],['up','Move up','Alt ↑',locked || i === 0],['down','Move down','Alt ↓',locked || i === peers.length-1],['indent','Indent','Alt →',locked || i === 0],['outdent','Outdent','Alt ←',locked || !row.parent]];
  menu.innerHTML = items.map(([a,label,key,disabled]) => `<button role="menuitem" data-command="${a}" ${disabled ? 'disabled' : ''}>${label}<kbd>${key}</kbd></button>`).join('');
  document.body.append(menu); const rect = anchor.getBoundingClientRect(); menu.style.left = Math.min(innerWidth-205,rect.right-195)+'px'; menu.style.top = Math.min(innerHeight-menu.offsetHeight-12,rect.bottom+5)+'px';
  menu.onclick = e => { const button = e.target.closest('[data-command]'); if (button) action(id,button.dataset.command); };
  menu.querySelector('button:not(:disabled)').focus();
}
function openMove(id) {
  if (draft || query) { notify('Finish the draft and clear search before moving.'); return; }
  moveId = id; const forbidden = descendants(rows,id); $('#destination').innerHTML = '<option value="">Root list</option>'+flatten(rows,kind).filter(r => !forbidden.has(r.id)).map(r => `<option value="${r.id}">${'— '.repeat(r.depth)}${esc(r.title)}</option>`).join(''); $('#destination').value = rowOf(id).parent ?? ''; $('#move-dialog').showModal();
}
$('#confirm-move').onclick = () => { const parent = $('#destination').value || null; collapsed.delete(parent); applyMove(moveId,parent,siblings(rows,kind,parent).filter(r => r.id !== moveId)[0]?.id ?? null); $('#move-dialog').close(); };
tree.addEventListener('click', e => {
  const el = e.target.closest('.row'); if (!el || drag || Date.now() < suppressClickUntil) return;
  const id = el.dataset.id, cmd = e.target.closest('[data-action]')?.dataset.action;
  if (cmd === 'toggle') { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); renderTree(); }
  else if (cmd === 'menu') showMenu(id,e.target);
  else if (!['INPUT','BUTTON'].includes(e.target.tagName)) open(id);
});
tree.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const el = e.target.closest('.row'); if (!el) return;
  if (e.altKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); action(el.dataset.id, {ArrowUp:'up',ArrowDown:'down',ArrowLeft:'outdent',ArrowRight:'indent'}[e.key]); tree.querySelector(`[data-id="${el.dataset.id}"]`)?.focus(); }
  else if (e.key === 'Enter' && e.target === el) { e.preventDefault(); open(el.dataset.id); }
  else if (['ArrowUp','ArrowDown'].includes(e.key) && e.target === el) { e.preventDefault(); const list = [...tree.querySelectorAll('.row')]; list[list.indexOf(el)+(e.key === 'ArrowDown'?1:-1)]?.focus(); }
});
$('#tabs').onclick = e => { const tab = e.target.closest('[data-tab]'), close = e.target.closest('[data-close]'); if (tab) open(tab.dataset.tab); if (close) { const id = close.dataset.close; if (id === draft) { cancelDraft(); return; } tabs = tabs.filter(t => t !== id); if (selected === id) selected = tabs.at(-1) ?? null; render(); } };
$('#kinds').onclick = e => { const button = e.target.closest('[data-kind]'); if (!button || (draft && !commitDraft())) return; kind = button.dataset.kind; query = ''; $('#search').value = ''; render(); };
$('#search').oninput = e => { query = e.target.value; renderTree(); };
$('#new').onclick = () => startCreate();
$('#undo').onclick = () => { if (!history.length || draft) return; const before = positions(); rows = history.pop(); if (!rowOf(selected)) selected = rows.find(r => r.kind === kind)?.id ?? null; persist(); render(); slide(before); notify('Last edit undone'); };
$('#theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
$('#help').onclick = () => $('#notes').showModal();
$('#reset').onclick = () => { draft = null; rows = initialState(); history = []; kind = 'task'; selected = 'task-0'; tabs = [selected]; collapsed = new Set(); query = ''; $('#search').value = ''; persist(); render(); notify('Demo reset'); };
$('#simulate').onclick = () => { if (draft && !commitDraft()) return; kind = 'session'; query = ''; $('#search').value = ''; const row = rowOf('session-0'); snapshot(); row.status = row.status === 'Working' ? 'Waiting for you' : row.status === 'Waiting for you' ? 'Completed' : 'Working'; row.unread++; persist(); render(); notify('Session updated. Same parent, same order.'); };
document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !e.target.closest('.row-menu')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); if (drag) endDrag(false); } });
// Pointer drag uses the starting layout for hit tests: an animated gap cannot
// change its own target and oscillate between neighboring rows.
tree.addEventListener('pointerdown', e => {
  if (drag) { endDrag(false); return; }
  const el = e.target.closest('.row');
  if (!el || query || draft || e.button !== 0 || e.target.closest('button,input,textarea,select,a')) return;
  closeMenu(); const id = el.dataset.id, forbidden = descendants(rows,id);
  const ghost = el.cloneNode(true); ghost.classList.add('drag-ghost'); ghost.removeAttribute('role'); ghost.removeAttribute('tabindex'); ghost.setAttribute('aria-hidden','true'); ghost.style.marginLeft='0';
  const pending = {id, ghost, element:el, pointerId:e.pointerId, startX:e.clientX, startY:e.clientY, active:false, target:null, scroll:tree.scrollTop, rects:[...tree.querySelectorAll('.row')].filter(r => !forbidden.has(r.dataset.id)).map(r => ({id:r.dataset.id,rect:r.getBoundingClientRect()}))};
  drag = pending;
  pending.timer = setTimeout(() => {
    if (drag !== pending || !el.isConnected) return;
    pending.active = true;
    ghost.style.left = pending.startX+14+'px'; ghost.style.top = pending.startY-22+'px';
    document.body.append(ghost); el.classList.add('drag-source');
    document.body.classList.add('is-dragging');
    if (el.setPointerCapture && pending.pointerId !== undefined) el.setPointerCapture(pending.pointerId);
  }, 450);
});
// A normal swipe starts scrolling. Once a stationary hold has lifted the card,
// consume touch moves so the browser does not turn that drag into page scrolling.
document.addEventListener('touchmove', e => { if (drag?.active) e.preventDefault(); }, {passive:false});
tree.addEventListener('contextmenu', e => { if (drag) e.preventDefault(); });
tree.addEventListener('selectstart', e => { if (drag) e.preventDefault(); });
document.addEventListener('pointermove', e => {
  if (!drag || (drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY) > 8) endDrag(false);
    return;
  }
  e.preventDefault();
  drag.ghost.style.left = e.clientX+14+'px'; drag.ghost.style.top = e.clientY-22+'px';
  const bounds = tree.getBoundingClientRect(); if (e.clientY < bounds.top+25) tree.scrollTop -= 8; else if (e.clientY > bounds.bottom-25) tree.scrollTop += 8;
  const y = e.clientY + tree.scrollTop-drag.scroll;
  let hit = drag.rects.find(r => y >= r.rect.top && y <= r.rect.bottom);
  if (!hit && drag.rects.length) hit = drag.rects.reduce((a,b) => Math.abs(y-(a.rect.top+a.rect.height/2)) < Math.abs(y-(b.rect.top+b.rect.height/2)) ? a : b);
  if (!hit || e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) { clearPreview(); drag.target = null; return; }
  const row = rowOf(hit.id), ratio = (y-hit.rect.top)/hit.rect.height;
  const mode = ratio < .27 ? 'before' : ratio > .73 ? 'after' : 'child';
  if (drag.target?.id === hit.id && drag.target.mode === mode) return;
  const before = positions(); clearPreview(); drag.target = {id:hit.id,mode}; const target = tree.querySelector(`[data-id="${hit.id}"]`);
  if (mode === 'child') target.classList.add('drop-child');
  else { const gap = document.createElement('div'); gap.className = 'drop-gap'; gap.textContent = `Move ${mode} ${row.title}`; gap.style.marginLeft = target.style.marginLeft; const subtree = descendants(rows,hit.id); const anchor = mode === 'after' ? [...tree.querySelectorAll('.row')].filter(el => subtree.has(el.dataset.id)).at(-1) : target; anchor.insertAdjacentElement(mode === 'before' ? 'beforebegin' : 'afterend',gap); }
  slide(before);
});
function clearPreview() { tree.querySelector('.drop-gap')?.remove(); tree.querySelector('.drop-child')?.classList.remove('drop-child'); }
function endDrag(commit) {
  if (!drag) return; const current = drag; drag = null; clearTimeout(current.timer);
  if (current.active) suppressClickUntil = Date.now()+400;
  if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  document.body.classList.remove('is-dragging'); current.ghost.remove(); clearPreview(); tree.querySelector('.drag-source')?.classList.remove('drag-source');
  if (!commit || !current.active || !current.target) return;
  const {id,mode} = current.target, target = rowOf(id);
  if (mode === 'child') { collapsed.delete(id); applyMove(current.id,id,siblings(rows,kind,id).filter(r => r.id !== current.id)[0]?.id ?? null); }
  else { const peers = siblings(rows,kind,target.parent).filter(r => r.id !== current.id), i = peers.findIndex(r => r.id === id); applyMove(current.id,target.parent,mode === 'before' ? id : peers[i+1]?.id ?? null); }
}
document.addEventListener('pointerup', e => { if (drag && (drag.pointerId === undefined || e.pointerId === drag.pointerId)) endDrag(true); });
document.addEventListener('pointercancel', () => endDrag(false));
window.addEventListener('blur', () => endDrag(false));
render();
