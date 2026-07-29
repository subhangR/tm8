/**
 * WHICH SEAM THE APP CONSTRUCTS — and, since 2026-07-29, the answer in a
 * browser is THE REAL ONE unless somebody says otherwise.
 *
 * === WHAT CHANGED AND WHY (USER RULING, first priority) ===
 *
 * This gate used to be OFF by default: an un-opted session constructed
 * `createFixtureSeam()`, so a fresh load of the app showed FIXTURE entities —
 * invented tasks, invented sessions — rendered in exactly the chrome that real
 * ones would use. Nothing on the screen said so. That is the honesty defect
 * the whole program exists to remove, and it was the default state of the app.
 *
 * So the default inverted. The rules, in the order they are applied:
 *
 *   1. an explicit `'1'` → REAL.
 *   2. an explicit `'0'` → FIXTURE. This is the explicit demo/test composition:
 *      safe**: a default with no off switch is a trap. This is how the launch
 *      sheet's pickers, a demo, or anyone debugging without a node gets the
 *      fixture world back — `localStorage.setItem('tm8-ui:real-seam','0')`.
 *   3. `MODE === 'test'` → FIXTURE. Not a convenience: vitest runs with no
 *      node and no network, so a real default there would make every suite
 *      measure the ENVIRONMENT rather than the code, and 1000 tests would go
 *      red saying nothing about the change that broke them. The browser
 *      default is therefore asserted against `resolveSeamSource` directly with
 *      an injected env (`seamSource.test.ts`) rather than being untestable.
 *      NOTE that `realSeamFlag.test.ts`'s "is OFF by default" case now
 *      measures THIS rule and not the app's default — it is still true, and it
 *      no longer means what its name suggests.
 *   4. otherwise, including production → REAL.
 *
 * WHAT THE DEFAULT DOES **NOT** DO: fall back. If the node is unreachable the
 * boot read rejects, `useGateData` holds the failure in `bootError`, and the
 * shell must render that. It never quietly re-constructs the fixture seam —
 * silently serving invented data in place of a node that is down is the same
 * lie in a more expensive costume.
 *
 * The flag value is read from either source, in this order:
 *   - `VITE_TM8_REAL_SEAM` at `vite dev` launch;
 *   - `localStorage.getItem('tm8-ui:real-seam')` from the browser console, so
 *     verification can flip it without restarting vite.
 *
 * === WHY `MODE`, NOT `DEV` ===
 *
 * Copied deliberately from Track P's `src/terminal/liveTerminalFlag.ts`, which
 * is the authority for this gate and which I have read rather than paraphrased
 * (P's file, cited not edited — src/terminal/ is its carve-out).
 *
 * P4 measured the served module on the running :4612 instance and found
 * `import.meta.env` reporting `DEV:false, PROD:true` alongside
 * `MODE:'development'` — an inconsistent combination `vite dev`/`vite build`
 * never produces, but real on that process (root-caused to an inherited
 * `NODE_ENV=production`). A `.DEV` check silently killed P's flag there even
 * with both opt-ins set. `MODE` was the one field still reporting correctly.
 * Using `DEV` here would reproduce that failure exactly: the flag would read
 * false on the very instance this exists to be verified on, and it would fail
 * SILENTLY — indistinguishable from "nobody opted in".
 *
 * NOT A PURE EQUIVALENCE, stated with its counterweight rather than as a bare
 * caveat: `MODE !== 'production'` is strictly LOOSER than `DEV`. A
 * `--mode staging` build has `DEV === false` while `MODE !== 'production'`, so
 * this gate admits a case a `DEV` check would refuse. What makes that
 * acceptable is that it is the FIRST of two gates: the function still requires
 * an explicit `VITE_TM8_REAL_SEAM=1` at build time or a deliberate
 * `localStorage` write in that specific browser. A staging build sets neither,
 * so the loosening only reaches someone who has already opted in by hand.
 *
 * If P's forward pointer lands — tightening to require MODE and a corrected
 * DEV in agreement, once the :4612 env defect is verified fixed — this file
 * should follow it in the same change rather than drift apart from the
 * pattern it was copied from.
 */
export type SeamSource = 'real' | 'fixture';

/** The `import.meta.env` fields this gate reads — injectable, so the browser
    default is assertable from a test process that is not a browser. */
export interface SeamEnv {
  MODE?: string;
  VITE_TM8_REAL_SEAM?: string;
}

export const REAL_SEAM_STORAGE_KEY = 'tm8-ui:real-seam';

/**
 * THE PURE RESOLVER. Everything decidable about the choice lives here, taking
 * its two inputs as arguments, because the one thing the old flag could not
 * prove about itself was its own default: `isRealSeamEnabled()` reads the
 * ambient MODE, and under vitest that MODE is 'test' forever. A test could
 * assert the test-environment answer and nothing else, which is precisely the
 * shape of a green that measures the runner instead of the rule.
 */
export function resolveSeamSource(env: SeamEnv, flag: string | null): SeamSource {
  if (flag === '1') return 'real';
  if (flag === '0') return 'fixture';
  if (env.MODE === 'test') return 'fixture';
  return 'real';
}

/**
 * The flag VALUE from either source, or null when nobody set one.
 *
 * THE `typeof` CHECK IS INSIDE THE TRY DELIBERATELY.
 *
 * Storage can be a THROWING GETTER, not merely absent — some blocked origins
 * and privacy modes define the property so that touching it raises. `typeof
 * localStorage` is itself a property ACCESS, so a guard placed before the try
 * throws past it and takes down the one call site that constructs the app's
 * only seam. A test asserting the flag survives a throwing storage is what
 * found this; the guard read as defensive and was not, because it evaluated
 * the very expression it was guarding.
 *
 * NOTE FOR TRACK P: the same ordering is in
 * `src/terminal/liveTerminalFlag.ts`, which this file was copied from. I have
 * not edited it (P's carve-out) — flagged rather than fixed.
 */
export function readSeamFlag(env: SeamEnv): string | null {
  if (env.VITE_TM8_REAL_SEAM != null && env.VITE_TM8_REAL_SEAM !== '') {
    return env.VITE_TM8_REAL_SEAM;
  }
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(REAL_SEAM_STORAGE_KEY);
  } catch {
    // A flag that cannot be read is not set — and the default applies, which
    // is now REAL. A storage failure must not silently demote the app to
    // fixtures; that would be the fall-back this file exists to forbid.
    return null;
  }
}

/** The one call site is `useGateData`. */
export function seamSource(): SeamSource {
  const env = import.meta.env as unknown as SeamEnv;
  return resolveSeamSource(env, readSeamFlag(env));
}

/** Kept as the historical name; `seamSource()` is the one that says what it
    means, and both answer the same question. */
export function isRealSeamEnabled(): boolean {
  return seamSource() === 'real';
}
