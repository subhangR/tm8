/**
 * Account → Linked identities (BRIDGE-ENTITY-DESIGN §4.6, B3, migration 408):
 * `bridges.links.list` / `.begin` / `.revoke`.
 *
 * A linked number is a PROOF: the person at the phone sent a code they could
 * only have read on this screen. So the code is drawn once, from begin's own
 * answer, and never again: the list carries a live code's expiry, not its text
 * (D58). Reloading the page loses the code; minting a new one ends the old.
 *
 * While a code is showing, the list is re-read every few seconds, and the
 * panel closes itself the moment a new link arrives — "the row flips to
 * Linked the moment the runtime's message matches" (§4.6).
 *
 * Unlink takes two clicks, like a session revoke: the number's messages are a
 * guest's again at once, and only a new code undoes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeIdentityLink, BridgeLinkCode, BridgeLinksList, BridgeProvider } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import './linked-identities.css';

export interface LinkedIdentitiesSectionProps {
  heading: string;
  load?: () => Promise<BridgeLinksList>;
  begin?: (provider: BridgeProvider) => Promise<BridgeLinkCode>;
  revoke?: (linkId: string) => Promise<BridgeIdentityLink>;
  /** How often the list is re-read while a code is showing. Tests shorten it. */
  pollMs?: number;
  /** The clock, for the countdown. Tests pin it. */
  now?: () => number;
}

