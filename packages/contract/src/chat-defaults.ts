/**
 * spaces.chatDefaults.get / spaces.chatDefaults.set — the teammate and model a
 * new chat about an entity of a given kind starts with (entity-chat design
 * 01a0da4e §3.4, "Settings → Space → Chat defaults").
 *
 * SPACE-WIDE, stored on the server (migration 226). Every member may read
 * the map; only a human owner/admin may write it, the same gate as
 * `spaces.interactionProfile.setDefault`.
 *
 * Both fields of an entry are optional. The chat panel skips its settings
 * card only when a kind has BOTH and both still resolve (§3.4 rule 1); a half
 * default is kept as written and pre-fills the card.
 *
 * `set` is a PATCH over kinds: each kind named in `defaults` is replaced by
 * the given entry, and `null` (or an entry with neither field) clears it.
 * Kinds not named are left alone, so two admins editing different rows never
 * overwrite each other.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

/** Kinds a chat can never be about, so they never carry a default. */
export const CHAT_DEFAULTS_EXCLUDED_KINDS = ['message', 'chat'] as const;

/** A core kind slug (`task`, `work_session`) or a custom `c:{name}` kind (001's rule). */
export const CHAT_DEFAULTS_KIND_PATTERN = /^(?:[a-z][a-z0-9_]{0,48}|c:[a-z0-9][a-z0-9_]{0,48})$/;

/** Model ids are catalog strings; this is only a sanity bound. Migration 226 enforces the same. */
export const CHAT_DEFAULTS_MODEL_MAX = 200;

export interface ChatDefault {
  teammateId?: EntityId;
  model?: string;
}

export type ChatDefaultsMap = Record<string, ChatDefault>;

export interface ChatDefaultsView {
  spaceId: EntityId;
  /** Kind → its default. A kind with no default is absent. */
  defaults: ChatDefaultsMap;
  /** Bumped on every effective write; 0 before the first. */
  revision: number;
}

export interface SetChatDefaultsInput {
  /** Kind → entry to store, or `null` to clear that kind. Unnamed kinds are untouched. */
  defaults: Record<string, ChatDefault | null>;
  clientMutationId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ChatDefaultSchema: z.ZodType<ChatDefault> = z.object({
  teammateId: z.string().regex(UUID, 'teammateId must be an entity id').optional(),
  model: z.string().trim().min(1).max(CHAT_DEFAULTS_MODEL_MAX).optional(),
}).strict();

export const SetChatDefaultsInputSchema: z.ZodType<SetChatDefaultsInput> = z.object({
  defaults: z.record(
    z.string().regex(CHAT_DEFAULTS_KIND_PATTERN, 'not an entity kind')
      .refine((kind) => !(CHAT_DEFAULTS_EXCLUDED_KINDS as readonly string[]).includes(kind), 'a chat cannot be about this kind'),
    ChatDefaultSchema.nullable(),
  ),
  clientMutationId: z.string().min(1).max(200).optional(),
}).strict();
