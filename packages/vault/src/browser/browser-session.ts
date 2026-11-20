import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { CHROMIUM_FLAGS } from './chromium-flags.js';

export interface BrowserOptions {
  executablePath?: string;
  timeoutMs?: number;
  /** Test harness only: the CLI and socket have no way to select these flags. */
  testOnlyDisableSandbox?: boolean;
}

export async function launchIsolatedBrowser(options: BrowserOptions): Promise<Browser> {
  // Profiles/artifacts created internally by Playwright must stay on tmpfs.
  const filesystem = await statfs(tmpdir());
  if (Number(filesystem.type) !== 0x01021994) throw new Error('browser unavailable');
  return chromium.launch({
    headless: true,
    chromiumSandbox: !options.testOnlyDisableSandbox,
    args: [...CHROMIUM_FLAGS, ...(options.testOnlyDisableSandbox ? ['--disable-gpu', '--single-process', '--no-zygote'] : [])],
    executablePath: options.executablePath,
    timeout: options.timeoutMs,
    env: { ...process.env, DEBUG: '', PWDEBUG: '0', NODE_OPTIONS: '' },
  });
}

/** Called only in a killable child: a launch alone does not prove a renderer works. */
export async function probeIsolatedBrowser(options: BrowserOptions): Promise<boolean> {
  let browser: Browser | null = null;
  try {
    browser = await launchIsolatedBrowser(options);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
    const page = await context.newPage();
    await page.goto('about:blank', { timeout: options.timeoutMs ?? 5_000 });
    await context.close();
    return true;
  } catch { return false; }
  finally { await browser?.close().catch(() => {}); }
}
