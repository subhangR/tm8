/**
 * THE ATTENTION COMMANDS (Attention v2, chapter 5): `markSeen`, `resolve(root,
 * note)` with the 8s Undo, `unresolve`, `withdraw`, `reply`. The only writes a
 * surface can make on attention, and the only file besides the port that calls
 * the attention verbs.
 *
 * Every command settles the store IN PLACE first and reconciles from the
 * command's response (`result.entity` carries the root's recomputed badge), so
 * the chip, the counts and the row change on click rather than on the echo.
 *
 * DEGRADING BEFORE S4. `markSeen`, `unresolve` and `withdraw` have server ops
 * only once S4 lands; until then `commands.attentionV2` has no such method and:
 * - markSeen dims the rows for this tab only;
 * - resolve also resolves each rolled-up child entity, since v1 `resolveEntity`
 *   settles only rows pinned on the entity it names;
 * - unresolve reopens the batch's rows one by one via `update(status: open)`;
 * - withdraw becomes `update(status: dismissed)`.
 * None of them throw: a failure puts the store's `error` up for the toast and
 * rolls the optimistic change back.
 */
import type {
  AttentionRequest,
  AttentionRequestMutationResult,
  EntityAttentionSummary,
  EntityId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** The Undo window (chapter 3): the server refuses an unresolve after it. */
export const UNDO_WINDOW_MS = 8_000;

/** What the store needs from the seam: the reads, the events and five writes. */
export interface AttentionSeam extends Pick<Seam, 'attentionRequests' | 'onEvent' | 'onResync' | 'entity'> {
  commands: Pick<Seam['commands'], 'resolveAttention' | 'updateAttentionRequest' | 'postMessage' | 'attentionV2'>;
}

/** The live Undo offer after a Resolve. */
export interface AttentionUndo {
  rootId: EntityId;
  batchId: string;
  /** Epoch ms after which the offer is gone (and the server would refuse). */
  expiresAt: number;
  /** The rows this Resolve settled, as they were, for the v1 fallback. */
  rows: readonly AttentionRequest[];
}

/** The store operations the commands drive. Implemented by the provider. */
export interface AttentionCommandContext {
  seam: AttentionSeam;
  /** Pending rows as the store currently shows them. */
  rowsOn(entityId: EntityId): readonly AttentionRequest[];
  rowById(requestId: string): AttentionRequest | undefined;
  hideRows(ids: readonly string[], rootId?: EntityId): void;
  showRows(ids: readonly string[], rootId?: EntityId): void;
  markSeenLocally(ids: readonly string[]): void;
  /** Reconcile from a command response. */
  applyResult(result: AttentionRequestMutationResult): void;
  setUndo(undo: AttentionUndo | null): void;
  currentUndo(): AttentionUndo | null;
  setError(message: string | null): void;
  refresh(): void;
  now(): number;
  newId(): string;
}

export interface AttentionCommands {
  markSeen(entityId: EntityId): Promise<void>;
  resolve(root: EntityId, note?: string): Promise<void>;
  unresolve(batchId: string): Promise<void>;
  withdraw(requestId: string): Promise<void>;
  reply(sessionId: EntityId, body: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return String((error as { message?: string })?.message ?? error);
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

export function createAttentionCommands(ctx: AttentionCommandContext): AttentionCommands {
  const v2 = () => ctx.seam.commands.attentionV2;

  return {
    async markSeen(entityId) {
      const ids = ctx.rowsOn(entityId).filter((row) => row.seenByMe !== true).map((row) => row.id);
      if (ids.length === 0) return;
      ctx.markSeenLocally(ids);
      const markSeen = v2()?.markSeen;
      if (!markSeen) return;
      try {
        await markSeen(entityId, { clientMutationId: `attention-seen:${ctx.newId()}` });
      } catch {
        // Seen is a dimming hint for one person. A failed write is not worth
        // an error toast, and the local dim is still true for this tab.
      }
    },

    async resolve(root, note) {
      const rows = ctx.rowsOn(root);
      const batchId = ctx.newId();
      const trimmed = note?.trim() || undefined;
      const ids = rows.map((row) => row.id);
      ctx.hideRows(ids, root);
      ctx.setError(null);
      ctx.setUndo({ rootId: root, batchId, expiresAt: ctx.now() + UNDO_WINDOW_MS, rows });
      const input = {
        resolutionBatchId: batchId,
        ...(trimmed ? { resolutionNote: trimmed } : {}),
      };
      try {
        // v1 `resolveEntity` settles only rows pinned on the named entity, so
        // before S4 each rolled-up child is resolved by name. Children first,
        // the root last, so the root's response carries the final badge.
        if (!v2()?.unresolve) {
          const children = [...new Set(rows.map((row) => row.entityId))].filter((id) => id !== root);
          for (const child of children) {
            ctx.applyResult(await ctx.seam.commands.resolveAttention(child, {
              clientMutationId: `attention-resolve:${batchId}:${child}`,
              ...input,
            }));
          }
        }
        ctx.applyResult(await ctx.seam.commands.resolveAttention(root, {
          clientMutationId: `attention-resolve:${batchId}`,
          ...input,
        }));
      } catch (error) {
        ctx.showRows(ids, root);
        if (ctx.currentUndo()?.batchId === batchId) ctx.setUndo(null);
        ctx.setError(`Couldn't resolve: ${messageOf(error)}`);
      }
      ctx.refresh();
    },

    async unresolve(batchId) {
      const undo = ctx.currentUndo();
      if (!undo || undo.batchId !== batchId) return;
      ctx.setUndo(null);
      const ids = undo.rows.map((row) => row.id);
      ctx.showRows(ids, undo.rootId);
      try {
        const unresolve = v2()?.unresolve;
        if (unresolve) {
          ctx.applyResult(await unresolve(batchId, { clientMutationId: `attention-unresolve:${batchId}` }));
        } else {
          // A resolve bumps each row's version by exactly one (050), which is
          // the version the reopen must send.
          for (const row of undo.rows) {
            try {
              ctx.applyResult(await ctx.seam.commands.updateAttentionRequest(row.id, {
                clientMutationId: `attention-unresolve:${batchId}:${row.id}`,
                expectedVersion: row.version + 1,
                status: 'open',
              }));
            } catch (error) {
              // Someone else moved this row since: leave it where they put it.
              if (codeOf(error) !== 'version_conflict') throw error;
            }
          }
        }
      } catch (error) {
        ctx.hideRows(ids, undo.rootId);
        ctx.setError(`Couldn't undo: ${messageOf(error)}`);
      }
      ctx.refresh();
    },

    async withdraw(requestId) {
      const row = ctx.rowById(requestId);
      if (!row) return;
      ctx.hideRows([requestId]);
      try {
        const withdraw = v2()?.withdraw;
        ctx.applyResult(withdraw
          ? await withdraw(requestId, {
            clientMutationId: `attention-withdraw:${requestId}`,
            expectedVersion: row.version,
          })
          : await ctx.seam.commands.updateAttentionRequest(requestId, {
            clientMutationId: `attention-withdraw:${requestId}:${row.version}`,
            expectedVersion: row.version,
            status: 'dismissed',
          }));
      } catch (error) {
        ctx.showRows([requestId]);
        ctx.setError(`Couldn't withdraw: ${messageOf(error)}`);
      }
      ctx.refresh();
    },

    async reply(sessionId, body) {
      const text = body.trim();
      if (!text) return;
      try {
        await ctx.seam.commands.postMessage({
          clientMutationId: `attention-reply:${ctx.newId()}`,
          anchorIds: [sessionId],
          body: text,
        });
      } catch (error) {
        ctx.setError(`Couldn't send the reply: ${messageOf(error)}`);
      }
    },
  };
}

/** The badge a command response or an upsert reports for its entity. */
export function badgeOf(entity: { badges?: { attention?: EntityAttentionSummary | null } | null }): EntityAttentionSummary | null {
  return entity.badges?.attention ?? null;
}
