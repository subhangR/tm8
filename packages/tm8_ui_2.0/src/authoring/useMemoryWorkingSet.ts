import { useCallback, useMemo, useState } from 'react';
import type {
  CommandContext,
  CommandResult,
  CreatableEntityKind,
  CreateEdgeInput,
  CreateEntityInput,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import { MEMORY_FIELDS, memoryDraftRefusal, type MemoryFieldKey } from '../domain/memory';
import type { MemoryAuthoring } from '../panels/bodies/ProfileBody';
import { nextMutationId } from './commands';

/**
 * AUTHORING THE `remembers` WORKING SET (056 / 084 / 085).
 *
 * WHY A HOOK AND NOT A BODY-LEVEL SEAM HANDLE. No detail body in this tree
 * mutates the graph (verified: nothing under `panels/bodies/` imports
 * createEntity/createEdge/deleteEdge), and the one that would have to here is
 * `ProfileBody`, whose whole design is that anatomy is registry DATA and the
 * file only knows how to draw block TYPES. Giving it commands would make it the
 * first body that can write, and every future block would inherit the
 * temptation. So the block raises INTENT and this hook performs the writes —
 * the same split `EntityControls` uses for state and assignment.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ADD IS TWO WRITES AND CANNOT BE ONE, which is worth stating because
 * `CreateEntityInput` LOOKS like it could do both:
 *
 *   `create` carries `connections: InitialConnectionInput[]`, and
 *   `attachInitialConnections` (entities-commands-tracking.ts:900) writes each
 *   one as `write_edge(NEW_ENTITY, connection.targetId, type)` — the new entity
 *   is always the SOURCE.
 *
 * `remembers` runs holder → memory (056 registers src member|team_member|
 * work_session, dst memory; 085 widens src to the wildcard and leaves dst
 * locked). Riding `connections` would therefore write `memory → holder`, which
 * is not a registered direction and `internal.validate_edge` refuses. So:
 * create the memory, then create the edge from the holder to it.
 *
 * The consequence is honest and is surfaced rather than hidden: the two writes
 * are not atomic. If the edge fails, the MEMORY STILL EXISTS — it is a real
 * claim somebody authored, and 056's whole posture is that memories are not
 * destroyed to tidy up. The refusal says exactly that and names the memory, so
 * the author can attach it rather than silently re-writing it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REMOVE IS ONE EDGE DELETE AND NEVER AN ENTITY DELETE. The memory survives:
 * it is the target of other actors' `supersedes`/`disputes`/`verifies` marks,
 * those edge types are append-only by design, and destroying a claim because
 * one holder stopped tracking it would destroy other people's evidence.
 */

export interface MemoryWorkingSetCommands {
  createEntity(input: CreateEntityInput): Promise<CommandResult>;
  createEdge(input: CreateEdgeInput): Promise<CommandResult>;
  deleteEdge(edgeId: string, ctx?: CommandContext): Promise<CommandResult>;
}

export interface MemoryWorkingSetPort {
  spaceId: SpaceId;
  /** The entity holding the set — a teammate, or (since 085) a task. */
  holderId: EntityId | null;
  /**
   * What a new member of this set IS, and the EDGE that binds it — both read
   * off the block's registry params by the host, never written here.
   *
   * §15.2 is enforced in this directory by `no-kind-literals.test.ts`: the
   * create/save flows must reach a kind through registry DATA. A `'memory'`
   * literal in this file would also quietly make the hook single-purpose, when
   * the only thing it actually does is "create an entity of kind K and point
   * edge E at it from the holder".
   */
  memberKind: CreatableEntityKind | null;
  edgeType: string;
  /**
   * Whether this holder's panel offers authoring at all. False renders the set
   * read-only; a REASON renders the controls refused-but-focusable instead.
   */
  refusal?: string | null;
  commands: MemoryWorkingSetCommands;
  /** Re-read the holder so the set reflects the write. */
  onChanged(holderId: EntityId): void;
  onError(title: string, body: string): void;
}

export interface MemoryComposerHandle {
  open: boolean;
  values: Readonly<Record<string, string>>;
  saving: boolean;
  /** Client-side echo of the door's own btrim check, named by FIELD. */
  refusal: string | null;
  set(key: MemoryFieldKey, value: string): void;
  submit(): void;
  cancel(): void;
}

export interface MemoryWorkingSetHandle {
  /** Pass to `EntityDetailPanel.memoryAuthoring`. Null when unhosted. */
  authoring: MemoryAuthoring | null;
  composer: MemoryComposerHandle;
}

const EMPTY_DRAFT: Record<string, string> = Object.fromEntries(
  MEMORY_FIELDS.map((field) => [field.key, '']),
);

export function useMemoryWorkingSet(port: MemoryWorkingSetPort): MemoryWorkingSetHandle {
  const { spaceId, holderId, memberKind, edgeType, commands, onChanged, onError } = port;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  /** Edge ids in flight, so a forgetting row says so rather than looking inert. */
  const [pending, setPending] = useState<readonly string[]>([]);

  const set = useCallback((key: MemoryFieldKey, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const cancel = useCallback(() => {
    setOpen(false);
    setValues(EMPTY_DRAFT);
  }, []);

  const refusal = memoryDraftRefusal(values);

  const submit = useCallback(() => {
    if (!holderId || !memberKind || saving) return;
    if (memoryDraftRefusal(values)) return;
    setSaving(true);
    void (async () => {
      let memoryId: EntityId | null = null;
      let statement = '';
      try {
        statement = (values.statement ?? '').trim();
        /*
         * NO `title` OF OUR OWN. `create_memory` takes no title argument — the
         * title IS the statement, derived server-side
         * (entities-commands-tracking.ts:1063). Sending a different title would
         * be a value the server discards, so the field carries the statement
         * and says so.
         */
        const created = await commands.createEntity({
          clientMutationId: nextMutationId(),
          spaceId,
          kind: memberKind,
          title: statement,
          content: {
            statement,
            mechanism: (values.mechanism ?? '').trim(),
            subjectScope: (values.subjectScope ?? '').trim(),
            doesNotEstablish: (values.doesNotEstablish ?? '').trim(),
          },
        });
        memoryId = (created.entity?.id ?? null) as EntityId | null;
        if (!memoryId) {
          throw new Error('the node accepted the memory but returned no entity to link');
        }
        await commands.createEdge({
          clientMutationId: nextMutationId(),
          srcId: holderId,
          dstId: memoryId,
          type: edgeType,
        });
        setOpen(false);
        setValues(EMPTY_DRAFT);
        onChanged(holderId);
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? error);
        // The two-write seam, stated at the only moment it matters.
        onError(
          memoryId ? 'The memory was created but not remembered' : 'The memory was not created',
          memoryId
            ? `${message}. The memory entity exists — “${statement}” — and was NOT deleted: a claim somebody authored is not destroyed to tidy up a failed link. Add it from the memory itself rather than writing it again.`
            : message,
        );
      } finally {
        setSaving(false);
      }
    })();
  }, [commands, edgeType, holderId, memberKind, onChanged, onError, saving, spaceId, values]);

  const onForget = useCallback((edgeId: string, title: string) => {
    if (!holderId) return;
    setPending((current) => [...current, edgeId]);
    void (async () => {
      try {
        await commands.deleteEdge(edgeId, { clientMutationId: nextMutationId() });
        onChanged(holderId);
      } catch (error) {
        onError(
          'The memory was not forgotten',
          `${String((error as { message?: string })?.message ?? error)}. “${title}” is still in this working set. Only the remembers edge was going to be removed — the memory itself is never deleted from here.`,
        );
      } finally {
        setPending((current) => current.filter((id) => id !== edgeId));
      }
    })();
  }, [commands, holderId, onChanged, onError]);

  const onAdd = useCallback(() => { setOpen(true); }, []);

  const authoring = useMemo<MemoryAuthoring | null>(() => {
    /*
     * NO HOLDER, NO DECLARED MEMBER KIND, OR NO EDGE ⇒ NO CONTROLS AT ALL,
     * rather than controls refused with a reason. A refusal is for something
     * the viewer could plausibly do; this is a registry row that never said
     * what its set holds, which is a wiring gap and not a permission.
     */
    if (!holderId || !memberKind || edgeType.length === 0) return null;
    return {
      onAdd,
      onForget,
      ...(port.refusal ? { refusal: port.refusal } : {}),
      pending,
    };
  }, [edgeType, holderId, memberKind, onAdd, onForget, pending, port.refusal]);

  return {
    authoring,
    composer: { open, values, saving, refusal, set, submit, cancel },
  };
}
