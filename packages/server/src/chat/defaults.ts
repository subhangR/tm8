/**
 * `spaces.chatDefaults.get` / `spaces.chatDefaults.set` — the per-kind chat
 * defaults (entity-chat design 01a0da4e §3.4). Storage, validation and the
 * gate all live in migration 229's two SECURITY DEFINER doors; this file only
 * binds them to the operations.
 *
 *   · get — any member of the space; a non-member is `forbidden`.
 *   · set — a human owner/admin (`internal.require_human_space_admin`, the
 *     `spaces.interactionProfile.setDefault` gate). A PATCH over kinds.
 */
import { SetChatDefaultsInputSchema, type ChatDefaultsView } from '@tm8/contract';

import { claimsFor, requireUuidParam } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { fail } from '../http/errors.js';

export function registerChatDefaultsHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.register('spaces.chatDefaults.get', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const owner = await deps.owner();
    return deps.db.rpc<ChatDefaultsView>(claimsFor(owner, ctx), 'get_space_chat_defaults', [spaceId]);
  });

  registry.register('spaces.chatDefaults.set', async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const parsed = SetChatDefaultsInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      throw fail('invalid_input', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
    }
    const owner = await deps.owner();
    return deps.db.rpc<ChatDefaultsView>(
      claimsFor(owner, ctx),
      'set_space_chat_defaults',
      [spaceId, JSON.stringify(parsed.data.defaults), parsed.data.clientMutationId ?? null],
    );
  });
}
