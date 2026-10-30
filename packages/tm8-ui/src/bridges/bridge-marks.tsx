/**
 * BRIDGED MESSAGES, wherever they render (BRIDGE-ENTITY-DESIGN §4.5, D4, D64).
 *
 * Three small pieces every surface that draws a message shares — the chat
 * transcript, the channel and session feeds, and the bridge panel:
 *
 *   · `BridgeProviderMark` — the provider's mark, a bundled text glyph in a
 *     tile (the `mcp/connector-logos.tsx` rule: no `<img>`, no URL, an
 *     unknown provider falls back);
 *   · `BridgeVia` — *via WhatsApp* with the sender's trust word on an
 *     inbound bubble;
 *   · `BridgeDeliveryTick` — the outbox ledger's state under an outbound one.
 *
 * Status is colour AND word, never colour alone (tokens.css). The ledger
 * has no `delivered` or `read`: the runtime protocol carries no receipts
 * (D64), so the tick never claims more than `sent`.
 */
import type {
  BridgeDelivery,
  BridgeRefusalReason,
  BridgeProvider,
  BridgeTrust,
  MessageBridgeView,
} from '@tm8/contract';
import { Timestamp } from '../kit';
import './bridges.css';

const PROVIDER_LABEL = new Map<string, string>([
  ['whatsapp', 'WhatsApp'],
  ['telegram', 'Telegram'],
  ['slack', 'Slack'],
  ['discord', 'Discord'],
  ['instagram', 'Instagram'],
  ['messenger', 'Messenger'],
]);

/** A `Map`, so an inherited key never resolves (connector-logos.tsx, S27). */
const PROVIDER_GLYPH = new Map<string, string>([
  ['whatsapp', '◍'],
  ['telegram', '➤'],
  ['slack', '#'],
  ['discord', '◈'],
  ['instagram', '◎'],
  ['messenger', '◉'],
]);

export const GENERIC_PROVIDER_GLYPH = '⌒';

export function bridgeProviderLabel(provider: BridgeProvider | string): string {
  return PROVIDER_LABEL.get(provider) ?? 'another network';
}