const PROVIDER_LABEL: Record<BridgeProvider, string> = {
  whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack', discord: 'Discord',
  instagram: 'Instagram', messenger: 'Messenger',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** '28 Oct' — the day a link was proved, locale-free. */
export function linkDay(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** '9:41' left, or null once expired. */
export function countdown(expiresAt: string, now: number): string | null {
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The trust word, as the People tab and bubbles say it (§4.4): linked ✓ or asserted, never both. */
export function linkStatus(link: BridgeIdentityLink): string {
  if (link.trust === 'asserted') return `Asserted by an admin of ${link.spaceName ?? 'a space'} · ${linkDay(link.verifiedAt)}`;
  return `Linked ✓ · verified ${linkDay(link.verifiedAt)}${link.method === 'invite' ? ' by invite' : ''}`;
}

export function LinkedIdentitiesSection({ heading, load, begin, revoke, pollMs = 4000, now = Date.now }: LinkedIdentitiesSectionProps) {
  const [list, setList] = useState<BridgeLinksList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<BridgeLinkCode | null>(null);
  const [codeLinks, setCodeLinks] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const live = useRef(true);

  const read = useCallback(async () => {
    if (!load) return null;
    const next = await load();
    if (live.current) { setList(next); setError(null); }
    return next;
  }, [load]);

  useEffect(() => {
    live.current = true;
    setList(null);
    setError(null);
    read().catch((err: unknown) => { if (live.current) setError(message(err)); });
    return () => { live.current = false; };
  }, [read]);

  // While a code shows: tick the countdown each second and re-read the list
  // every pollMs; a link that was not there when the code was minted closes it.
  useEffect(() => {
    if (!code) return;
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    const poll = setInterval(() => {
      read().then((next) => {
        if (next && next.items.some((l) => !codeLinks.has(l.id))) setCode(null);
      }, () => undefined);
    }, pollMs);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [code, codeLinks, pollMs, read]);

  const onBegin = async (provider: BridgeProvider) => {
    if (!begin) return;
    setBusy(true);
    setActionError(null);
    setCopied(false);
    try {
      const minted = await begin(provider);
      setCodeLinks(new Set((list?.items ?? []).map((l) => l.id)));
      setCode(minted);
      await read();
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (linkId: string) => {
    if (!revoke) return;
    setConfirming(null);
    setBusy(true);
    setActionError(null);
    try {
      await revoke(linkId);
      await read();
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`/link ${code.code}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!load) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Linked identities are not wired on this surface." why="this settings host passed no links reader" />
      </SectionFrame>
    );
  }
  if (error) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Your linked identities could not be read." why={error} />
      </SectionFrame>
    );
  }
  if (!list) {
    return (
      <SectionFrame title={heading}>
        <p className="set-links__note">Reading linked identities…</p>
      </SectionFrame>
    );
  }

  const left = code ? countdown(code.expiresAt, now()) : null;
  const pendingElsewhere = !code && list.pending.length > 0 ? list.pending[0]! : null;

  return (
    <SectionFrame
      title={heading}
      bodyTestId="linked-identities-body"
      action={begin ? (
        <button type="button" className="set-chip set-links__begin" data-testid="link-begin" disabled={busy}
          onClick={() => void onBegin('whatsapp')}>
          {code ? 'New code' : 'Link WhatsApp'}
        </button>
      ) : undefined}
    >
      <div className="set-links">
        <p className="set-links__lede">
          Numbers on WhatsApp and other networks that count as you. When a linked number writes in a group bridged
          to tm8, the message is yours, in your name, in every space you are in. Linking grants nothing you do not
          already have.
        </p>

        {code ? (
          <div className="set-links__code" role="region" aria-label={`Link your ${PROVIDER_LABEL[code.provider]}`} data-testid="link-code-panel">
            <span className="set-links__code-title">Link your {PROVIDER_LABEL[code.provider]}</span>
            <span className="set-links__code-how">
              Send this from your phone, in any {PROVIDER_LABEL[code.provider]} group connected to tm8:
            </span>
            <div className="set-links__code-row">
              <code className="set-links__code-text" data-testid="link-code">/link {code.code}</code>
              <button type="button" className="set-links__act" onClick={() => void onCopy()} data-testid="link-code-copy">
                {copied ? 'copied' : 'copy'}
              </button>
              <span className="set-links__code-left" data-testid="link-code-left">
                {left ? `expires in ${left}` : 'expired: make a new code'}
              </span>
            </div>
            <span className="set-links__code-how">
              When it arrives, your messages from that number count as you, here and in every space you are in.
              You can unlink any time. A message to the number itself is never read.
            </span>
            <span className="set-links__code-wait" aria-live="polite">◌ waiting for your message…</span>
            <div className="set-links__code-row">
              <button type="button" className="set-links__act set-links__act--quiet" onClick={() => setCode(null)}
                data-testid="link-code-close">
                close
              </button>
            </div>
          </div>
        ) : null}

        {pendingElsewhere ? (
          <p className="set-links__note" data-testid="link-pending">
            A {PROVIDER_LABEL[pendingElsewhere.provider]} code you made is live until{' '}
            {pendingElsewhere.expiresAt.slice(11, 16)} UTC. It was shown once, when you made it; make a new one to see a
            code (that ends the old one).
          </p>
        ) : null}

        {actionError ? <p className="set-links__error" role="alert" data-testid="link-error">{actionError}</p> : null}

        {list.items.length === 0 ? (
          <p className="set-links__note" data-testid="links-empty">
            No linked identities yet. Link WhatsApp to have your messages in bridged groups count as you.
          </p>
        ) : (
          <ul className="set-links__list">
            {list.items.map((link) => (
              <li key={link.id} className="set-links__row" data-testid={`link-row-${link.id}`}>
                <span className="set-links__provider">{PROVIDER_LABEL[link.provider]}</span>
                <span className="set-links__number">···· {link.masked.replace('…', '')}</span>
                <span className={`set-links__status set-links__status--${link.trust}`}>{linkStatus(link)}</span>
                {revoke ? (
                  confirming === link.id ? (
                    <span className="set-links__acts">
                      <button type="button" className="set-links__act set-links__act--quiet" onClick={() => setConfirming(null)}>
                        cancel
                      </button>
                      <button type="button" className="set-links__act set-links__act--danger" disabled={busy}
                        data-testid={`link-revoke-confirm-${link.id}`} onClick={() => void onRevoke(link.id)}>
                        confirm unlink
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="set-links__act" data-testid={`link-revoke-${link.id}`}
                      onClick={() => setConfirming(link.id)}>
                      unlink
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionFrame>
  );
}
