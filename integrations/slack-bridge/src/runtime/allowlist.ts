// Connected channels only (D28): the allowlist the server pushes per connection, the inbound drop, and the outbound
// guard. This is the runtime's half of the two independent checks; the server checks again on its side.
import type { AllowlistFrame, CannotSendReason, DropCounters } from './protocol.js'

export type OutboundKind = 'text' | 'media' | 'reaction' | 'media.fetch'

/** The frames that post into the channel; a channel the bot left or that was archived refuses these. */
const POSTS: ReadonlySet<OutboundKind> = new Set(['text', 'media', 'reaction'])

/** A Slack channel id: public `C…`, private `G…` (older private channels). DMs (`D…`) are never connectable. */
export const CHANNEL_ID = /^[CG][A-Z0-9]+$/

export class OutboundRefused extends Error {
  constructor(public reason: 'not_connected' | CannotSendReason, conversationId: string, kind: OutboundKind) {
    super(`refusing ${kind} to ${conversationId}: ${reason === 'not_connected' ? 'not a connected conversation' : reason}`)
  }
}

const emptyCounters = (): DropCounters => ({ stanzas: 0, messages: 0, outboundRefused: 0 })

/** One connection's allowlist. Before the first list arrives it allows nothing. */
export class Allowlist {
  private ids = new Set<string>()
  private cannotSend = new Map<string, CannotSendReason>()
  version: number | null = null
  /**
   * `stanzas`: Socket Mode envelopes from unconnected channels acked and dropped (channel events and the rest).
   * `messages`: messages, reactions and slash commands from unconnected channels, dropped on their channel id alone.
   */
  readonly dropped: DropCounters = emptyCounters()

  /**
   * Replaces the list whole, unless the frame is older than the list held (a stale snapshot can never undo a pause).
   * An equal version is applied. Ids that are not channel ids are never honoured, whatever the server sends.
   */
  apply(frame: Pick<AllowlistFrame, 'version' | 'conversationIds'>): { applied: boolean; added: string[]; removed: string[] } {
    if (this.version !== null && frame.version < this.version) return { applied: false, added: [], removed: [] }
    const next = new Set(frame.conversationIds.filter((id) => CHANNEL_ID.test(id)))
    const added = [...next].filter((id) => !this.ids.has(id))
    const removed = [...this.ids].filter((id) => !next.has(id))
    this.ids = next
    for (const id of removed) this.cannotSend.delete(id)
    this.version = frame.version
    return { applied: true, added, removed }
  }

  allows(channel: string | null | undefined): boolean {
    return !!channel && this.ids.has(channel)
  }

  conversationIds(): string[] {
    return [...this.ids]
  }

  /** Records whether the bot may post; true when that changed. */
  setCanSend(conversationId: string, reason: CannotSendReason | null): boolean {
    const before = this.cannotSend.get(conversationId) ?? null
    if (reason) this.cannotSend.set(conversationId, reason)
    else this.cannotSend.delete(conversationId)
    return before !== reason
  }

  cannotSendReason(conversationId: string): CannotSendReason | null {
    return this.cannotSend.get(conversationId) ?? null
  }

  /** The outbound guard: throws unless `kind` may go to `conversationId` (D28). */
  check(conversationId: string, kind: OutboundKind): void {
    if (!this.allows(conversationId)) {
      this.dropped.outboundRefused++
      throw new OutboundRefused('not_connected', conversationId, kind)
    }
    const reason = this.cannotSendReason(conversationId)
    if (reason && POSTS.has(kind)) {
      this.dropped.outboundRefused++
      throw new OutboundRefused(reason, conversationId, kind)
    }
  }
}
