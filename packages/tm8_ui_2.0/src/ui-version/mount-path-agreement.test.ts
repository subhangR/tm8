/**
 * THE MOUNT PATH IS WRITTEN IN THREE FILES AND IMPORTED ACROSS NONE OF THEM.
 * This is the test that makes them agree.
 *
 * The duplication is structural, not laziness: the UI packages cannot import
 * from the server package, and this bundle bakes its asset URLs at build time
 * from vite's `base`. So the same string is authored three times —
 *
 *   · `packages/server/src/http/static.ts`  → UI_2_0_MOUNT_PATH  (no trailing /)
 *   · `packages/tm8-ui/src/ui-version/mount.ts` → UI_2_0_PATH    (trailing /)
 *   · `packages/tm8_ui_2.0/vite.config.ts`  → base               (trailing /)
 *
 * — and each file's comment tells you to change all three. Nothing checked it.
 *
 * WHY IT NEEDED A TEST OF ITS OWN. The switch's unit tests assert
 * `href === UI_2_0_PATH` and probe `${UI_2_0_PATH}index.html`, comparing the
 * constant against ITSELF: measured by mutating the constant to `/ui-9.9/`,
 * every one of those 8 tests still passed. They pin the control's behaviour and
 * say nothing about the value, so a drift in any one of the three files would
 * ship a switch that navigates to a 404 — with a green suite.
 *
 * It lives in THIS package because CI runs this package's vitest and not
 * `packages/tm8-ui`'s (tools/ci/check.sh, TEST_PACKAGES). It reads source text
 * rather than importing, for the same reason the duplication exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

/**
 * Pull a single-quoted string out of a DECLARATION, never out of prose.
 *
 * The pattern is line-anchored on purpose, and this is not fussiness: the first
 * cut of this helper matched the name anywhere in the file, and every one of
 * these files documents itself in a comment that quotes the very declaration
 * below it. `packages/tm8_ui_2.0/vite.config.ts` says ``base: '/ui-2.0/'`` in
 * its header essay twenty lines above the real `base:` line — so the helper
 * read the COMMENT, and mutating the actual config left this suite green.
 * Caught by mutating it; the fix is to require the line to BE the declaration.
 */
function declared(source: string, pattern: RegExp, what: string, file: string): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`${what} not found in ${file} — was it renamed?`);
  return match[1];
}

describe('the /ui-2.0 mount path agrees across all three files that hardcode it', () => {
  const serverMount = declared(
    read('packages/server/src/http/static.ts'),
    /^export const UI_2_0_MOUNT_PATH = '([^']+)';$/m,
    'UI_2_0_MOUNT_PATH',
    'packages/server/src/http/static.ts',
  );
  const switchPath = declared(
    read('packages/tm8-ui/src/ui-version/mount.ts'),
    /^export const UI_2_0_PATH = '([^']+)';$/m,
    'UI_2_0_PATH',
    'packages/tm8-ui/src/ui-version/mount.ts',
  );
  const viteBase = declared(
    read('packages/tm8_ui_2.0/vite.config.ts'),
    /^ {2}base: '([^']+)',$/m,
    'base',
    'packages/tm8_ui_2.0/vite.config.ts',
  );

  /* The literal, asserted once. Everything below is a relationship between the
     three files; this is the one place the actual value is pinned, so a
     deliberate rename has exactly one line to change here. */
  it('is /ui-2.0 where the server mounts it', () => {
    expect(serverMount).toBe('/ui-2.0');
  });

  it('is the same path the product UI sends viewers to', () => {
    // The control's href. Trailing slash, because it is a directory — and the
    // server maps the slashless form onto it, which is why only this side
    // carries one.
    expect(switchPath).toBe(`${serverMount}/`);
  });

  it('is the base this bundle bakes into every asset URL', () => {
    // A base that disagreed with the mount would 404 every asset while
    // index.html still answered 200: a white screen, not an error.
    expect(viteBase).toBe(`${serverMount}/`);
  });

  it('is excluded from the product UI service worker, exactly as written', () => {
    // The worker holds root scope and must not answer for a bundle it did not
    // build. It hardcodes the path a FOURTH time, in a file the three comments
    // above do not name.
    const worker = read('packages/tm8-ui/src/pwa/service-worker.js');
    expect(worker).toContain(`url.pathname === '${serverMount}'`);
    expect(worker).toContain(`url.pathname.startsWith('${serverMount}/')`);
  });

  it('is what an operator points TM8_UI_2_0_DIR at, per the prod env', () => {
    // The env name and the outDir it must name — the pair that decides whether
    // the mount exists at all. `dist-2.0`, never `dist`: the interlock.
    const env = read('deploy/prod/env.sh');
    expect(env).toContain('export TM8_UI_2_0_DIR=');
    expect(env).toContain('packages/tm8_ui_2.0/dist-2.0');
    expect(read('packages/tm8_ui_2.0/vite.config.ts')).toContain("outDir: 'dist-2.0'");
  });
});
