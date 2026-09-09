const $ = id => document.getElementById(id);
const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invitation) { document.querySelector('[name=invitationCode]').value = invitation; history.replaceState(null, '', location.pathname); }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code === 'waiting_for_capacity' ? 'Your enrollment is waiting for capacity. Ask your administrator to register another machine, then retry.' : (result.error?.code ?? 'Request failed').replaceAll('_', ' '));
  return result.data;
}
async function run(action) { $('status').textContent = ''; try { await action(); } catch (error) { $('status').textContent = error.message; } }
async function refresh() {
  try {
    const me = await api('/api/me');
    $('login').hidden = true; $('signed-in').hidden = false; $('account').textContent = me.email; $('admin').hidden = !me.isAdmin;
    if (me.isAdmin) {
      const machines = await api('/api/machines');
      $('machines').replaceChildren(...machines.map(machine => { const p = document.createElement('p'); p.textContent = `${machine.name} · ${machine.allocated}/${machine.capacity} users · ${machine.state} · ${machine.public_origin}`; return p; }));
    }
  } catch { $('login').hidden = false; $('signed-in').hidden = true; $('admin').hidden = true; }
}
$('github').onclick = () => run(async () => { const data = await api('/auth/github', { invitationCode: document.querySelector('[name=invitationCode]').value || undefined }); location.assign(data.redirectUrl); });
$('link-github').onclick = () => run(async () => { const data = await api('/auth/github', { intent: 'link' }); location.assign(data.redirectUrl); });
$('open-workspace').onclick = () => run(async () => { const data = await api('/api/handoff', {}); location.assign(data.redirectUrl); });
$('logout').onclick = () => run(async () => { await api('/auth/logout', {}); await refresh(); });
$('machine-form').onsubmit = event => { event.preventDefault(); void run(async () => { const data = Object.fromEntries(new FormData(event.target)); data.capacity = Number(data.capacity); $('result').textContent = JSON.stringify(await api('/api/machines', data), null, 2); await refresh(); }); };
$('invite-form').onsubmit = event => { event.preventDefault(); void run(async () => { $('result').textContent = JSON.stringify(await api('/api/invitations', Object.fromEntries(new FormData(event.target))), null, 2); }); };

void refresh();
