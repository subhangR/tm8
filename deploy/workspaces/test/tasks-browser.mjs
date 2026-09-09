import assert from 'node:assert/strict';
const { chromium } = await import(process.env.TM8_BROWSER_LIBRARY ?? 'playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.TM8_CHROME_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 2048, height: 1100 } });
page.setDefaultTimeout(10000);
let output = '', phase = 'sign in', launchedId = null;
page.on('websocket', socket => {
  if (socket.url().includes('/workspaces/terminals/')) socket.on('framereceived', frame => { output += frame.payload.toString(); });
});
try {
  await page.route('https://github.com/login/oauth/authorize?**', async route => {
    const url = new URL(route.request().url()), callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }).toString();
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.goto('http://127.0.0.1:4629');
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'My workspace', exact: true }).waitFor();
  const task = await page.evaluate(async () => {
    const post = async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-TM8-Client': 'tm8-ui' }, body: JSON.stringify(body) });
      const json = await res.json(); if (!res.ok) throw new Error(JSON.stringify(json)); return json.data;
    };
    await post('/v2/workspaces/me/ensure', {});
    const listed = (await (await fetch('/v2/spaces')).json()).data;
    const spaces = Array.isArray(listed) ? listed : listed.spaces;
    const space = spaces[0] ?? (await post('/v2/spaces', { name: 'Task browser acceptance', clientMutationId: crypto.randomUUID() })).space;
    const title = `Task ${Date.now().toString().slice(-5)}`;
    const task = await post('/v2/entities', { spaceId: space.id, kind: 'task', title, content: { description: 'Execute this acceptance task in the private workspace.' }, clientMutationId: crypto.randomUUID() });
    return { id: task.entity.id, title, spaceId: space.id };
  });
  await page.reload();
  phase = 'open task';
  const setup = page.getByTestId('cset-x'); if (await setup.isVisible()) await setup.click();
  await page.getByText('Work', { exact: true }).first().click();
  await page.getByText(task.title, { exact: true }).first().click({ position: { x: 8, y: 8 } });
  await page.getByRole('treeitem').filter({ hasText: task.title }).getByRole('button', { name: 'Run', exact: true }).click();
  phase = 'select teammate and model';
  await page.getByTestId('nsx-team').click();
  await page.getByTestId('nsx-team-menu').getByRole('menuitemradio').filter({ hasText: 'Sonnet 5 Teammate' }).click();
  await page.getByTestId('nsx-model').click();
  assert.ok((await page.getByTestId('nsx-model-menu').innerText()).includes('Claude Sonnet 5'));
  assert.equal((await page.getByTestId('nsx-model-menu').innerText()).includes('no known models'), false);
  await page.getByTestId('nsx-model-menu').getByRole('menuitemradio').filter({ hasText: 'Claude Sonnet 5' }).click();
  assert.notEqual(await page.getByTestId('nsx-send').getAttribute('aria-disabled'), 'true');
  phase = 'launch';
  const response = page.waitForResponse(res => res.url().endsWith('/v2/execution/spawn') && res.request().method() === 'POST', { timeout: 60000 });
  await page.getByTestId('nsx-send').click();
  const spawned = await response, body = await spawned.json();
  assert.equal(spawned.status(), 201, JSON.stringify(body));
  const sessionId = body.data.entity.id;
  launchedId = sessionId;
  phase = 'open session terminal';
  // Launch opens the session on current hosts; if a host keeps the task open,
  // use its session row exactly as a user would.
  const sessionRow = page.locator(`[data-entity-id="${sessionId}"]`);
  if (await sessionRow.count()) await sessionRow.first().click();
  const deadline = Date.now() + 20000;
  while (!output.includes('TM8_TASK_EXECUTED') && Date.now() < deadline) await page.waitForTimeout(100);
  assert.ok(output.includes('TM8_TASK_EXECUTED'), 'Task output must reach the visible session terminal');
  console.log('PASS: task Run opens populated model picker and Launch starts the private workspace session with live output');
  phase = 'terminal reconnect'; output = '';
  await page.reload();
  const reconnectDeadline = Date.now() + 15000;
  while (!output.includes('TM8_TASK_EXECUTED') && Date.now() < reconnectDeadline) await page.waitForTimeout(100);
  assert.ok(output.includes('TM8_TASK_EXECUTED'), 'Refresh must replay the session terminal');
  console.log('PASS: browser refresh reconnects to the same private task terminal');
  phase = 'terminal grant permissions';
  const security = await page.evaluate(async id => {
    const request = await fetch(`/v2/entities/${id}/commands/streams-attach`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-TM8-Client': 'tm8-ui' }, body: JSON.stringify({ mode: 'view' }) });
    const { data: grant } = await request.json();
    const url = new URL(grant.url, location.href); url.protocol = 'ws:';
    const protocols = ['tm8-pty-v1', `tm8-grant.${grant.token}`];
    const readOnly = await new Promise(resolve => {
      let text = '', attached = false;
      const ws = new WebSocket(url, protocols); ws.binaryType = 'arraybuffer';
      setTimeout(() => { ws.close(); resolve(false); }, 5000);
      ws.onmessage = event => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'attached' && !attached) {
          attached = true; ws.send(new TextEncoder().encode('PING\n'));
          setTimeout(() => { ws.close(); resolve(!text.includes('TM8_TASK_PONG')); }, 600);
        } else if (event.data instanceof ArrayBuffer) text += new TextDecoder().decode(event.data);
      };
      ws.onerror = () => resolve(false);
    });
    const replayRefused = await new Promise(resolve => {
      const ws = new WebSocket(url, protocols);
      ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
    });
    return { readOnly, replayRefused };
  }, sessionId);
  assert.equal(security.readOnly, true, 'A view grant must not write to the terminal');
  assert.equal(security.replayRefused, true, 'A consumed grant must not be reusable');
  console.log('PASS: private terminal grants are single-use and view-only grants cannot send input');
  phase = 'stop session';
  const [stop] = await Promise.all([
    page.waitForResponse(res => res.url().includes(`/entities/${sessionId}/commands/terminate`)),
    page.getByRole('button', { name: 'Terminate', exact: true }).first().click(),
  ]);
  assert.equal(stop.status(), 200, JSON.stringify(await stop.json()));
  launchedId = null;
  console.log('PASS: the UI Stop control ends the launched task session');
} catch (error) {
  console.error(`Browser verification failed during ${phase}`);
  console.error((await page.locator('body').innerText()).replace(/https?:\/\/\S+/g, '[URL]').slice(-3500));
  await page.screenshot({ path: '/tmp/tm8-task-browser.png' });
  throw error;
} finally {
  if (launchedId) await page.evaluate(id => fetch(`/v2/entities/${id}/commands/terminate`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-TM8-Client': 'tm8-ui' }, body: JSON.stringify({ clientMutationId: crypto.randomUUID() }) }), launchedId).catch(() => {});
  await browser.close();
}
