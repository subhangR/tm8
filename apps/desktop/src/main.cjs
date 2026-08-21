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
 * There is NO IPC spawn surface here. Sessions are spawned server-side, by the
 * server, exactly as they are for a browser client — that half of T-D21 was not
 * reversed.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const PG_VERSION = '18.6.0';
const PG_MAJOR = '18';

/** Grace period for the child's own shutdown chain before SIGKILL (plan §B.5). */
const SHUTDOWN_GRACE_MS = 5_000;

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
    show: true,
    webPreferences: {
      // The renderer is a web client and nothing more. No preload, because a
      // preload is a capability, and this window has no capability to hand it.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

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

function startServer() {
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

  child = fork(layout.serverEntry, [], {
    // A pure Node runtime. Electron's own binary IS the node here — this is
    // what makes it unnecessary to ship a second Node, and it is also what
    // satisfies `PtyHostService`'s refusal to run under bun.
    execPath: process.execPath,
    // Electron main's own argv carries flags Node would reject, and `fork`
    // inherits `execArgv` by default. Source maps match `deploy/prod/run-server.sh`.
    execArgv: ['--enable-source-maps'],
    env: {
      ...process.env,
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
      // Ephemeral HTTP port; the child tells us which one it got.
      TM8_PORT: '0',
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
      win?.loadURL(msg.url).catch((err) => fatal('tm8 started but the window could not load it', String(err)));
      return;
    }
    if (msg.phase === 'failed') {
      fatal(msg.message ?? 'tm8 failed to start', msg.detail);
      return;
    }
    setStatus(msg.message ?? '');
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (quitting) return;
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
    createWindow();
    startServer();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting || child === null) return;
    quitting = true;
    event.preventDefault();
    void shutdownChild().then(() => app.quit());
  });
}
