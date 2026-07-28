/**
 * THE REAL-SEAM DEV FLAG.
 *
 * `createRealSeam` is complete and the fixture seam is what the shell has
 * always constructed. Flipping that unconditionally would point every consumer
 * at a live node before the click path has been walked end to end, so the
 * choice is opt-in, read at ONE place (`useGateData`), and OFF by default —
 * `createFixtureSeam()` remains exactly what an un-opted session gets.
 *
 * Two ways to opt in, both gated on non-production:
 *   - `VITE_TM8_REAL_SEAM=1` at `vite dev` launch;
 *   - `localStorage.setItem('tm8-ui:real-seam', '1')` from the browser console,
 *     so verification can flip it without restarting vite.
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
export function isRealSeamEnabled(): boolean {
  if (import.meta.env.MODE === 'production') return false;
  if (import.meta.env.VITE_TM8_REAL_SEAM === '1') return true;
  try {
    // THE `typeof` CHECK IS INSIDE THE TRY DELIBERATELY.
    //
    // Storage can be a THROWING GETTER, not merely absent — some blocked
    // origins and privacy modes define the property so that touching it raises.
    // `typeof localStorage` is itself a property ACCESS, so a guard placed
    // before the try throws past it and takes down the one call site that
    // constructs the app's only seam. A test asserting the flag survives a
    // throwing storage is what found this; the guard read as defensive and was
    // not, because it evaluated the very expression it was guarding.
    //
    // NOTE FOR TRACK P: the same ordering is in
    // `src/terminal/liveTerminalFlag.ts`, which this file was copied from. I
    // have not edited it (P's carve-out) — flagged rather than fixed.
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('tm8-ui:real-seam') === '1';
  } catch {
    // A flag that cannot be read is not set.
    return false;
  }
}
