/**
 * THE LAUNCH PORT — the one place `LaunchSources` is built from `GateData`.
 *
 * WHY THIS EXISTS AS A HOOK RATHER THAN AN INLINE OBJECT. It was inline, twice,
 * inside WorkspaceView — once per side panel — and NOWHERE inside EntityView.
 * So `EntityListPanel` on a rail kind screen ("Tasks", "Docs", …) received no
 * `launch` prop at all, and the quick config fell through to its absent-source
 * defaults: `teammates ?? []` and `projects ?? []`. The teammate select rendered
 * "no teammates available" and the model select rendered "no known models for
 * this tool", because the model list is derived from the SEEDING TEAMMATE's
 * recorded tool and there was no teammate to seed from.
 *
 * The reported symptom was "the dropdowns are often empty, but a refresh fixes
 * them" — and that is exactly what this shape produces without being a race at
 * all. `activeTarget` in GateApp is plain component state initialised to the
 * workspace, so a RELOAD always lands on the three-panel workspace, where the
 * prop WAS passed and the dropdowns work. Navigating back to a kind screen
 * breaks them again. Two screens, one wired and one not, reads from the outside
 * exactly like flaky state.
 *
 * So the construction lives here and both screens call it. A third screen that
 * hosts a list gets the same data by calling the same hook, and cannot
 * accidentally ship the hollow version.
 *
 * WHAT THIS DOES NOT OWN: `onSpawn` and `onFullOptions`. Those are the HOST's
 * verbs — where a spawned session gets opened, and whether a full launch sheet
 * is even mounted on this screen — so each caller supplies its own and the
 * panel's existing disabled-with-reason path covers a host that has neither.
 */
import { useCallback, useMemo } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { newLaunchMutationId, pluginFactsOf, type ProfileResolution } from '../domain';
import { entityPatchInput } from '../authoring';
import { memoryCandidateRow, REFERENCE_KINDS } from '../domain/launch-selection';
import { attachmentsFor } from '../files/port';
import type { LaunchSources } from '../panels';
import type { GateData } from './useGateData';

export interface LaunchPortOptions {
  /** Commits the spawn. Absent ⇒ Launch renders disabled-with-reason (R5 #9). */
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  /** Opens the five-section sheet. Absent ⇒ the escape says it is not here. */
  onFullOptions?: (entityId: string) => void;
}

/**
 * `profileFor` is optional on `LaunchSources` (a host may have no resolver) but
 * this port ALWAYS supplies one, and callers hand it on to surfaces that
 * require it. Narrowing it here keeps them from re-asserting.
 */
export type LaunchPort = LaunchSources & {
  profileFor: NonNullable<LaunchSources['profileFor']>;
};

