import { useCallback, useMemo, useState } from 'react';
import type { CreatableEntityKind, EntityId, SpaceId } from '@tm8/contract';
import {
  alreadyCorrectedNotice,
  alreadyCorrectedRefusal,
  markDraftRefusal,
  MEMORY_FIELDS,
  MEMORY_MARK_COPY,
  markFields,
  type MemoryMarkKind,
} from '../domain/memory';
import { nextMutationId } from './commands';
import type { MemoryWorkingSetCommands } from './useMemoryWorkingSet';

/**
 * AUTHORING A MARK — `supersedes` and `disputes` (056 §5).
 *
 * Both are the same two-step shape and neither can be one step: the edge's
 * SOURCE must be evidence-bearing (056 registers `disputes` src as
 * [message, memory] and `supersedes` src as [memory]), so there is no
 * mark-without-evidence this UI could offer even if it wanted to. The flow is
 * therefore: write the evidence as a memory, then point the edge at the target.
 *
 * WHAT THIS HOOK REFUSES TO DO, deliberately:
 *
 *   · It does not delete anything. Both edge types are `append_only`, disputes
 *     are answered by verifications rather than removed, and 056's whole
 *     posture is that the record of having been wrong is itself evidence.
 *   · It does not move the target's `remembers` edges to the successor. That is
 *     consolidation (D7, the Dreamer's job) and it is a judgement about whose
 *     working set should change — not something a supersede button should do to
 *     every holder silently.
 *
 * A SUPERSEDE CAN NOW LOSE A RACE, AND THAT IS THE POINT (187). A memory keeps
 * exactly one correction, enforced by a unique index on the target of the
 * `supersedes` edge. Two people who decide the same claim is wrong within a
 * few seconds of each other used to get two rival successors and no warning;
 * the second one now gets refused. The evidence memory is already written by
 * then — the two steps cannot be merged into one, see above — so the refusal
 * handler's first job is to say that the words are safely stored, and its
 * second is to show the other correction so the reader can decide whether to
 * build on it. Both live in `alreadyCorrectedNotice`.
 *
 * THE VERSION PIN IS READ, NEVER GUESSED. `disputes.props.pinnedVersion` must
 * be the target's CURRENT version: a dispute pinned at version N stops applying
 * the moment the content moves to N+1 (that is exactly how `stalenessOf`
 * decides an open dispute), so pinning a stale number would author a mark that
 * silently does nothing.
 */

export interface MemoryMarksPort {
  spaceId: SpaceId;
  /** The memory being marked, with the version the dispute pin needs. */
  target: { id: EntityId; version: number; title: string } | null;
  /** From registry data — the authoring lane carries no kind literals. */
  memberKind: CreatableEntityKind | null;
  commands: MemoryWorkingSetCommands;
  onChanged(targetId: EntityId): void;
  onError(title: string, body: string): void;
}

export interface MemoryMarkComposerHandle {
  mark: MemoryMarkKind | null;
  values: Readonly<Record<string, string>>;
  saving: boolean;
  refusal: string | null;
  set(key: string, value: string): void;
  submit(): void;
  cancel(): void;
}

export interface MemoryMarksHandle {
  /** Null when there is nothing markable — no target, or no declared kind. */
  begin: ((mark: MemoryMarkKind) => void) | null;
  composer: MemoryMarkComposerHandle;
}

function emptyDraft(mark: MemoryMarkKind): Record<string, string> {
  return Object.fromEntries([
    ...MEMORY_FIELDS.map((field) => [field.key, '']),
    ...markFields(mark).map((field) => [field.key, '']),
  ]);
}

export function useMemoryMarks(port: MemoryMarksPort): MemoryMarksHandle {
  const { spaceId, target, memberKind, commands, onChanged, onError } = port;
  const [mark, setMark] = useState<MemoryMarkKind | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const begin = useMemo(() => {
    if (!target || !memberKind) return null;
    return (next: MemoryMarkKind) => {
      setMark(next);
      setValues(emptyDraft(next));
    };
  }, [memberKind, target]);

  const set = useCallback((key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const cancel = useCallback(() => {
    setMark(null);
    setValues({});
  }, []);

  const refusal = mark ? markDraftRefusal(mark, values) : null;

  const submit = useCallback(() => {
    if (!mark || !target || !memberKind || saving) return;
    if (markDraftRefusal(mark, values)) return;
    setSaving(true);
    void (async () => {
      let evidenceId: EntityId | null = null;
      const statement = (values.statement ?? '').trim();
      try {
        const created = await commands.createEntity({
          clientMutationId: nextMutationId(),
          spaceId,
          kind: memberKind,
          // The title IS the statement — `create_memory` takes no title.
          title: statement,
          content: {
            statement,
            mechanism: (values.mechanism ?? '').trim(),
            subjectScope: (values.subjectScope ?? '').trim(),
            doesNotEstablish: (values.doesNotEstablish ?? '').trim(),
          },
        });
        evidenceId = (created.entity?.id ?? null) as EntityId | null;
        if (!evidenceId) {
          throw new Error('the node accepted the evidence but returned no entity to mark from');
        }
        await commands.createEdge({
          clientMutationId: nextMutationId(),
          // The NEW claim is the source and the marked memory is the target:
          // the successor supersedes the predecessor, the evidence disputes the
          // claim. Reversing this would assert the opposite relationship.
          srcId: evidenceId,
          dstId: target.id,
          type: MEMORY_MARK_COPY[mark].edgeType,
          props: mark === 'supersede'
            ? { reason: (values.reason ?? '').trim() }
            : {
                quote: (values.quote ?? '').trim(),
                expected: (values.expected ?? '').trim(),
                observed: (values.observed ?? '').trim(),
                // READ from the target, never guessed — a stale pin authors a
                // dispute that applies to nothing.
                pinnedVersion: target.version,
              },
        });
        setMark(null);
        setValues({});
        onChanged(target.id);
      } catch (error) {
        // THE ONE REFUSAL WITH A BETTER ANSWER THAN THE SERVER'S SENTENCE.
        // Somebody else corrected this memory in the time it took to write
        // this one. The node's own message is already plain, but it quotes
        // their correction only as far as one line allows, and it cannot know
        // that this surface saved the new memory a moment ago. So the notice
        // is composed here from the node's facts (see `alreadyCorrectedNotice`
        // for why it is worded the way it is), and every other failure keeps
        // the faithful pass-through below.
        const corrected = alreadyCorrectedRefusal(error);
        if (corrected) {
          const notice = alreadyCorrectedNotice(corrected, evidenceId !== null);
          onError(notice.title, notice.body);
          return;
        }
        const message = String((error as { message?: string })?.message ?? error);
        onError(
          evidenceId ? 'Your memory was saved, but the link to the old one was not' : 'Nothing was saved',
          evidenceId
            ? `${message}\n\nWhat you wrote is safely stored as a memory of its own — it was not thrown away, because it is a claim somebody made and this app does not delete claims to tidy up. Point it at the old memory from there rather than writing it out again.`
            : message,
        );
      } finally {
        setSaving(false);
      }
    })();
  }, [commands, mark, memberKind, onChanged, onError, saving, spaceId, target, values]);

  return { begin, composer: { mark, values, saving, refusal, set, submit, cancel } };
}
