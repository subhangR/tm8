/**
 * THE DOC PORT — the one seam method this surface needs, plus the readers that
 * get a doc's text out of a contract DTO without ever asking "is this a doc?".
 *
 * WHY A PORT AND NOT AN IMPORT OF `Seam` — the same two reasons `authoring/
 * commands.ts` states, and the second is the load-bearing one: `DocCommands`
 * is a STRUCTURAL SUBSET of `Seam['commands']`, so the real object satisfies it
 * with no adapter, no wrapper and NO CAST. An adapter is a place an argument
 * can be dropped, and dropping `expectedVersion` here would silently convert
 * every conflict into an overwrite.
 *
 * THE FAILURE VOCABULARY IS IMPORTED, NOT RESTATED. `classifyFailure`,
 * `ConflictFailure` and `RefusedFailure` already exist in `../authoring` and
 * already encode the one distinction that matters — a version conflict is its
 * OWN kind, not a flavour of refusal, because it is the only failure with a
 * legitimate "keep mine" answer. Forking that would give this package two
 * error vocabularies that agree only by care.
 */
import type { CommandResult, EntityDetail, EntityId, PatchEntityInput } from '@tm8/contract';
import { nextMutationId } from '../authoring';

export interface DocCommands {
  patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult>;
}

/**
 * The editable members of a doc. `body` is the doc content member the contract
 * declares (`CoreEntityContent` — `{ kind: 'doc'; body: string; format }`);
 * `format` is deliberately absent because nothing in T5-3 changes it, and a
 * field the UI can send but never means to is a way to clobber one by accident.
 */
export interface DocEdits {
  title?: string;
  body?: string;
}

/**
 * Build the patch. `expectedVersion` is a REQUIRED positional argument rather
 * than a member of `edits` so it cannot be forgotten: `PatchEntityInput` would
 * accept an object without it only by failing to compile, and this signature
 * makes that failure impossible to route around at a call site.
 *
 * `title` rides at the top level and `body` inside `content` because that is
 * the contract's own shape (`PatchEntityInput { expectedVersion, title?,
 * content? }`) — not a convention this file invented.
 */
export function docPatchInput(edits: DocEdits, expectedVersion: number): PatchEntityInput {
  const input: PatchEntityInput = { expectedVersion, clientMutationId: nextMutationId() };
  if (edits.title !== undefined) input.title = edits.title;
  if (edits.body !== undefined) input.content = { body: edits.body };
  return input;
}

/**
 * The doc's text, read STRUCTURALLY. `content.body` is the doc member and
 * `content.description` is the task one; both are prose a reader surface can
 * show, so a kind whose registry row routes it here works with no kind literal
 * — which is what lets `panels/no-branching.test.ts`'s law hold one lane over.
 */
export function docBodyOf(detail: EntityDetail): string {
  const content = detail.content as unknown as Record<string, unknown>;
  const body = content.body ?? content.description;
  return typeof body === 'string' ? body : '';
}

/** The format the record carries, or null when it carries none. Never guessed. */
export function docFormatOf(detail: EntityDetail): string | null {
  const content = detail.content as unknown as Record<string, unknown>;
  const state = detail.state as unknown as Record<string, unknown>;
  const format = content.format ?? state.format;
  return typeof format === 'string' && format.length > 0 ? format : null;
}

/**
 * The version a command result actually produced.
 *
 * READ FROM THE RESULT, NEVER `base + 1`. The increment looks obviously right
 * and is a guess about a server we do not control; when the result carries no
 * version at all the answer is `null` and the footer says "saved" without a
 * number, which is the honest shape of not knowing.
 */
export function savedVersionOf(result: CommandResult): number | null {
  if (result.entity) return result.entity.version;
  const first = result.patches.length > 0 ? result.patches[0] : undefined;
  return first ? first.version : null;
}
