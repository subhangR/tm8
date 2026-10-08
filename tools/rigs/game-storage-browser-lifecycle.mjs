/** Bound teardown using only browser processes created by this rig. */
export function gameStorageLaunchOptions() {
  return { headless: true,
    ...(process.env.GAME_CHROMIUM ? { executablePath: process.env.GAME_CHROMIUM } : {}),
    args: ['--no-sandbox', '--no-zygote', '--single-process', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  };
}

export function createBrowserLifecycle(chromium, {
  launchOptions = {}, closeTimeoutMs = 15_000,
  checkpoint = event => console.log(JSON.stringify(event)),
  browserStderr = process.env.GAME_STORAGE_BROWSER_DIAGNOSTICS === '1'
    ? (pid, chunk) => process.stderr.write(`[owned chromium pid=${pid}][err] ${chunk}`) : undefined,
} = {}) {
  const owned = new WeakMap();
  const observedPages = new WeakSet();
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
      const process = server.process();
      const pid = process.pid; // Supported API; never discover or target peer PIDs.
      // launchServer uses an Internal progress controller, so DEBUG omits its browser stderr.
      // Add a read-only listener to the supported owned ChildProcess pipe before any page starts.
      if (browserStderr) process.stderr?.on('data', chunk => browserStderr(pid, chunk));
      process.once('exit', (exitCode, exitSignal) => mark('browser process exit', 'observed', {
        ownedBrowserPid: pid, exitCode, exitSignal,
      }));
      try {
        const browser = await step('connect browser', () => chromium.connect(server.wsEndpoint()));
        owned.set(browser, { server, pid, closed: false });
        browser.on('disconnected', () => mark('browser disconnected', 'observed', { ownedBrowserPid: pid }));
        mark('browser ownership', 'registered', { ownedBrowserPid: pid, executable: process.spawnfile });
        return browser;
      } catch (error) { await server.kill(); throw error; }
    },
    observePage(page, browser) {
      const entry = entryOf(browser);
      if (!observedPages.has(page)) {
        observedPages.add(page);
        page.on('crash', () => mark('page crash', 'observed', { ownedBrowserPid: entry.pid }));
      }
      return page;
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