export function useLaunchPort(data: GateData, options: LaunchPortOptions = {}): LaunchPort {
  const { teammates: sourceTeammates, profiles, projects: sourceProjects, capacity, jev, loadSkillPreview } = data.launch;
  const { loadLaunchDefaults, memories, skillCandidates, referenceCandidates } = data.launch;
  const { onSpawn, onFullOptions } = options;

  /**
   * Resolves the governing profile FOR A TEAMMATE — a resolver, not a value,
   * because `teammate-default` is a step in the chain and switching teammate
   * can change which profile wins.
   */
  const profileFor = useCallback(
    (teamMemberId: string | null): ProfileResolution => {
      const teammate = sourceTeammates.find((candidate) => candidate.id === teamMemberId);
      const teammateDefault = profiles.find((profile) => profile.id === teammate?.defaultProfileId);
      if (teammateDefault) {
        return { profileId: teammateDefault.id, label: teammateDefault.name, source: 'teammate-default' };
      }
      const spaceDefault = profiles.find((profile) => profile.isSpaceDefault);
      if (spaceDefault) {
        return { profileId: spaceDefault.id, label: spaceDefault.name, source: 'space-default' };
      }
      return { profileId: null, label: 'resolved by node at commit', source: 'none' };
    },
    [sourceTeammates, profiles],
  );

  /* The panel's `LaunchTeammateOption` is deliberately NOT this module's
     `LaunchTeammate`: panels/ importing views/ would point the dependency
     backwards, since views compose panels. One map at the seam, no cast on
     either side. */
  const teammates = useMemo(
    () => sourceTeammates.map((t) => ({
      id: t.id,
      label: t.name,
      agentTool: t.agentTool,
      model: t.model,
    })),
    [sourceTeammates],
  );

  const projects = useMemo(
    () => sourceProjects.map((project) => ({
      projectId: project.id,
      name: project.name,
      trusted: project.trusted,
      ...(project.reason ? { untrustedReason: project.reason } : {}),
    })),
    [sourceProjects],
  );

  /**
   * The launch popup's description autofill. The hydrated detail answers when
   * the viewer has one; otherwise a fresh read does — a list row's summary
   * does not carry the body, and the popup must not display a guess.
   */
  const descriptionOf = useCallback(
    async (entityId: string): Promise<string | null> => {
      const read = (detail: unknown): string | null => {
        const description = (detail as { content?: { description?: unknown } } | undefined)
          ?.content?.description;
        return typeof description === 'string' ? description : null;
      };
      /* The cache answers only when it actually CARRIES a description — a
         hydrated detail without content (or from before the latest edit) must
         fall through to a fresh read, not masquerade as "no description". */
      const cached = read(data.detailOf(entityId));
      if (cached !== null) return cached;
      return read(await data.seam.entity(entityId as never).catch(() => undefined));
    },
    [data],
  );

  /**
   * The launch popup's edits — title and/or description — persisted onto the
   * SUBJECT through the same `patchEntity` the inline editors use, in ONE
   * mutation (the task RPC merges per field, so both land or neither). The
   * expected version comes from the hydrated detail when the viewer has one
   * and otherwise from a fresh read — an edit against a version nobody looked
   * up would turn the optimistic check into a guess.
   */
  const onUpdateEntity = useCallback(
    async (entityId: string, edits: { title?: string; description?: string }) => {
      const commands = data.seam.commands;
      if (!commands) throw new Error('This node cannot edit entities, so the edits were not saved.');
      const detail = data.detailOf(entityId)
        ?? (await data.seam.entity(entityId as never).catch(() => undefined));
      const version = detail?.version;
      if (version == null) {
        throw new Error('The task could not be read back, so the edits were not saved.');
      }
      /* Every kind has a Run verb, but only some kinds HAVE a description
         (task, collection, spell, skill). The node refuses a content member
         the subject's kind does not take, so a description is sent only when
         the subject's content carries one — read structurally, no kind
         literal. A detail without content is not evidence either way, and
         keeps today's behaviour. */
      const content = (detail as { content?: unknown }).content;
      const takesDescription = typeof content !== 'object' || content === null || 'description' in content;
      if (edits.title === undefined && !takesDescription) return;
      await commands.patchEntity(entityId as EntityId, entityPatchInput({
        ...(edits.title !== undefined ? { title: edits.title } : {}),
        ...(edits.description !== undefined && takesDescription
          ? { content: { description: edits.description } }
          : {}),
      }, version));
      /* The row's summary re-reads through the normal detail path, so the list
         shows the new name without waiting for the next event. */
      data.refetchDetail(entityId);
    },
    [data],
  );

  /* The ··· menu's plugin list rides on the skill preview the sheet already
     reads, so there is one read of "what this launch could load", not two. */
  const loadInstalledPlugins = useMemo(
    () => loadSkillPreview
      ? async (teamMemberId: string, taskIds?: readonly string[]) => pluginFactsOf(
        await loadSkillPreview({ teamMemberId, ...(taskIds?.length ? { taskIds: taskIds.join(',') } : {}) }),
      )
      : undefined,
    [loadSkillPreview],
  );

  /* The Run composer's per-group context (I9): the same defaults read and add
     pools the launch sheet takes, so the two surfaces send the same thing. */
  const selection = useMemo(
    () => ({
      ...(loadLaunchDefaults ? { load: loadLaunchDefaults } : {}),
      candidates: { memories: memories?.map(memoryCandidateRow), skills: skillCandidates, references: referenceCandidates },
      hydrateReferences: () => { for (const kind of REFERENCE_KINDS) data.ensureKind(kind); },
    }),
    [loadLaunchDefaults, memories, skillCandidates, referenceCandidates, data],
  );

  /* The launch card's attach row: an ANCHOR-LESS upload into the space
     library — the file becomes a reference of this launch, not an attachment
     of the task, so nothing is written onto the subject by attaching. */
  const upload = useMemo(() => {
    const port = attachmentsFor(data.seam, data.spaceId ?? '');
    return port ? (file: File) => port.startUpload(file) : undefined;
  }, [data.seam, data.spaceId]);

  /* Dispatch owns no host behaviour (it opens nothing and navigates nowhere:
     the dispatcher decides later), so unlike `onSpawn` the port wires it
     itself, for every surface. */
  const dispatch = useCallback(
    (subjectId: EntityId, note?: string) => data.seam.commands.dispatch({
      clientMutationId: newLaunchMutationId(),
      spaceId: data.spaceId ?? '',
      subjectId,
      ...(note ? { note } : {}),
    }),
    [data.seam, data.spaceId],
  );

  return useMemo(
    () => ({
      spaceId: data.spaceId ?? '',
      selection,
      teammates,
      projects,
      profileFor,
      mutationId: () => newLaunchMutationId(),
      descriptionOf,
      onUpdateEntity,
      ...(capacity ? { capacity } : {}),
      ...(jev ? { jev } : {}),
      ...(loadInstalledPlugins ? { loadInstalledPlugins } : {}),
      ...(onSpawn ? { onSpawn } : {}),
      ...(onFullOptions ? { onFullOptions } : {}),
      ...(upload ? { upload } : {}),
      ...(data.spaceId ? { dispatch } : {}),
    }),
    [data.spaceId, selection, teammates, projects, profileFor, descriptionOf, onUpdateEntity, capacity, jev, loadInstalledPlugins, onSpawn, onFullOptions, upload, dispatch],
  );
}