export function BridgeProviderMark({ provider, className }: { provider: BridgeProvider | string; className?: string }) {
  return (
    <span
      className={['bridge-mark', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-provider={PROVIDER_LABEL.has(provider) ? provider : 'generic'}
    >
      {PROVIDER_GLYPH.get(provider) ?? GENERIC_PROVIDER_GLYPH}
    </span>
  );
}

const TRUST_WORD: Record<BridgeTrust, string> = {
  linked: 'linked ✓',
  asserted: 'asserted',
  guest: 'guest',
};

const TRUST_TITLE: Record<BridgeTrust, string> = {
  linked: 'Their number is linked to their tm8 account',
  asserted: 'A space admin said who this is; not verified from their phone',
  guest: 'Not linked to anyone in tm8; posted by the bridge with their name',
};

/** *◍ via WhatsApp · guest* — the byline mark of a bubble that crossed in. */
export function BridgeVia({ bridge, onOpen }: { bridge: MessageBridgeView; onOpen?: (id: string) => void }) {
  const provider = bridgeProviderLabel(bridge.provider);
  const where = bridge.conversation ? `${provider} · ${bridge.conversation}` : provider;
  const via = (
    <>
      <BridgeProviderMark provider={bridge.provider} />
      <span>via {provider}</span>
    </>
  );
  return (
    <span className="bridge-via" data-testid="bridge-via" data-direction={bridge.direction}>
      {onOpen ? (
        <button
          type="button"
          className="bridge-via__open"
          title={`Open the bridge: ${where}`}
          aria-label={`Open the bridge: ${where}`}
          onClick={() => onOpen(bridge.bridgeId)}
        >
          {via}
        </button>
      ) : <span className="bridge-via__open" title={where}>{via}</span>}
      {bridge.trust ? (
        <span
          className="bridge-via__trust"
          data-trust={bridge.trust}
          title={TRUST_TITLE[bridge.trust]}
        >
          {TRUST_WORD[bridge.trust]}
        </span>
      ) : null}
    </span>
  );
}

type TickTone = 'run' | 'wait' | 'block' | 'idle';

export interface BridgeDeliveryWords {
  tone: TickTone;
  glyph: string;
  /** The visible word(s): *sent to WhatsApp*, *failed: too long*. */
  label: string;
  /** The longer form for the title. */
  title: string;
  /** Show the time beside the word. */
  timed: boolean;
}

const REFUSAL_WORDS: Record<BridgeRefusalReason, string> = {
  bridge_paused: 'bridge paused',
  bridge_ended: 'bridge removed',
  direction_in: 'bridge is read-only',
  worker_posting_off: 'worker posting is off',
  rate_limited: 'rate limited',
  not_connected: 'conversation not connected',
  credential_text: 'looks like a secret',
};

function retryIn(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 60 ? ` · retry in ${s}s` : ` · retry in ${Math.ceil(s / 60)}m`;
}

/** The words for one delivery badge. Pure, so the CLI's words and the UI's can be held equal in a test. */
export function bridgeDeliveryWords(delivery: BridgeDelivery, provider: BridgeProvider | string): BridgeDeliveryWords {
  const to = bridgeProviderLabel(provider);
  switch (delivery.status) {
    case 'sent':
      return { tone: 'run', glyph: '✓', label: `sent to ${to}`, title: `Sent to ${to}`, timed: true };
    case 'pending':
      return { tone: 'wait', glyph: '◷', label: 'queued', title: `Queued for ${to}; it goes out when the connection is up`, timed: false };
    case 'failed_retryable':
      return {
        tone: 'wait', glyph: '↻', label: 'retrying',
        title: `${to} did not take it yet${delivery.detail ? `: ${delivery.detail}` : ''}; tm8 retries on its own`,
        timed: false,
      };
    case 'failed_permanent':
      return {
        tone: 'block', glyph: '!', label: `failed${delivery.detail ? `: ${delivery.detail}` : ''}`,
        title: `Not sent to ${to}${delivery.detail ? `: ${delivery.detail}` : ''}. The message stays here.`,
        timed: true,
      };
    case 'refused': {
      const why = delivery.reason ? REFUSAL_WORDS[delivery.reason] : 'refused';
      return {
        tone: delivery.reason === 'rate_limited' ? 'wait' : 'idle', glyph: '⊘',
        label: `not sent: ${why}${delivery.reason === 'rate_limited' ? retryIn(delivery.retryAfterMs) : ''}`,
        title: `Kept in tm8, not sent to ${to}: ${why}`,
        timed: false,
      };
    }
  }
}

/** The tick under an outbound bridged message (§4.5): *✓ sent to WhatsApp · 2m*. */
export function BridgeDeliveryTick({ delivery, provider }: { delivery: BridgeDelivery; provider: BridgeProvider | string }) {
  const w = bridgeDeliveryWords(delivery, provider);
  return (
    <p
      className="bridge-tick"
      data-testid="bridge-tick"
      data-status={delivery.status}
      data-tone={w.tone}
      title={w.title}
    >
      <BridgeProviderMark provider={provider} />
      <span className="bridge-tick__glyph" aria-hidden="true">{w.glyph}</span>
      <span className="bridge-tick__word">{w.label}</span>
      {w.timed ? <Timestamp at={delivery.at} className="bridge-tick__at" /> : null}
    </p>
  );
}

/**
 * *◍ Bridged from WhatsApp · Infra* — the chat, session or channel header
 * chip (§4.5). Opens the bridge; the bridge's status rides as a word when it
 * is anything but live.
 */
export function BridgedFromChip({
  bridged,
  onOpen,
}: {
  bridged: { bridgeId: string; provider: BridgeProvider | string; conversation: string; status: string };
  onOpen?: ((id: string) => void) | undefined;
}) {
  const label = `Bridged from ${bridgeProviderLabel(bridged.provider)} · ${bridged.conversation}`;
  const body = (
    <>
      <BridgeProviderMark provider={bridged.provider} />
      <span>{label}</span>
      {bridged.status !== 'live' ? <span className="bridged-from__status" data-status={bridged.status}>{bridged.status}</span> : null}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="bridged-from"
      data-testid="bridged-from"
      aria-label={`${label}: open the bridge`}
      onClick={() => onOpen(bridged.bridgeId)}
    >
      {body}
    </button>
  ) : <span className="bridged-from" data-testid="bridged-from">{body}</span>;
}
