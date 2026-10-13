'use strict';
/**
 * tm8 desktop — Electron main process.
 *
 * This shell does four things and deliberately nothing else:
 *
 *  1. Open ONE window and paint a status line immediately. Measured first
 *     launch is ~8-10 s and every launch after it ~2-3 s (plan §B.4/§C.2), so
 *     there is no wizard, no click-through and no dialog — just a line of text
 *     that stops being true when the app loads.
 *  2. Fork `packages/server/dist/index.js` — the *same* file the server install
 *     runs — as a pure Node process (`ELECTRON_RUN_AS_NODE=1`), and point it at
 *     the Postgres binaries inside the bundle.
 *  3. Load whatever URL that child reports. The renderer is an ordinary
 *     same-origin web client of the tm8 server; it gets no preload, no
 *     `nodeIntegration`, and no desktop-only branch (AM-7/T-D24).
 *  4. Ask the child to shut down on quit, and stop waiting after 5 s.
 *
 * Four operator knobs, all from ONE settings file (`readSettings`,
 * docs/ops/DESKTOP.md): a fixed HTTP port, chosen `TM8_*` server env, and a
 * remote node to open instead of starting the local one. Where the local node
 * listens is published for the CLI (`writeDiscovery`).
 *
 * There is NO IPC spawn surface here. Sessions are spawned server-side, by the
 * server, exactly as they are for a browser client — that half of T-D21 was not
 * reversed.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PG_VERSION = '18.6.0';
const PG_MAJOR = '18';

const IS_MAC = process.platform === 'darwin';
/** Height of the shell-painted strip that replaces the native title bar. */
const TITLE_BAR_HEIGHT = 28;
/** Centres the 12px traffic lights vertically in that strip. */
const TRAFFIC_LIGHTS = { x: 12, y: 8 };

/** Grace period for the child's own shutdown chain before SIGKILL (plan §B.5). */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The HTTP port the local node asks for first. A STABLE port is what keeps a
 * sign-in: the renderer's localStorage is per origin, and the origin includes
 * the port, so an ephemeral port per launch started every launch signed out.
 * (Electron's default session is the persistent one under userData — no
 * `partition` is set below — so a stable origin is all that was missing.)
 * 4619 is referenced nowhere else in the repo (4610/4611 dev, 4620/4621 the
 * documented second stack). Busy → an ephemeral port, said in the log.
 */
const DEFAULT_PORT = 4619;
/** Budget for the remote node's `/health` before its window is shown. */
const REMOTE_HEALTH_TIMEOUT_MS = 10_000;

/**
 * The ONLY `TM8_*` keys a settings file may set: the node's network and access
 * switches, and its log level. An allow-list, not a deny-list, so a key that
 * points the server elsewhere (TM8_DATABASE_URL, TM8_DELIVERY_DATABASE_URL,
 * TM8_DATA_DIR, TM8_BIND, the dev-only loopback switch) or carries another
 * process's identity (TM8_AGENT_TOKEN, TM8_SESSION_ID) can never get in.
 * The shell's own layout keys are written after these anyway.
 */
const SETTABLE_ENV = new Set([
  'TM8_NODE_MODE', 'TM8_PUBLIC_ORIGIN', 'TM8_ALLOWED_HOSTNAMES', 'TM8_ALLOWED_ORIGINS',
  'TM8_REMOTE_SPACE_LINKS', 'TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE',
  'TM8_SPACE_SESSIONS', 'TM8_DISABLE_AUTO_OWNER', 'TM8_LOG_LEVEL',
]);

// Must precede `app.getPath('userData')` or an unpackaged run would write to
// ~/Library/Application Support/Electron and a packaged one to .../tm8 — i.e.
// `electron .` would not be testing the app's real data directory.
app.setName('tm8');

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let quitting = false;
let loadedApp = false;
/** Set once the local node reported ready; the discovery file names it. */
let discoveryWritten = false;

/**
 * Where the tm8 tree lives, unpackaged and packaged alike.
 *
 * Packaged, `src/` is inside `app.asar` and the sibling `packages/` and `db/`
 * come along with it; the Postgres tree is an `extraResources` entry beside the
 * asar because 125 Mach-O binaries cannot be executed from inside one.
 */
function resolveLayout() {
  const packaged = app.isPackaged;
  const appRoot = packaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '..', '..', '..');
  const pgRoot = packaged
    ? path.join(process.resourcesPath, 'pg', PG_VERSION)
    : path.resolve(__dirname, '..', 'resources', 'pg', PG_VERSION);

  return {
    appRoot,
    serverEntry: path.join(appRoot, 'packages', 'server', 'dist', 'index.js'),
    uiDir: path.join(appRoot, 'packages', 'tm8-ui', 'dist'),
    pgBinDir: path.join(pgRoot, 'bin'),
    dataDir: app.getPath('userData'),
  };
}

