/**
 * The skip-when-default rule (entity-chat design 01a0da4e §3.4), as one pure
 * function so the chat panel (lane C) and any test ask the same question.
 *
 *   1. The kind has a default teammate AND model, and BOTH still resolve (the
 *      teammate exists; the model is in this node's launch catalog) →
 *      `skip: true`: open the composer with them.
 *   2. Anything else — no default, half a default, or one that no longer
 *      resolves → `skip: false`: show the settings card, pre-filled with what
 *      did resolve, and NAME what did not (`problems`), never swap it silently.
 */
import type { ChatDefault } from '@tm8/contract';

export interface ChatDefaultResolveContext {
  /** Does this teammate still exist in the space? */
  teammateExists: (teammateId: string) => boolean;
  /** Is this model in this node's launch catalog? */
  modelOffered: (model: string) => boolean;
}

export interface ChatDefaultResolution {
  /** True only for rule 1: both set, both resolve. */
  skip: boolean;
  /** The parts that resolved — safe to pre-fill the card or composer with. */
  teammateId: string | null;
  model: string | null;
  /** One sentence per stored part that no longer resolves, for the card. */
  problems: string[];
}

export function resolveChatDefault(entry: ChatDefault | null | undefined, ctx: ChatDefaultResolveContext): ChatDefaultResolution {
  const problems: string[] = [];
  let teammateId: string | null = null;
  let model: string | null = null;
  if (entry?.teammateId) {
    if (ctx.teammateExists(entry.teammateId)) teammateId = entry.teammateId;
    else problems.push(`default teammate ${entry.teammateId} is no longer in this space`);
  }
  if (entry?.model) {
    if (ctx.modelOffered(entry.model)) model = entry.model;
    else problems.push(`default model ${entry.model} is no longer offered`);
  }
  return { skip: teammateId !== null && model !== null, teammateId, model, problems };
}
