/**
 * The seam between the inbound door (B1b-2) and the bridge command executor
 * (B1b-4, BRIDGE-ENTITY-DESIGN §2.3 step 2, v2 §4). This file owns the TYPE;
 * the executor implements it and `main.ts` injects it as
 * `FacadeDeps.bridgeCommands`. Neither side imports the other's code.
 *
 * The contract (coordinator ruling, binding and frozen, 2026-10-30):
 *   - the inbound door calls `detect(body, ctx)` inside its transaction. A
 *     command is stored on the log anchor like any message, with
 *     `message_origins.command_state = 'pending'`, and is NEVER routed;
 *   - after the inbound transaction commits, the door calls `run(messageId)`
 *     without awaiting it. `run` claims the command
 *     (`internal.bridge_command_claim`, pending -> running, or a running row
 *     claimed more than 2 minutes ago), loads its own input, executes, posts
 *     its notice through `postBridgeNotice` and settles it
 *     (`internal.bridge_command_settle`), under `bridgesWorkerClaims()`;
 *   - the watchdog job calls `sweep()` every tick, which re-runs commands left
 *     unsettled (a crash between commit and `run`).
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
  | { kind: 'bridge'; actorId: string; trust: 'guest'; identityConflict?: boolean; participant: { displayName: string } };

/** What `detect` may consult beyond the body, inside the inbound transaction. */
export interface BridgeCommandDetectContext {
  readonly q: Querier;
  readonly bridgeId: string;
  readonly senderExternalId: string;
  /** The provider message this one quotes, if any (a YES confirming a notice, v2 §4.6). */
  readonly replyToExternalMessageId: string | null;
}

export interface BridgeCommandHook {
  /**
   * Is this inbound body a command? Pure for `/word` bodies; a bare YES quoting
   * a notice may read its confirmation row through `ctx.q`. Runs inside the
   * inbound transaction, before the message is stored, and only for a message
   * with a known sender. Text tm8 itself sent never reaches it (no echoes, D37).
   */
  detect(text: string, ctx: BridgeCommandDetectContext): Promise<boolean>;
  /** Claims, executes, answers and settles one stored command. Must not throw. */
  run(messageId: string): Promise<void>;
  /** Re-runs unsettled commands; answers how many it picked up. Must not throw. */
  sweep(): Promise<number>;
}