function setStatus(message, detail) {
  if (win === null || win.isDestroyed() || loadedApp) return;
  // `?.` guards the window between `loadFile` and `did-finish-load`.
  win.webContents
    .executeJavaScript(
      `window.tm8Status?.(${JSON.stringify(String(message))}, ${JSON.stringify(detail ? String(detail) : '')})`,
      true,
    )
    .catch(() => undefined);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'tm8',
    backgroundColor: '#101014',
    // No native title bar: it only repeated the word "tm8" above the app. On
    // macOS 'hidden' keeps the traffic lights (close / minimise / zoom) and
    // floats them over the top-left of the page; installTitleBarChrome() gives
    // them a drag strip to sit in. Other platforms keep their native frame.
    ...(IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS } : {}),
    show: true,
    webPreferences: {
      // The renderer is a web client and nothing more. No preload, because a
      // preload is a capability, and this window has no capability to hand it.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.on('did-finish-load', () => installTitleBarChrome());
  win.loadFile(path.join(__dirname, 'status.html')).catch(() => undefined);

  // External links leave the app rather than replacing the tm8 window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/**
 * The drag strip that replaces the native title bar, painted by the SHELL.
 *
 * With the title bar hidden, nothing on the page is draggable and the traffic
 * lights sit on top of whatever the app draws in its top-left corner. The
 * renderer has no desktop-only branch (AM-7/T-D24), so the fix belongs here:
 * after every load (status page, app, reload) push the whole page down by one
 * strip and fill that strip with a fixed, draggable element. `#root` is sized
 * `height: 100%` against body, so a border-box body padding shrinks the app
 * rather than overflowing it. Idempotent: a reload re-runs it on a fresh DOM.
 */
function installTitleBarChrome() {
  if (!IS_MAC || win === null || win.isDestroyed()) return;
  const h = `${TITLE_BAR_HEIGHT}px`;
  win.webContents
    .insertCSS(
      `html body { box-sizing: border-box; padding-top: ${h}; }\n` +
        `#tm8-desktop-titlebar { position: fixed; top: 0; left: 0; right: 0; height: ${h};` +
        ` z-index: 2147483647; -webkit-app-region: drag; -webkit-user-select: none;` +
        ` background: var(--pn-surface, #FBFAF6); border-bottom: 1px solid rgba(0, 0, 0, 0.06); }`,
    )
    .catch(() => undefined);
  win.webContents
    .executeJavaScript(
      `(() => { if (document.getElementById('tm8-desktop-titlebar')) return;` +
        ` const bar = document.createElement('div'); bar.id = 'tm8-desktop-titlebar';` +
        ` bar.setAttribute('aria-hidden', 'true'); document.body.appendChild(bar); })()`,
      true,
    )
    .catch(() => undefined);
}

/**
 * Every `node_modules/.bin` directory is removed from PATH.
 *
 * `bun run` and `npm run` PREPEND the `node_modules/.bin` of the package AND
 * EVERY ANCESTOR directory, up to `/node_modules/.bin`. The server hands this
 * PATH to every agent it spawns, and only APPENDS the real install dirs
 * (`withAgentBinDirs`), so any `claude` a package manager happened to leave in
 * an ancestor wins. Measured 2026-09-25: a stray `~/package.json` pinned
 * `@anthropic-ai/claude-code@2.1.77` into `~/node_modules/.bin`, and under
 * `bun run desktop` every lane ran it instead of `/opt/homebrew/bin/claude`
 * (2.1.280). Opus 5.5 then refused with a 400 ("2.1.280 or newer is
 * required"). A packaged `.app` never has these entries; a dev launch
 * should not either.
 */
function withoutPackageManagerBins(pathValue) {
  if (!pathValue) return pathValue;
  return pathValue
    .split(':')
    .filter((dir) => dir !== '' && !/(^|\/)node_modules\/\.bin\/?$/.test(dir))
    .join(':');
}

/**
 * The launching shell's environment, minus every `TM8_*` variable.
 *
 * Started from a terminal inside a tm8 agent lane, the shell inherits that
 * lane's `TM8_AGENT_TOKEN`, `TM8_SESSION_ID`, `TM8_BASE_URL`, … and the server
 * hands its own env to every agent it spawns — so without this, desktop agents
 * would authenticate as, and report to, a session on a different server. This
 * node's `TM8_*` configuration is exactly the set written below, nothing more.
 */
function inheritedEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TM8_')));
  if (env.PATH !== undefined) env.PATH = withoutPackageManagerBins(env.PATH);
  return env;
}

/**
 * `<userData>/desktop.json` (macOS: ~/Library/Application Support/tm8/desktop.json):
 *
 *   { "port": 4619, "env": { "TM8_REMOTE_SPACE_LINKS": "on" }, "remoteUrl": "https://tm8.example.com" }
 *
 * Every key is optional. A missing file is the defaults; a malformed file or
 * key is reported (log + status line) and ignored — never a failed launch.
 */
