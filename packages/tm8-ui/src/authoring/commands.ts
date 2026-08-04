/**
 * THE AUTHORING PORT — the narrow slice of the facade seam the create and save
 * flows need, plus the vocabulary for the ways they can fail.
 *
 * WHY A PORT AND NOT AN IMPORT OF `Seam`. Two reasons, and only the second is
 * about testing.
 *
 *  1. `src/data/**` is bridge's lane and READ-ONLY here. Consuming two named
 *     methods rather than the whole 40-member interface makes the dependency
 *     legible: if bridge changes anything else, this lane is provably
 *     unaffected, and the review does not have to establish that by reading.
 *  2. `AuthoringCommands` is a STRUCTURAL SUBSET of `Seam['commands']`, so the
 *     real object satisfies it with no adapter, no wrapper and NO CAST. That
 *     matters: an adapter is a place where an argument can be dropped, and
 *     dropping an argument is exactly how the `rowsFor` defect (D57.1) put four
 *     sessions on screen as twelve while four suites stayed green. The
 *     assignment `const c: AuthoringCommands = seam.commands` in
 *     `authoring-seam.test.tsx` is the compile-time half of that crossing
 *     assertion; the dataset assertions in the same file are the runtime half.
 *
 * The shapes below are the CONTRACT'S OWN, imported rather than restated. A
 * remembered shape is the other way this goes wrong — `CreateTaskInput`'s
 * `clientMutationId` is OPTIONAL (it rides in via `CommandContext`), unlike
 * `CreateEntityInput`'s, which is required. That asymmetry is real and is why
 * `newTaskInput()` below stamps one unconditionally rather than trusting a
 * caller to remember.
 */
import {
  isCollabError,
  type CommandResult,
  type CreateTaskInput,
  type EntityDetail,
  type EntityId,
  type PatchTaskInput,
  type SpaceId,
} from '@tm8/contract';

export interface AuthoringCommands {
  createTask(input: CreateTaskInput): Promise<CommandResult>;
  patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult>;
}

/**
 * The editable members of a task patch — derived from the contract type by
 * subtraction, never retyped. `expectedVersion` is removed because the flow
 * owns it (see `useTaskSave`), and the `CommandContext` envelope is removed
 * because the port stamps it. Adding a member to `PatchTaskInput` upstream
 * makes it editable here with no edit.
 */
export type TaskEdits = Omit<PatchTaskInput, 'expectedVersion' | 'actorId' | 'clientMutationId'>;

// ---------------------------------------------------------------------------
// Mutation ids
// ---------------------------------------------------------------------------

let mutationSeq = 0;

/**
 * A client mutation id: the key a store journals an optimistic write under and
 * the key the echo event carries back (the fixture seam stamps it onto
 * `entity.upsert`; the real seam does the same through the wire envelope).
 *
 * GLOBALLY UNIQUE, and it has to be — the bare `au-<n>` counter this was
 * measured to fail as (Identity v2 Slice 1 browser acceptance, 2026-08-02):
 * with real multi-principal auth, every human's FIRST create was `au-1`, and
 * `require_replay_principal` correctly refused the second human with
 * "clientMutationId belongs to another principal". The guard is right; the
 * id must be unique across every principal that will ever talk to the node,
 * not merely within one client's in-flight set. The monotonic prefix is kept
 * for log legibility and test assertions (`startsWith('au-')`, distinctness).
 */
export function nextMutationId(): string {
  mutationSeq += 1;
  return `au-${mutationSeq}-${randomIdSuffix()}`;
}

/** `crypto.randomUUID` where the context grants it; a time+entropy fallback
 * where it does not (it is secure-context-gated, and a plain-HTTP LAN page
 * would otherwise crash on its first create rather than degrade). */
