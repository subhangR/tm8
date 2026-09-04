import { useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { MenuTarget } from '../shell';
import { routeViewOf } from '../domain/nav-targets';
import { build, normalize } from '../routes/codec';
import { emptyPanels } from '../routes/types';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import './copy-link.css';

export type CopyLinkCopier = (url: string) => void | Promise<void>;

export interface CopyLinkControlProps {
  spaceId: SpaceId;
  target: MenuTarget;
  /** The detail currently open on a kind screen, when there is one. */
  openEntity?: EntityId | null;
  /** Host clipboard bridge. It takes precedence over the browser clipboard. */
  onCopy?: CopyLinkCopier;
  /** Test/host seam. Production defaults to the current app origin and path. */
  appBaseUrl?: string;
  label?: string;
  /**
   * Host chrome for the control's root element, so a host can dress it in its
   * own row grammar (the account menu passes `auth-menu__row`) without this
   * component learning that host's classes.
   */
  className?: string;
  /**
   * Hover/description text. Defaults to `SPACE_LINK_HINT`; a host with a
   * narrower truth to tell may override it, but it must still say what the
   * link exposes.
   */
  hint?: string;
}

/**
 * WHAT THE HOVER SAYS, and why these words.
 *
 * User-ordered (2026-08-31): "when they hover over copy link give information
 * that they are sharing the space". Before this the control had NO title at
 * all — the only thing a person could learn by hovering was the word "Copy
 * link", which describes the clipboard and not the consequence. Someone
 * copying a link to a task they were reading had no way to know the address
 * names the whole space around it.
 *
 * The wording is held to four rules:
 *   1. NAME THE SPACE, not the screen. That is the owner's whole point: the
 *      thing being handed over is a way in, not a page.
 *   2. SAY WHAT THE RECIPIENT SEES, concretely — "conversations, people and
 *      work" — because "shares this space" alone leaves a reader guessing
 *      whether that means one page or everything.
 *   3. STAY TRUE. A link is not a grant: ruling R1=(a) is that recipients are
 *      already members, and nothing in this codec authorizes anybody. Copy
 *      that promised access the link cannot give would be a lie in the one
 *      place a person is deciding who to trust. Hence "once they sign in with
 *      an account that is already in this space".
 *   4. CUSTOMER LANGUAGE. No "entity", no "target", no "route" or "codec" —
 *      the reader is a person deciding whether to paste this into a chat.
 */
export const SPACE_LINK_HINT =
  'Copies a link to this space, opened at this page. Anyone you send it to lands exactly here and can see this space — its conversations, people and work — once they sign in with an account that is already in this space. Share it only with people you want inside.';

/**
 * Build the share URL from the route authorities, with deliberately empty
 * panel state. A shared link names the space and destination, not the sender's
 * open/pinned panel arrangement.
 *
 * M2 — server identity: the link names the origin that served the viewer.
 * Space links are meaningful only on that node, and the route grammar has no
 * node segment yet, so guessing another configured server would create a link
 * whose authority and destination disagree. Links are intentionally not
 * portable between nodes until the route contract gains node identity.
 */
export function copyLinkUrl({
  spaceId,
  target,
  openEntity = null,
  appBaseUrl = currentAppBaseUrl(),
}: Pick<CopyLinkControlProps, 'spaceId' | 'target' | 'openEntity' | 'appBaseUrl'>): string | null {
  const routeTarget = routeViewOf(target, openEntity);
  if (!routeTarget || !appBaseUrl) return null;

  const outcome = build(
    normalize({
      spaceId,
      target: routeTarget,
      panels: emptyPanels(),
    }),
  );
  return new URL(outcome.hash, appBaseUrl).toString();
}

/**
 * Reusable header affordance for entity panels, kind screens, and channels.
 * Its refusal ladder matches GovernedBody's copy-path control: injected host
 * copier, then navigator.clipboard, then an honest manual-copy fallback.
 */
export function CopyLinkControl({
  spaceId,
  target,
  openEntity = null,
  onCopy,
  appBaseUrl,
  label = 'Copy link',
  className,
  hint = SPACE_LINK_HINT,
}: CopyLinkControlProps) {
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const url = copyLinkUrl({ spaceId, target, openEntity, ...(appBaseUrl ? { appBaseUrl } : {}) });

  if (!url) {
    const refused = (
      <DisabledAction
        label={label}
        reason={{
          cause: 'This destination has no shareable route',
          remedy: 'the route registry does not address this screen',
        }}
      >
        <span className="copy-link__glyph" aria-hidden>
          ↗
        </span>{' '}
        {label}
      </DisabledAction>
    );
    /* No `hint` on this branch: there is no link, so there is nothing being
       shared to describe. The refusal's own reason is the true thing to say. */
    return className ? <span className={className}>{refused}</span> : refused;
  }

  const clipboard =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
      ? navigator.clipboard
      : null;
  const hasCopier = Boolean(onCopy || clipboard);

  if (!hasCopier || manualCopy) {
    return (
      <label
        className={`copy-link copy-link--manual${className ? ` ${className}` : ''}`}
        title={hint}
      >
        <span className="copy-link__instruction">Clipboard unavailable — copy this link manually</span>
        <input
          className="copy-link__field"
          aria-label="Share link"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
    );
  }

  return (
    <button
      type="button"
      className={`copy-link copy-link__button${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={hint}
      onClick={async () => {
        setCopied(false);

        try {
          if (onCopy) {
            await onCopy(url);
            setCopied(true);
            return;
          }
        } catch {
          // A rejecting host bridge is not proof that the platform clipboard
          // is unavailable; continue down the refusal ladder.
        }

        try {
          if (clipboard) {
            await clipboard.writeText(url);
            setCopied(true);
            return;
          }
        } catch {
          // A clipboard can be structurally present but reject at runtime
          // (notably outside a secure context). Never report that as copied.
        }

        setManualCopy(true);
      }}
    >
      <span className="copy-link__glyph" aria-hidden>
        ↗
      </span>
      <span>{copied ? 'Copied' : label}</span>
      <span className="copy-link__status" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </button>
  );
}

function currentAppBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}`;
}