function readSettings(dataDir) {
  const file = path.join(dataDir, 'desktop.json');
  const settings = { port: DEFAULT_PORT, env: {}, remoteUrl: null, problems: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return settings;
    settings.problems.push(`${file} is not readable JSON (${err instanceof Error ? err.message : String(err)}); using defaults`);
    return settings;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    settings.problems.push(`${file} must hold a JSON object; using defaults`);
    return settings;
  }
  if (raw.port !== undefined) {
    if (Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) settings.port = raw.port;
    else settings.problems.push(`"port" must be 1-65535; using ${DEFAULT_PORT}`);
  }
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      settings.problems.push('"env" must be an object of TM8_* strings; ignored');
    } else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (!SETTABLE_ENV.has(key)) {
          settings.problems.push(`"env.${key}" is not settable here; ignored`);
        } else if (typeof value !== 'string') {
          settings.problems.push(`"env.${key}" must be a string; ignored`);
        } else {
          settings.env[key] = value;
        }
      }
    }
  }
  if (raw.remoteUrl !== undefined && raw.remoteUrl !== null && raw.remoteUrl !== '') {
    let url = null;
    try {
      url = new URL(String(raw.remoteUrl));
    } catch {
      url = null;
    }
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      settings.remoteUrl = url.origin;
    } else {
      settings.problems.push('"remoteUrl" must be an http(s) URL without credentials; starting the local node instead');
    }
  }
  return settings;
}

/** True when nothing listens on 127.0.0.1:<port> right now. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** Where the CLI looks for this app (packages/cli/src/context.ts `desktopDiscoveryPath`). */
function discoveryPath() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'tm8', 'desktop-node.json');
}

/**
 * Publish the local node for the CLI. `appPid` is THIS process: the CLI
 * ignores the file once it is dead, so a crash cannot strand it on a dead port.
 */
