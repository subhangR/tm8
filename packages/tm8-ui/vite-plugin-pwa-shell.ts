import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Emits `sw.js` with a precache list of the REAL hashed build filenames.
 *
 * WHY THIS EXISTS RATHER THAN `vite-plugin-pwa`. Two reasons, both specific to
 * this repo:
 *
 *  1. The precache list here is a deliberate, reviewable decision — the shell
 *     and nothing else — not a glob. `dist/` is ~6.9MB across 69 chunks, most
 *     of it lazy diagram renderers, and the difference between "precache the
 *     shell" and "precache `**' + '/*.js`" is 2.7MB versus 6.9MB pulled on
 *     install over a phone connection. Workbox can be configured to do the
 *     right thing, but the wrong thing is its default and one careless glob
 *     edit re-enables it silently.
 *  2. `src/pwa/service-worker.js` carries a ruling — /v2 is never cached —
 *     that has to stay legible to a reviewer. A generated worker with an
 *     injected manifest, rather than a hand-written one, is where that ruling
 *     would go to die. Keeping the worker as ordinary readable source and only
 *     substituting two constants keeps it auditable.
 *
 * It also avoids adding workbox-build to a `node_modules` this worktree shares
 * with other lanes.
 *
 * The worker is emitted at the dist ROOT, which gives it root scope with no
 * `Service-Worker-Allowed` header — deliberate, because prod is served by
 * `vite preview` and there is nowhere in the repo to set response headers.
 */

const WORKER_SOURCE = 'src/pwa/service-worker.js';

export interface PwaShellOptions {
  /**
   * Files copied verbatim from `public/` that the shell should also survive
   * without a network. Paths are site-absolute.
   */
  optional?: string[];
}

export function pwaShell(options: PwaShellOptions = {}): Plugin {
  let outDir = 'dist';
  let root = process.cwd();

  return {
    name: 'tm8:pwa-shell',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },

    generateBundle(_options, bundle) {
      const critical = new Set<string>(['/index.html']);

      for (const [fileName, chunk] of Object.entries(bundle)) {
        // The entry chunk and the single stylesheet it pulls in: the exact set
        // the browser needs before it can paint anything at all. Every other
        // chunk in here is behind a dynamic import and is runtime-cached.
        if (chunk.type === 'chunk' && chunk.isEntry) critical.add(`/${fileName}`);
        if (chunk.type === 'asset' && fileName.endsWith('.css')) critical.add(`/${fileName}`);
      }

      const shell = {
        critical: [...critical],
        optional: options.optional ?? [],
      };

      // The build id is derived from the precached filenames, which are
      // content-hashed. Same build -> same cache name -> no needless re-install
      // for users; changed build -> new cache -> old one dropped on activate.
      const build = createHash('sha256')
        .update(shell.critical.join('\n'))
        .digest('hex')
        .slice(0, 12);

      const source = readFileSync(resolve(root, WORKER_SOURCE), 'utf8')
        .replace('self.__TM8_SHELL__', JSON.stringify(shell))
        .replace('self.__TM8_BUILD__', JSON.stringify(build));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });

      (this as unknown as { __tm8Shell?: typeof shell }).__tm8Shell = shell;
      lastShell = shell;
    },

    /**
     * Report the precache payload as a number. This lane's whole hazard is that
     * the precache quietly grows back into "the entire build", and a size
     * printed on every build is what makes that visible the day it happens
     * rather than the day someone installs over cellular.
     */
    closeBundle() {
      if (!lastShell) return;
      const dist = resolve(root, outDir);
      let critical = 0;
      let optional = 0;
      const missing: string[] = [];
      const size = (p: string) => {
        try {
          return statSync(resolve(dist, p.replace(/^\//, ''))).size;
        } catch {
          missing.push(p);
          return 0;
        }
      };
      for (const p of lastShell.critical) critical += size(p);
      for (const p of lastShell.optional) optional += size(p);

      const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
      // eslint-disable-next-line no-console
      console.log(
        `\n  precache (sw.js): ${kb(critical + optional)}`
        + `  =  shell ${kb(critical)} (${lastShell.critical.length} files)`
        + ` + ${kb(optional)} (${lastShell.optional.length} files)`
        + (missing.length ? `\n  MISSING FROM dist: ${missing.join(', ')}` : ''),
      );
      lastShell = null;
    },
  };
}

let lastShell: { critical: string[]; optional: string[] } | null = null;
