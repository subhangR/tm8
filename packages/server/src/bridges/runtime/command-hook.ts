/**
 * The seam between the inbound door (B1b-2) and the bridge command executor
 * (B1b-4, BRIDGE-ENTITY-DESIGN §2.3 step 2, v2 §4). This file owns the TYPE;
 * the executor implements it and `main.ts` injects it as
 * `FacadeDeps.bridgeCommands`. Neither side imports the other's code.
 *
 * The contract (coordinator rulings, final, 2026-10-30):
 *   - the inbound door calls `detect(body, ctx)` inside its transaction. A
 *     command is stored on the log anchor like any message, with
 *     `message_origins.command_status = 'pending'`, and is NEVER routed;
 *   - after the inbound transaction commits, the door claims the command
 *     (pending -> running, attempts + 1) and calls `run(input)`. Resolving
 *     settles it `done`; rejecting puts it back to `pending`, or `failed`
 *     after 5 attempts. B1b-2 owns the whole state machine;
 *   - the watchdog job re-claims commands left `pending`, or `running` for
 *     more than 2 minutes (a crash between commit and `run`), rebuilds the
 *     input from `messages` + `message_origins` and calls `run` again. Expect
 *     `run` more than once per command: the executor's writes are idempotent
 *     on (bridgeId, externalMessageId, item).
 *
 * With no hook injected nothing is a command: messages route as text.
 */
import type { Querier } from '../../db/types.js';

/** `internal.bridge_resolve_author`'s JSON, as-is (395 §5). */
export type BridgeAuthor =
  | {
      kind: 'member';
      actorId: string;
      trust: 'linked' | 'asserted';
      identityId: string;
      linkId: string;
      participant: { displayName: string };
    }
  | { kind: 'bridge'; actorId: string; trust: 'guest'; participant: { displayName: string } };

/** What `detect` may consult beyond the body, inside the inbound transaction. */
export interface BridgeCommandDetectContext {
  readonly q: Querier;
  readonly bridgeId: string;
  readonly senderExternalId: string;
  /** The provider message this one quotes, if any (a YES confirming a notice, v2 §4.6). */
  readonly replyToExternalMessageId: string | null;
}

/** Everything `run` needs, rebuilt from the stored rows on every (re)run. */
export interface BridgeCommandInput {
  readonly bridgeId: string;
  readonly spaceId: string;
  readonly connectionId: string;
  /** The stored inbound message on the log anchor. */
  readonly messageId: string;
  /** The provider's message id: the dedupe and mutation-id key. */
  readonly externalMessageId: string;
  readonly senderExternalId: string | null;
  readonly author: BridgeAuthor;
  /** The raw body. */
  readonly text: string;
  /** The quoted message, if any. */
  readonly replyTo: { externalMessageId: string; text?: string } | null;
  /** 1 on the first run; the watchdog's re-runs count up. */
  readonly attempt: number;
}

export interface BridgeCommandHook {
  /**
   * Is this inbound body a command? Pure for `/word` bodies; a bare YES quoting
   * a notice may read its confirmation row through `ctx.q`. Runs inside the
   * inbound transaction, before the message is stored, and only for a message
   * with a known sender. Text tm8 itself sent never reaches it (no echoes, D37).
   */
  detect(text: string, ctx: BridgeCommandDetectContext): Promise<boolean>;
  /** Executes and answers one stored command. Resolving settles it; rejecting asks for a retry. */
  run(input: BridgeCommandInput): Promise<void>;
}
