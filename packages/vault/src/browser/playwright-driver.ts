import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type Frame, type Locator, type Page, type Request } from 'playwright-core';
import type { FillDriver, FillIntent, FillOutcome, FillRefusalCode, LoginMaterial, MaskedScreenshot } from '../types.js';
import { sameOrigin } from '../origin/normalize.js';
import { zeroize } from '../secret-material.js';
import { launchIsolatedBrowser, type BrowserOptions } from './browser-session.js';
import { checkFormAction, checkNavigationChain, checkPasswordFieldLocation, checkTopFrameUrl, observedOrigin } from './policy.js';
import { DEFAULT_FILL_TIMEOUT_MS } from './protocol.js';

const CONTROLS = 'input, textarea, select, [contenteditable]';
const PASSWORDS = 'input[type="password"]';

/** Private to the trusted fill process. The broker uses RemoteFillDriver. */
export class PlaywrightFillDriver implements FillDriver {
  #browser: Browser | null = null;
  #closed = false;
  #busy = false;

  constructor(private readonly options: BrowserOptions = {}) {}

  async fill(input: { intent: FillIntent; material: LoginMaterial; signal?: AbortSignal }): Promise<FillOutcome> {
    if (this.#closed || this.#busy) return failed('browser_unavailable');
    this.#busy = true;
    const { intent, material, signal } = input;
    const startUrl = intent.startUrl ?? `${intent.origin}/`;
    let code = checkTopFrameUrl(startUrl, intent.origin, intent.devMode);
    if (code) { this.#busy = false; return failed(code, startUrl); }
    if (signal?.aborted) { this.#busy = false; return failed('timeout'); }

    let page: Page | null = null;
    let context: BrowserContext | null = null;
    let timedOut = false;
    let launchFailed = true;
    let screenshot: MaskedScreenshot | null = null;
    let returnedScreenshot = false;
    let phase: 'opening' | 'filling' | 'submitting' = 'opening';
    let routeRefusal: FillRefusalCode | null = null;
    const chain: string[] = [];
    const variants: string[] = [];
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
    const stop = () => { timedOut = true; void this.#browser?.close().catch(() => {}); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    try {
      this.#browser = await launchIsolatedBrowser({ ...this.options, timeoutMs });
      if (timedOut) return failed('timeout');
      launchFailed = false;
      context = await this.#browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      await context.clearPermissions();
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      const activePage = page;
      context.on('page', (extra) => { if (extra !== activePage) void extra.close().catch(() => {}); });
      page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
      page.on('download', (download) => { void download.cancel().catch(() => {}); });
      page.on('filechooser', (chooser) => { void chooser.setFiles([]).catch(() => {}); });
      await page.addInitScript(() => {
        // The worker never grants clipboard permission. Remove the page API too.
        try { Object.defineProperty(navigator, 'clipboard', { value: undefined }); } catch { /* no grant */ }
      });
      await page.routeWebSocket('**/*', (socket) => socket.close());
      const makeVariants = () => {
        // Kept only in this fill's closure, never exposed to evaluate or a log.
        const raw = material.password.utf8();
        const encoded = encodeURIComponent(raw);
        variants.push(raw, encoded, encoded.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()),
          new URLSearchParams({ v: raw }).toString().slice(2),
          material.password.use((bytes) => bytes.toString('base64')),
          material.password.use((bytes) => bytes.toString('base64url')),
          JSON.stringify(raw).slice(1, -1),
          [...raw].map((char) => [...char].map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')).join(''));
      };
      const carriesValue = (value: string) => variants.some((part) => part.length > 0 && value.includes(part));
      // Browser-level routing also covers requests initiated by frames and workers.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const offOrigin = !sameOrigin(request.url(), intent.origin, { devMode: intent.devMode });
        if (offOrigin && (carriesValue(request.url()) || carriesValue(request.postData() ?? ''))) {
          routeRefusal = 'cross_origin_form_action';
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      await page.route('**/*', async (route) => {
        const request = route.request();
        const mainNavigation = request.isNavigationRequest() && request.frame() === activePage.mainFrame();
        if (mainNavigation && phase !== 'submitting') {
          chain.push(request.url());
          const navigationCode = checkNavigationChain(chain, intent.origin, intent.devMode);
          if (navigationCode) {
            routeRefusal = navigationCode;
            await route.abort('blockedbyclient');
            return;
          }
        }
        if (mainNavigation && sameOrigin(request.url(), intent.origin, { devMode: intent.devMode })) {
          // Browser routing does not re-run for every HTTP redirect. Fetch with
          // redirects disabled and check EACH Location before any next request.
          // Same-origin hops are resolved here; their final response is fulfilled
          // at the initial same-origin URL. Never serve off-origin bytes under it.
          let url = request.url();
          let method = request.method();
          let postData = request.postData() ?? '';
          for (let hop = 0; hop < 20; hop += 1) {
            const result = await route.fetch({ url, method, postData, maxRedirects: 0, timeout: timeoutMs });
            const status = result.status();
            const location = result.headers().location;
            if (![301, 302, 303, 307, 308].includes(status) || !location) {
              await route.fulfill({ response: result });
              await result.dispose();
              return;
            }
            let target: string;
            try { target = new URL(location, url).href; }
            catch { await result.dispose(); routeRefusal = 'cross_origin_redirect'; await route.abort('blockedbyclient'); return; }
            const targetOffOrigin = !sameOrigin(target, intent.origin, { devMode: intent.devMode });
            const retainsBody = status === 307 || status === 308;
            // A form charset or multipart encoding may transform the password.
            // Never forward ANY submitted body off-origin with 307/308.
            if (targetOffOrigin && (carriesValue(target) || (retainsBody && postData.length > 0))) {
              await result.dispose();
              routeRefusal = 'cross_origin_form_action';
              await route.abort('blockedbyclient');
              return;
            }
            if (targetOffOrigin) {
              if (phase !== 'submitting') {
                await result.dispose();
                routeRefusal = 'cross_origin_redirect';
                await route.abort('blockedbyclient');
                return;
              }
              // The checked form already received the credential. A safe GET
              // redirect may now change finalOrigin without being a refusal.
              await route.fulfill({ response: result });
              await result.dispose();
              return;
            }
            chain.push(target);
            await result.dispose();
            if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
              method = 'GET'; postData = '';
            }
            url = target;
          }
          routeRefusal = 'cross_origin_redirect';
          await route.abort('blockedbyclient');
          return;
        }
        // fallback is essential: continue() would bypass the context exfiltration guard.
        await route.fallback();
      });

      let response;
      try { response = await page.goto(startUrl, { waitUntil: 'domcontentloaded' }); }
      catch { return failed(routeRefusal ?? (timedOut ? 'timeout' : 'navigation_failed'), page.url()); }
      if (response) {
        const redirects: string[] = [];
        let request: Request | null = response.request();
        while (request) { redirects.unshift(request.url()); request = request.redirectedFrom(); }
        code = checkNavigationChain(redirects, intent.origin, intent.devMode);
        if (code) return failed(code, page.url());
      }
      code = routeRefusal ?? checkTopFrameUrl(page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      const password = await firstUsable(page, PASSWORDS);
      if (!password) {
        let inChild = false;
        for (const child of page.frames()) {
          if (child !== page.mainFrame() && await firstUsable(child, PASSWORDS)) { inChild = true; break; }
        }
        return failed(checkPasswordFieldLocation(false, inChild) ?? 'fields_not_found', page.url());
      }
      const fieldMarker = `data-tm8-fill-${randomUUID()}`;
      await password.evaluate((element, marker) => element.setAttribute(marker, 'password'), fieldMarker);
      const action = await formAction(password);
      if (action === null) return failed('fields_not_found', page.url());
      code = checkFormAction(action, page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      if (intent.submit) {
        const initialTarget = await submissionTarget(password, await submitButton(page, fieldMarker));
        code = initialTarget === null ? 'fields_not_found' : checkFormAction(initialTarget, page.url(), intent.origin, intent.devMode);
        if (code) return failed(code, page.url());
      }
      const username = await usernameField(page, password, fieldMarker);
      if (username) await username.evaluate((element, marker) => element.setAttribute(marker, 'username'), fieldMarker);
      phase = 'filling';
      makeVariants();
      // Recheck immediately before EACH fill. The page may navigate after a username event.
      code = routeRefusal ?? checkTopFrameUrl(page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      if (username && material.username !== null) await username.fill(material.username);
      code = routeRefusal ?? checkTopFrameUrl(page.url(), intent.origin, intent.devMode);
      const currentAction = await formAction(password);
      code ??= currentAction === null ? 'fields_not_found' : checkFormAction(currentAction, page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      // This is the ONLY transfer of the password into the page.
      await password.fill(material.password.utf8());
      code = routeRefusal ?? checkTopFrameUrl(page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      const postFillAction = await formAction(password);
      code = postFillAction === null ? 'fields_not_found' : checkFormAction(postFillAction, page.url(), intent.origin, intent.devMode);
      if (code) return failed(code, page.url());
      screenshot = await maskedScreenshot(page, fieldMarker, false);
      if (routeRefusal) return failed(routeRefusal, page.url());

      if (intent.submit) {
        // A checked submitter may override the form action; check that too.
        const submit = await submitButton(page, fieldMarker);
        const target = await submissionTarget(password, submit);
        code = checkTopFrameUrl(page.url(), intent.origin, intent.devMode);
        code ??= target === null ? 'fields_not_found' : checkFormAction(target, page.url(), intent.origin, intent.devMode);
        if (code || routeRefusal) return failed(routeRefusal ?? code ?? 'navigation_failed', page.url());
        const valid = await password.evaluate((element) => (element as HTMLInputElement).form?.checkValidity() ?? false);
        if (!valid) return failed('fields_not_found', page.url());
        phase = 'submitting';
        const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 5_000) }).catch(() => null);
        if (submit) await submit.click();
        else await password.evaluate((element) => {
          const form = (element as HTMLInputElement).form;
          if (form) HTMLFormElement.prototype.requestSubmit.call(form);
        });
        await navigation;
        if (routeRefusal) return failed(routeRefusal, page.url());
      }
      // Always capture the end state too. The seam returns just this last image.
      const finalScreenshot = await maskedScreenshot(page, fieldMarker, intent.submit);
      zeroize(screenshot.data);
      screenshot = finalScreenshot;
      if (routeRefusal) return failed(routeRefusal, page.url());
      const finalOrigin = observedOrigin(page.url());
      if (finalOrigin === null) return failed('navigation_failed');
      returnedScreenshot = true;
      return { ok: true, finalOrigin, submitted: intent.submit, screenshot };
    } catch {
      return failed(routeRefusal ?? (timedOut || signal?.aborted ? 'timeout' : launchFailed ? 'browser_unavailable' : 'navigation_failed'), page?.url());
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      variants.fill('');
      variants.length = 0;
      if (!returnedScreenshot) zeroize(screenshot?.data);
      await context?.close().catch(() => {});
      await this.#browser?.close().catch(() => {});
      this.#browser = null;
      this.#busy = false;
      // material is caller-owned and intentionally never disposed here.
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }
}

function failed(code: FillRefusalCode, url?: string): FillOutcome {
  return { ok: false, code, observedOrigin: url ? observedOrigin(url) : null, screenshot: null };
}

async function firstUsable(root: Page | Frame | Locator, selector: string): Promise<Locator | null> {
  const fields = root.locator(selector);
  for (let i = 0, count = await fields.count(); i < count; i += 1) {
    const field = fields.nth(i);
    if (await field.isVisible() && await field.isEnabled()) return field;
  }
  return null;
}

async function formAction(password: Locator): Promise<string | null> {
  return password.evaluate((element) => (element as HTMLInputElement).form?.action ?? null);
}

async function sameForm(field: Locator, fieldMarker: string): Promise<boolean> {
  return field.evaluate((element, marker) => {
    const password = document.querySelector<HTMLInputElement>(`[${marker}="password"]`);
    return !!password?.form && (element as HTMLInputElement | HTMLButtonElement).form === password.form;
  }, fieldMarker);
}

async function submitButton(page: Page, fieldMarker: string): Promise<Locator | null> {
  const buttons = page.locator('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
  for (let i = 0, count = await buttons.count(); i < count; i += 1) {
    const button = buttons.nth(i);
    if (await button.isVisible() && await button.isEnabled() && await sameForm(button, fieldMarker)) return button;
  }
  return null;
}

async function submissionTarget(password: Locator, submit: Locator | null): Promise<string | null> {
  return submit ? submit.evaluate((element) => {
    const button = element as HTMLButtonElement;
    return button.hasAttribute('formaction') ? button.formAction : button.form?.action ?? null;
  }) : formAction(password);
}

async function usernameField(page: Page, password: Locator, fieldMarker: string): Promise<Locator | null> {
  const marked = page.locator('input[autocomplete~="username" i]');
  for (let i = 0, count = await marked.count(); i < count; i += 1) {
    const field = marked.nth(i);
    if (await field.isVisible() && await field.isEnabled() && await sameForm(field, fieldMarker)) return field;
  }
  const preceding = page.locator('input:not([type]), input[type="text"], input[type="email"]');
  for (let i = await preceding.count() - 1; i >= 0; i -= 1) {
    const field = preceding.nth(i);
    if (!await field.isVisible() || !await field.isEnabled() || !await sameForm(field, fieldMarker)) continue;
    // No values cross this evaluation, only document order.
    const after = await password.evaluate((element, index) => {
      const candidates = document.querySelectorAll('input:not([type]), input[type="text"], input[type="email"]');
      const candidate = candidates?.[index];
      return !!candidate && !!(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, i);
    if (after) return field;
  }
  return null;
}

async function maskedScreenshot(page: Page, fieldMarker: string, afterSubmit: boolean): Promise<MaskedScreenshot> {
  const textMarker = `data-tm8-mask-${randomUUID()}`;
  const mask: Locator[] = [];
  let maskedRegions = 0;
  for (const frame of page.frames()) {
    const controls = frame.locator(CONTROLS);
    maskedRegions += await controls.count();
    mask.push(controls);
    const conservative = afterSubmit || frame !== page.mainFrame();
    if (conservative) {
      // After navigation we cannot safely know where a site reflected a value.
      // Cover the document as well as controls instead of exporting page text.
      const body = frame.locator('body');
      maskedRegions += await body.count();
      mask.push(body);
      continue;
    }
    const count = await frame.evaluate(({ fieldMarker, textMarker }) => {
      // Values originate ONLY from the filled DOM controls, never from evaluate arguments.
      const values = [...document.querySelectorAll<HTMLInputElement>(`[${fieldMarker}]`)].map((element) => element.value).filter(Boolean);
      let count = 0;
      for (const element of document.querySelectorAll('body, body *')) {
        if (values.some((value) => (element.textContent ?? '').includes(value))) {
          element.setAttribute(textMarker, '');
          count += 1;
        }
      }
      return count;
    }, { fieldMarker, textMarker });
    maskedRegions += count;
    mask.push(frame.locator(`[${textMarker}]`));
  }
  const data = await page.screenshot({ type: 'png', mask, maskColor: '#000000', animations: 'disabled', caret: 'hide' });
  return { mime: 'image/png', data, width: data.readUInt32BE(16), height: data.readUInt32BE(20), maskedRegions };
}
