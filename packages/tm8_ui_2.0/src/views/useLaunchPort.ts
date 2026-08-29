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
import type { ExecutionSpawnInput } from '@tm8/contract';
import { newLaunchMutationId, type ProfileResolution } from '../domain';
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
  const { teammates: sourceTeammates, profiles, projects: sourceProjects, capacity } = data.launch;
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

  return useMemo(
    () => ({
      spaceId: data.spaceId ?? '',
      teammates,
      projects,
      profileFor,
      mutationId: () => newLaunchMutationId(),
      ...(capacity ? { capacity } : {}),
      ...(onSpawn ? { onSpawn } : {}),
      ...(onFullOptions ? { onFullOptions } : {}),
    }),
    [data.spaceId, teammates, projects, profileFor, capacity, onSpawn, onFullOptions],
  );
}
