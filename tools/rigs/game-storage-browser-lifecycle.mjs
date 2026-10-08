/** Bound teardown using only browser processes created by this rig. */
export function createBrowserLifecycle(chromium, {
  launchOptions = {}, closeTimeoutMs = 15_000,
  checkpoint = event => console.log(JSON.stringify(event)),
} = {}) {
  const owned = new WeakMap();
  let sequence = 0, browserCloseForced = 0;
  const mark = (label, boundary, detail = {}) => checkpoint({
    stage: 'synthetic browser operation', sequence: ++sequence, label, boundary, ...detail,
  });
  const entryOf = browser => {
    const entry = owned.get(browser);
    if (!entry) throw new Error('Refusing teardown of an unregistered browser');
    return entry;
  };
  async function step(label, operation) {
    mark(label, 'before');
    const result = await operation();
    mark(label, 'after');
    return result;
  }
  async function close(label, operation, entry) {
    if (entry.closed) { mark(label, 'skipped', { browserAlreadyClosed: true }); return; }
    const timeout = new Error('Owned browser teardown exceeded its 15-second budget');
    let timer;
    mark(label, 'before', { ownedBrowserPid: entry.pid });
    try {
      await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeout), closeTimeoutMs);
      })]);
      mark(label, 'after');
    } catch (error) {
      if (error !== timeout) throw error;
      browserCloseForced++;
      mark(label, 'forced', { ownedBrowserPid: entry.pid, browserCloseForced });
      // BrowserServer.kill() kills its own spawned process and waits for exit.
      await entry.server.kill();
      entry.closed = true;
      mark(label, 'after', { forced: true });
    } finally { clearTimeout(timer); }
  }
  return {
    async launch() {
      const server = await step('launch browser process', () => chromium.launchServer({
        ...launchOptions, host: '127.0.0.1',
      }));
      const pid = server.process().pid; // Supported API; never discover or target peer PIDs.
      try {
        const browser = await step('connect browser', () => chromium.connect(server.wsEndpoint()));
        owned.set(browser, { server, pid, closed: false });
        mark('browser ownership', 'registered', { ownedBrowserPid: pid });
        return browser;
      } catch (error) { await server.kill(); throw error; }
    },
    async closeContext(context, browser) {
      if (context) await close('context close', () => context.close(), entryOf(browser));
    },
    async closeBrowser(browser) {
      if (!browser) return;
      const entry = entryOf(browser);
      await close('browser close', async () => {
        if (browser.isConnected()) await browser.close();
        await entry.server.close();
      }, entry);
      entry.closed = true;
    },
    evaluate(page, label, expression, argument) {
      return step(`evaluate: ${label}`, () => page.evaluate(expression, argument));
    },
    diagnostics: () => ({ browserCloseForced }),
  };
}