function randomIdSuffix(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Input builders — ONE builder per command, both surfaces call it
// ---------------------------------------------------------------------------

export function newTaskInput(spaceId: SpaceId, title: string): CreateTaskInput {
  return { spaceId, title, clientMutationId: nextMutationId() };
}

export function taskPatchInput(edits: TaskEdits, expectedVersion: number): PatchTaskInput {
  return { ...edits, expectedVersion, clientMutationId: nextMutationId() };
}

/**
 * The placeholder title the generic-create pattern commits immediately.
 *
 * T5-6 draws "Untitled task" and captions it "created for real, instantly —
 * the row is already in the list as 'Untitled task'". The word comes from the
 * kind's registry `label`, so a new kind gets its placeholder for free and no
 * kind literal ever enters this lane.
 */
export function placeholderTitleFor(kindLabel: string): string {
  return `Untitled ${kindLabel.toLowerCase()}`;
}

/**
 * The id of the thing a create just made.
 *
 * `CommandResult.entity` is OPTIONAL in the contract and `patches` is not, so
 * both are consulted — and when neither carries an id the answer is `null`
 * rather than a cast or an optional chain that silently yields `undefined`.
 * A create that succeeded without telling us what it created is a real state
 * (the flow renders it, see `useNewTask`), and it is not the same state as a
 * failure.
 */
export function createdIdOf(result: CommandResult): EntityId | null {
  if (result.entity) return result.entity.id;
  const first = result.patches.length > 0 ? result.patches[0] : undefined;
  return first ? first.id : null;
}

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * A version conflict is its OWN kind, not a flavour of refusal, because it is
 * the only failure with a legitimate "keep mine" answer. Collapsing it into
 * the refusal bucket is how a UI ends up offering "retry" for a conflict —
 * which, at the same expectedVersion, either fails forever or (if it silently
 * re-reads the version) overwrites the other writer. Both are wrong; the type
 * makes both unreachable.
 */
export interface ConflictFailure {
  kind: 'conflict';
  /** The red word line (T5-5's refusal grammar). */
  cause: string;
  /** Why: the server's own sentence, or ours when it sent none. */
  detail: string;
  /**
   * WHAT DID NOT HAPPEN. A named field rather than prose spliced at a render
   * site, because T5-5's annotation makes it a required element of the grammar
   * — "red word + cause + what did NOT happen + real next moves" — and because
   * it is the one sentence that differs per flow while everything around it is
   * shared. The `no_id` state proves the field earns its place: there the
   * honest aftermath is "the task MAY exist", and a hard-coded "nothing was
   * created" at the card would have contradicted the state it was rendering.
   */
  aftermath: string;
  /**
   * The version that won, or `null` when the node did not say.
   *
   * NULL IS LOAD-BEARING: without it we do not know what an overwrite would be
   * overwriting, so the overwrite affordance renders disabled-with-reason
   * instead of guessing. Two sources are consulted — `CollabError.current`
   * (the contract's own "a version_conflict carries current: EntityDetail")
   * and `error.details.currentVersion` (the `ErrorDetails` member) — because a
   * real node may send either.
   */
  currentVersion: number | null;
  /** The server's detail, when it came with the error. Enables "take theirs". */
  current: EntityDetail | null;
}

export interface RefusedFailure {
  kind: 'refused';
  cause: string;
  detail: string;
  /** What did NOT happen — see ConflictFailure.aftermath. */
  aftermath: string;
  /** The contract's `CommandErrorCode`, or 'unknown' for a non-CollabError. */
  code: string;
  /** The contract's own flag. Never inferred from the message. */
  retryable: boolean;
}

export type AuthoringFailure = ConflictFailure | RefusedFailure;

/**
 * Turn whatever came out of a rejected command into a state the UI can render
 * honestly. `verb` is the word in the red line ("save", "create").
 *
 * A NON-CollabError IS NOT DRESSED UP AS ONE. A TypeError from a broken
 * transport gets `code: 'unknown'` and carries its own message, because
 * claiming a typed refusal we did not receive would make an app bug look like
 * a server policy — and the user would go looking in the wrong place.
 */
export function classifyFailure(error: unknown, verb: string): AuthoringFailure {
  // "save" → "saved", "create" → "created". One rule, both verbs, and a verb
  // it does not fit would read wrong loudly rather than silently.
  const aftermath = `Nothing was ${verb}d.`;
  if (isCollabError(error)) {
    if (error.code === 'version_conflict') {
      const fromDetails = error.details?.currentVersion;
      return {
        kind: 'conflict',
        cause: `${verb} refused — this changed while you were editing`,
        detail: error.message,
        aftermath: 'Nothing was saved; your text is kept right here.',
        currentVersion:
          error.current?.version ?? (typeof fromDetails === 'number' ? fromDetails : null),
        current: error.current ?? null,
      };
    }
    return {
      kind: 'refused',
      cause: `${verb} refused — ${error.code.replace(/_/g, ' ')}`,
      detail: error.message,
      aftermath,
      code: error.code,
      retryable: error.retryable,
    };
  }
  return {
    kind: 'refused',
    cause: `${verb} failed`,
    detail:
      error instanceof Error
        ? `${error.message} — this did not arrive in the contract's error shape, so there is no server-stated reason.`
        : 'The failure carried no message at all.',
    aftermath,
    code: 'unknown',
    retryable: false,
  };
}

