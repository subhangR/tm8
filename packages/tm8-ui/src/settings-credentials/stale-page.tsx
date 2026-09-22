/**
 * THE ONE SENTENCE THIS SCREEN SAYS WHEN THE NODE IS AHEAD OF THE PAGE.
 *
 * Two surfaces need it in two different chromes — the Connections panel's
 * notice and the setup dialog's — so the WORDS live here and each surface
 * wraps them in its own markup. A second copy of the sentence would be a
 * second place for it to stop matching the first.
 *
 * WHY THIS WORDING. The reader does not have a credentials problem: every
 * login they hold is intact, and nothing they can do to a provider will help.
 * What is behind is the page in front of them. So the sentence names the page
 * as the thing that is out of date, and the remedy is the one that actually
 * fixes it.
 *
 * "TOO OLD TO SHOW", NOT "OPENED BEFORE". The obvious phrasing — this page was
 * open before the connection arrived — is a claim about WHEN they opened the
 * tab, and it is false half the time. tm8 ships as a PWA whose service worker
 * precaches one bundle, so a tab opened MINUTES AFTER the upgrade can still be
 * running the old code out of that cache. "Too old" is true in both cases and
 * asks the reader to remember nothing about their own morning.
 *
 * IT NEVER PRINTS THE PROVIDER IDS IT IS TALKING ABOUT. An id is what this
 * build holds INSTEAD of a name, and showing one would answer "which ones?"
 * with a piece of plumbing.
 */

export const STALE_PAGE_HEAD = 'This page is out of date.';

export function stalePageWhy(unrecognised: number): string {
  const they = unrecognised === 1 ? 'a connection' : `${unrecognised} connections`;
  const them = unrecognised === 1 ? 'it' : 'them';
  return `Your workspace has ${they} this page is too old to show. Reload to see ${them} — nothing you have already connected is affected.`;
}

/**
 * The Connections panel's chrome for it. The setup dialog renders the same two
 * strings in `cset-notice` instead, because its notices are laid out by a
 * different stylesheet.
 */
export function StalePageNotice({ unrecognised }: { unrecognised: number }) {
  if (unrecognised <= 0) return null;

  return (
    <div className="cred-notice" data-testid="credentials-stale-page">
      <span className="cred-notice__head">{STALE_PAGE_HEAD}</span>
      <span className="cred-notice__why cred-notice__why--prose">{stalePageWhy(unrecognised)}</span>
      <button
        type="button"
        className="cred-action"
        onClick={() => window.location.reload()}
        data-testid="credentials-stale-page-reload"
      >
        Reload
      </button>
    </div>
  );
}
