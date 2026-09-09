// Host-side launcher: use the app's installed Playwright library with local
// Chrome, without installing dependencies into the bind-mounted repository.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const test = process.argv[2];
if (!['tasks-browser.mjs', 'providers-browser.mjs'].includes(test)) throw new Error('Choose a workspace browser acceptance script');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm8-browser-'));
try {
  const copied = spawnSync('docker', ['cp', '-L', 'tm8-ubuntu24-tm8-1:/workspace/tm8/node_modules/playwright-core', `${dir}/playwright-core`]);
  if (copied.status) throw new Error('Could not copy the browser test library');
  const child = spawn(process.execPath, [new URL(test, import.meta.url).pathname], { stdio: 'inherit', env: { ...process.env,
    TM8_BROWSER_LIBRARY: `${dir}/playwright-core/index.mjs`,
    TM8_CHROME_EXECUTABLE: process.env.TM8_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  } });
  process.exitCode = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1)));
} finally { await fs.rm(dir, { recursive: true, force: true }); }
