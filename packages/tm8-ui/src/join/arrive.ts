/**
 * ARRIVAL — landing in the Space a join just produced, as a real page load.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (task 01a0baf5, "Invite Link is not working").
 * `GateApp` ended a successful redemption with
 *
 *     location.assign(`/#/s/${spaceId}`)
 *
 * under a comment insisting it was "A FULL RELOAD, not a state flip". It was
 * not one. `capturePendingJoin` has already rewritten the address to `/` by
 * then — deliberately, so the code stops riding in the URL — so that call
 * changes ONLY the fragment, and a fragment navigation does not reload the
 * document. Measured in a real browser against the deployed node: a marker set
 * on `window` before the call was still there afterwards, with the new hash in
 * the address bar.
 *
 * WHAT THE PERSON SAW. No reload means `joinCode` was never re-derived, and
 * `GateApp` renders `JoinScreen` ahead of the workspace whenever a code is
 * held. The phase was still `joining`, so the button stayed disabled reading
 * "Joining…" — forever, over a membership that had already committed. The
 * reporter's row was written at 18:22:56 and the bug was filed at 18:39: the
 * join worked and the screen never said so, so they opened the link again to
 * find out why, and THAT second open is what produced the "This invite is used
 * up" card in the report. One missing load, two wrong screens.
 *
 * WHY A LOAD AND NOT A STATE FLIP. Membership is an INPUT to boot. The spaces
 * list, the menu, the counters and the socket subscription were all resolved
 * for an account that was not in this Space, and there is no partial-refresh
 * path that re-derives them. This happens once per invite and never on a hot
 * path, so the blunt instrument is the right one — it just has to actually
 * fire.
 *
 * WHY THE SEAM. The two calls below are the only browser APIs involved and
 * both are untestable in jsdom (`location.reload` is unimplemented there and
 * logs a "Not implemented" error rather than doing anything). Injecting them
 * lets `join.test.tsx` assert the RULE — set the address, then load it, in
 * that order — which is the part that was wrong.
 */

/** The address of a Space in this app's hash router. */
export function spaceAddress(spaceId: string): string {
  return `/#/s/${spaceId}`;
}

/** The two browser calls arrival needs, named so a test can watch them. */
export interface ArrivalPort {
  /** Put the Space's address in the bar WITHOUT navigating. */
  setAddress(url: string): void;
  /** Load whatever the bar now says. */
  load(): void;
}

/**
 * The real browser.
 *
 * `history.replaceState` rather than `location.assign`, and then a reload:
 * `reload()` re-fetches the document's CURRENT url, which `replaceState` has
 * just changed, so the pair is one load at the right address instead of a
 * fragment hop at the right address and no load at all. `replaceState` and not
 * `pushState` for the same reason `capturePendingJoin` uses it — the join
 * screen is not somewhere Back should return to.
 *
 * A sandboxed frame can refuse `replaceState`. `location.assign` still gets the
 * address right there, and the `load()` below is what makes it a load either
 * way.
 */
export function browserArrival(): ArrivalPort {
  return {
    setAddress(url) {
      try {
        history.replaceState(null, '', url);
      } catch {
        location.assign(url);
      }
    },
    load() {
      location.reload();
    },
  };
}

/**
 * Land in `spaceId`. Address first, then the load — the order is the fix.
 */
export function arriveInSpace(spaceId: string, port: ArrivalPort = browserArrival()): void {
  port.setAddress(spaceAddress(spaceId));
  port.load();
}
