import { useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { MenuTarget } from '../shell';
import { routeViewOf } from '../domain/nav-targets';
import { build, normalize } from '../routes/codec';
import { emptyPanels } from '../routes/types';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import './copy-link.css';

export type CopyLinkCopier = (url: string) => void;

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
}

/**
 * Build the share URL from the route authorities, with deliberately empty
 * panel state. A shared link names the space and destination, not the sender's
 * open/pinned panel arrangement.
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
}: CopyLinkControlProps) {
  const [copied, setCopied] = useState(false);
  const url = copyLinkUrl({ spaceId, target, openEntity, ...(appBaseUrl ? { appBaseUrl } : {}) });

  if (!url) {
    return (
      <DisabledAction
        label={label}
        reason={{
          cause: 'This destination has no shareable route',
          remedy: 'the route registry does not address this screen',
        }}
      >
        <span aria-hidden>↗</span> {label}
      </DisabledAction>
    );
  }

  const clipboard =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
      ? navigator.clipboard
      : null;
  const copier = onCopy ?? (clipboard ? (value: string) => void clipboard.writeText(value) : null);

  if (!copier) {
    return (
      <label className="copy-link copy-link--manual">
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
      className="copy-link copy-link__button"
      aria-label={label}
      onClick={() => {
        copier(url);
        setCopied(true);
      }}
    >
      <span aria-hidden>↗</span>
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