function writeDiscovery(url) {
  try {
    const file = discoveryPath();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({
      baseUrl: new URL(url).origin,
      pid: child?.pid ?? null,
      appPid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    discoveryWritten = true;
  } catch (err) {
    console.warn(`tm8: could not write ${discoveryPath()}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove the discovery file, only if it still names this process. */
function removeDiscovery() {
  if (!discoveryWritten) return;
  discoveryWritten = false;
  try {
    const file = discoveryPath();
    const current = JSON.parse(readFileSync(file, 'utf8'));
    if (current && current.appPid === process.pid) unlinkSync(file);
  } catch {
    // Already gone, or rewritten by another app: not ours to delete.
  }
}

/** Remote mode: no local server, no Postgres — check the node answers, then open it. */
async function openRemote(remoteUrl) {
  setStatus(`Connecting to ${remoteUrl}…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/health', remoteUrl), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.server !== 'tm8-server') {
      throw new Error(`${remoteUrl}/health answered ${response.status} and is not a tm8 server`);
    }
  } catch (err) {
    fatal(
      `Could not reach ${remoteUrl}`,
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        'Fix or remove "remoteUrl" in desktop.json (docs/ops/DESKTOP.md) and relaunch.',
    );
    return;
  } finally {
    clearTimeout(timer);
  }
  loadedApp = true;
  win?.loadURL(remoteUrl).catch((err) => fatal('The remote tm8 node could not be loaded', String(err)));
}

async function start() {
  const settings = readSettings(app.getPath('userData'));
  for (const problem of settings.problems) console.warn(`tm8: desktop.json: ${problem}`);
  if (settings.problems.length > 0) setStatus('Starting tm8…', `desktop.json: ${settings.problems.join('; ')}`);
  if (settings.remoteUrl) {
    await openRemote(settings.remoteUrl);
    return;
  }
  let port = settings.port;
  if (!(await portFree(port))) {
    console.warn(`tm8: port ${port} is in use — using an ephemeral port; sign-ins will not carry over to the next launch`);
    port = 0;
  }
  startServer(settings.env, port);
}

function startServer(extraEnv, port) {
  const layout = resolveLayout();

  if (!existsSync(layout.serverEntry)) {
    fatal(
      'tm8 is not built',
      `Expected the server bundle at:\n${layout.serverEntry}\n\n` +
        `Run \`bun run build\` and \`cd packages/tm8-ui && bun run build\` from the repo root.`,
    );
    return;
  }
  if (!existsSync(path.join(layout.pgBinDir, 'postgres'))) {
    fatal(
      'The bundled Postgres is missing',
      `Expected Postgres ${PG_VERSION} at:\n${layout.pgBinDir}\n\n` +
        `Run \`node apps/desktop/scripts/vendor-pg.mjs\`.`,
    );
    return;
  }

  /** Set by a `failed` EADDRINUSE report: the exit handler restarts on port 0. */
  let retryEphemeral = false;
  child = fork(layout.serverEntry, [], {
    // A pure Node runtime. Electron's own binary IS the node here — this is
    // what makes it unnecessary to ship a second Node, and it is also what
    // satisfies `PtyHostService`'s refusal to run under bun.
    execPath: process.execPath,
    // Electron main's own argv carries flags Node would reject, and `fork`
    // inherits `execArgv` by default. Source maps match `deploy/prod/run-server.sh`.
    execArgv: ['--enable-source-maps'],
    env: {
      ...inheritedEnv(),
      // Operator-chosen TM8_* from desktop.json; every shell-owned key below wins.
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: '1',
      TM8_DESKTOP: '1',
      TM8_DATA_DIR: layout.dataDir,
      TM8_REPO_ROOT: layout.appRoot,
      TM8_UI_DIR: layout.uiDir,
      // Sidecar resolution step 1 (`binaries.ts`) — the whole `.app` hook.
      TM8_PG_BIN_DIR: layout.pgBinDir,
      TM8_PG_MAJOR: PG_MAJOR,
      // Socket only. The port number then names `.s.PGSQL.<port>` inside our
      // own 0700 data dir and cannot collide with the developer's cluster.
      TM8_PG_LISTEN_ADDRESSES: '',
      // The stable port (0: ephemeral); the child tells us which one it got.
      TM8_PORT: String(port),
      // The Electron main process has no TTY, so colour codes would be noise.
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (b) => process.stdout.write(`[server] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`));

  child.on('message', (msg) => {
    if (msg === null || typeof msg !== 'object' || msg.type !== 'tm8:desktop') return;
    if (msg.phase === 'ready' && typeof msg.url === 'string') {
      loadedApp = true;
      writeDiscovery(msg.url);
      win?.loadURL(msg.url).catch((err) => fatal('tm8 started but the window could not load it', String(err)));
      return;
    }
    if (msg.phase === 'failed') {
      // The port was free when probed and taken before listen(): one retry, ephemeral.
      if (port !== 0 && /EADDRINUSE/.test(String(msg.message ?? ''))) {
        console.warn(`tm8: port ${port} was taken during startup — retrying on an ephemeral port`);
        retryEphemeral = true;
        return;
      }
      fatal(msg.message ?? 'tm8 failed to start', msg.detail);
      return;
    }
    setStatus(msg.message ?? '');
  });

  child.on('exit', (code, signal) => {
    child = null;
    removeDiscovery();
    if (quitting) return;
    if (retryEphemeral) {
      startServer(extraEnv, 0);
      return;
    }
    fatal(
      'The tm8 server stopped',
      `It exited with ${signal !== null ? `signal ${signal}` : `code ${code}`}. See the log above for detail.`,
    );
  });
}

function fatal(title, detail) {
  if (quitting) return;
  console.error(`tm8: ${title}\n${detail ?? ''}`);
  if (win !== null && !win.isDestroyed() && !loadedApp) {
    setStatus(title, detail ?? '');
  } else {
    dialog.showErrorBox(title, String(detail ?? ''));
  }
}

/**
 * Ask the child to run its own shutdown chain (scheduler → server → preview →
 * delivery → db.end → `sidecar.stop()`), then stop waiting.
 *
 * `pg_ctl -m fast` is the graceful path, but the ungraceful one is already
 * sound and measured at 0.45 s of WAL replay, so there is nothing to be gained
 * by waiting longer than the budget.
 */
function shutdownChild() {
  return new Promise((resolve) => {
    if (child === null) return resolve();
    const proc = child;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(`tm8: server did not exit in ${SHUTDOWN_GRACE_MS} ms — SIGKILL`);
      proc.kill('SIGKILL');
      done();
    }, SHUTDOWN_GRACE_MS);

    proc.once('exit', done);
    try {
      proc.send({ type: 'tm8:shutdown' });
    } catch {
      proc.kill('SIGTERM');
    }
  });
}

// A second instance would meet `sidecar.lock` and be refused; catching it here
// means the user gets their existing window focused instead of an error.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // A packaged app gets its icon from build/icon.icns (electron-builder). An
    // unpackaged `electron .` runs inside Electron.app and would show ITS icon
    // in the dock, so dev sets the same artwork by hand. Both are cut from the
    // in-app ribbon mark by packages/tm8-ui/scripts/gen-pwa-icons.py.
    if (IS_MAC && !app.isPackaged) {
      const icon = path.join(__dirname, '..', 'build', 'icon.png');
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }
    createWindow();
    void start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => removeDiscovery());

  app.on('before-quit', (event) => {
    if (quitting || child === null) return;
    quitting = true;
    event.preventDefault();
    void shutdownChild().then(() => app.quit());
  });
}
