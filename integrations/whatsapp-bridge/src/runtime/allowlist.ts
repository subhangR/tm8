// Connected groups only (D28): the allowlist the server pushes per connection, the inbound drop, and the outbound guard.
// This is the runtime's half of the two independent checks; the server checks again on its side.
import type { AllowlistFrame, CannotSendReason, DropCounters } from './protocol.js'

export type OutboundKind = 'text' | 'media' | 'poll' | 'reaction' | 'typing' | 'read' | 'media.fetch'

/** The frames that post into the conversation; an admins-only group refuses these and nothing else. */
const POSTS: ReadonlySet<OutboundKind> = new Set(['text', 'media', 'poll'])

export class OutboundRefused extends Error {
  constructor(public reason: 'not_connected' | CannotSendReason, conversationId: string, kind: OutboundKind) {
    super(`refusing ${kind} to ${conversationId}: ${reason === 'not_connected' ? 'not a connected conversation' : reason}`)
  }
}

/** Strips the device part of a user JID (`123:4@s.whatsapp.net` → `123@s.whatsapp.net`); groups are unchanged. */
export function bareJid(jid: string): string {
  const at = jid.indexOf('@')
  if (at < 0) return jid
  const user = jid.slice(0, at).split(':')[0]!
  const server = jid.slice(at + 1)
  return `${user}@${server === 'c.us' ? 's.whatsapp.net' : server}`
}

const emptyCounters = (): DropCounters => ({ stanzas: 0, messages: 0, outboundRefused: 0 })

/** One connection's allowlist. Before the first list arrives it allows nothing. */
export class Allowlist {
  private ids = new Set<string>()
  private cannotSend = new Map<string, CannotSendReason>()
  /** The number's own JIDs (PN and LID): never conversations by themselves, but their stanzas carry the device's plumbing. */
  readonly own = new Set<string>()
  version: number | null = null
  readonly dropped: DropCounters = emptyCounters()

  /**
   * Replaces the list whole, unless the frame is older than the list held: a version below it is stale and ignored,
   * from whichever path it came (a push, a `hello` reply, a `connect`), so a late snapshot can never undo a pause. An
   * equal version is applied (the `hello` reply after a reconnect repeats it). Ids that are neither a group nor the
   * number's own self chat are never honoured, whatever the server sends.
   */
  apply(frame: Pick<AllowlistFrame, 'version' | 'conversationIds'>): { applied: boolean; added: string[]; removed: string[] } {
    if (this.version !== null && frame.version < this.version) return { applied: false, added: [], removed: [] }
    const next = new Set(frame.conversationIds.map(bareJid).filter((id) => id.endsWith('@g.us') || id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')))
    const added = [...next].filter((id) => !this.ids.has(id))
    const removed = [...this.ids].filter((id) => !next.has(id))
    this.ids = next
    for (const id of removed) this.cannotSend.delete(id)
    this.version = frame.version
    return { applied: true, added, removed }
  }

  /** Is this conversation connected? Any of the ids given (a JID and its PN/LID alternate) may match. */
  allows(...jids: (string | null | undefined)[]): boolean {
    return this.match(...jids) !== null
  }

  /** The listed conversation id the given JIDs stand for, or null. A connected self chat arrives under either own JID. */
  match(...jids: (string | null | undefined)[]): string | null {
    for (const j of jids) {
      if (!j) continue
      const id = bareJid(j)
      // Only a group, or the number's own self chat, can be connected: a listed DM is never honoured (D28).
      if (id.endsWith('@g.us')) {
        if (this.ids.has(id)) return id
      } else if (this.own.has(id)) {
        for (const o of this.own) if (this.ids.has(o)) return o
      }
    }
    return null
  }

  conversationIds(): string[] {
    return [...this.ids]
  }

  isOwn(jid: string): boolean {
    return this.own.has(bareJid(jid))
  }

  /**
   * Baileys' `shouldIgnoreJid`: a stanza from a JID this says yes to is acked and dropped before it is decrypted, so
   * nothing from a conversation off the list is ever read (and no delivery receipt goes back for it). The device's own
   * JIDs stay open (app-state keys and protocol messages ride them); the content filter at upsert still drops an
   * unconnected self chat.
   */
  shouldIgnore = (jid: string): boolean => {
    if (this.allows(jid) || this.isOwn(jid)) return false
    this.dropped.stanzas++
    return true
  }

  setCanSend(conversationId: string, reason: CannotSendReason | null): boolean {
    const id = bareJid(conversationId)
    const before = this.cannotSend.get(id) ?? null
    if (reason) this.cannotSend.set(id, reason)
    else this.cannotSend.delete(id)
    return before !== reason
  }

  cannotSendReason(conversationId: string): CannotSendReason | null {
    return this.cannotSend.get(bareJid(conversationId)) ?? null
  }

  /** The outbound guard: throws unless `kind` may go to `conversationId` (D28; admins-only groups refuse posts). */
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
