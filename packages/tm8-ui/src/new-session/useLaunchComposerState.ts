import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, LaunchModelEffort, ProjectId } from '@tm8/contract';

import {
  AGENT_CREDENTIAL_PROVIDER,
  CREDENTIAL_PROVIDER_LABEL,
  SCRATCH_OPTION,
  UNTRUSTED_REASON,
  currentNodeKey,
  type LaunchAccessMode,
  type LaunchConfig,
  type LaunchCredentialSource,
  type LaunchMode,
  type LaunchProject,
  type LaunchProjectOption,
  type LaunchPluginFacts,
  type LaunchTeammate,
  type LoadInstalledPlugins,
  type WorkdirMode,
} from '../domain/launch';
import { modelCatalog } from '../domain/model-catalog';
import type { ComposerWorkdir, NewSessionComposerProps } from './NewSessionComposer';

/**
 * THE COMPOSER'S CONFIG STATE — one hook, two hosts.
 *
 * `NewSessionScreen` (the full-screen create) and `LaunchComposerPopup` (the
 * Run popup over an existing task) render the SAME card, and this hook is what
 * keeps their configs from drifting into two different spawn semantics — the
 * same one-builder rule `buildSpawnInput` enforces a layer below.
 *
 * SEEDS, and their reasons:
 *  - effort `'high'` — the OWNER'S RULING (2026-09-07), overturning the
 *    "Default is a real step" seed: the dial always names a real stop, and the
 *    stop it starts on is High. A model that does not take `high` (an unlisted
 *    custom model) sends nothing rather than a stop it would refuse.
 *  - accessMode `'auto'` — the canvas seeds the posture control at Auto,
 *    superseding the earlier invisible `fullAccess` ruling (see the screen).
 *  - mode: THE VERB'S, not state — `launchMode` re-renders live so a host
 *    whose card survives a verb change (the detail panel's Run/Coordinate bar)
 *    commits what the pressed button said. An explicit pick in the ··· menu
 *    overrides it for the life of the mount.
 *  - workdir: the first trusted project, else scratch; working copy `worktree`.
 */
export interface LaunchComposerState {
  /** The spawn config as currently drawn on the card. */
  config: LaunchConfig;
  /** `canLaunch`-shaped project rows, built from the same source as the menu. */
  projectOptions: readonly LaunchProjectOption[];
  /** Spread into `NewSessionComposer` — every config control, wired. */
  bind: Pick<NewSessionComposerProps,
    'workdirs' | 'workdirId' | 'onPickWorkdir'
    | 'workdirMode' | 'onWorkdirModeChange' | 'workdirChoosable'
    | 'teammates' | 'teammateId' | 'onPickTeammate'
    | 'models' | 'model' | 'onPickModel'
    | 'effortStops' | 'effort' | 'onEffortChange'
    | 'accessMode' | 'onAccessModeChange'
    | 'credentialProviderLabel' | 'credential' | 'onCredentialChange'
    | 'harnessApplies' | 'harnessSurface' | 'onHarnessChange'
    | 'installedPlugins' | 'installedPluginsNote' | 'pluginSkillCounts' | 'plugins' | 'onPluginsChange'
    | 'mode' | 'onModeChange'>;
  /**
   * The launch card's extra knobs (launch card v2, artifact 01a0dd42): the
   * worktree's base ref and the GitHub credential. Kept OUT of `bind` so the
   * create screen's composer, which has neither control, is unchanged.
   */
  more: {
    /** Null lets the node choose the base — the honest default. */
    worktreeBaseRef: string | null;
    onWorktreeBaseRefChange(next: string | null): void;
    /** Null is Auto; GitHub's credential is chosen independently of the tool's. */
    githubCredential: LaunchCredentialSource | null;
    onGithubCredentialChange(next: LaunchCredentialSource | null): void;
  };
}

/** Why the Plugins row has nothing to offer, when it does not. */
const PLUGINS_UNAVAILABLE = 'This node cannot list its installed plugins here.';

export function useLaunchComposerState(args: {
  teammates: readonly LaunchTeammate[];
  projects: readonly LaunchProject[];
  /** The opening verb's session mode. Live: a re-render with a new verb wins
      over the seed, but never over a mode the viewer explicitly picked. */
  launchMode?: LaunchMode;
  /** The Claude plugins a launch could load (the ··· Plugins row). */
  loadInstalledPlugins?: LoadInstalledPlugins;
  /** The launch's tasks, so a plugin tick keeps their equipped skills (F3). */
  taskIds?: readonly string[];
}): LaunchComposerState {
  const { teammates, projects, launchMode, loadInstalledPlugins } = args;
  const taskKey = (args.taskIds ?? []).join(',');

  const [teammateId, setTeammateId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [effort, setEffort] = useState<LaunchModelEffort | null>('high');
  const [accessMode, setAccessMode] = useState<LaunchAccessMode | null>('auto');
  const [credential, setCredential] = useState<LaunchCredentialSource | null>(null);
  const [modeOverride, setModeOverride] = useState<LaunchMode | null>(null);
  const [workdirPick, setWorkdirPick] = useState<string | null>(null);
  const [workdirMode, setWorkdirMode] = useState<WorkdirMode>('worktree');
  /* The ··· harness pick. `null` is the teammate's default and sends nothing —
     the credential row's Auto, for the same reason: an unpicked control must
     not overwrite what the persona says. */
  const [harnessSurface, setHarnessSurface] = useState<'minimal' | 'inherit' | null>(null);
  const [plugins, setPlugins] = useState<readonly string[] | null>(null);
  const [worktreeBaseRef, setWorktreeBaseRef] = useState<string | null>(null);
  const [githubCredential, setGithubCredential] = useState<LaunchCredentialSource | null>(null);

  const mode: LaunchMode = modeOverride ?? launchMode ?? 'worker';

  /* AUTO is the roster's front row: the host's data layer orders teammates by
     launch recency, so [0] is the persona this viewer most recently ran. An
     explicit pick whose row has since left the roster falls back to auto
     rather than pinning a ghost — computed, never patched into state. */
  const teammate = (teammateId ? teammates.find((t) => t.id === teammateId) : null)
    ?? teammates[0] ?? null;

  const projectOptions = useMemo<readonly LaunchProjectOption[]>(
    () => projects
      .filter((candidate) => !candidate.scratch)
      .map((candidate) => ({
        projectId: candidate.id as ProjectId,
        name: candidate.name,
        trusted: candidate.trusted,
        ...(candidate.reason ? { untrustedReason: candidate.reason } : {}),
      })),
    [projects],
  );

  /* The workdir menu: scratch first (the canvas order), then every linked
     project — the untrusted ones rendered refused-with-reason rather than
     hidden, so the menu cannot silently disagree with what the space links. */
  const workdirs = useMemo<readonly ComposerWorkdir[]>(() => [
    { id: SCRATCH_OPTION.id, name: SCRATCH_OPTION.label, detail: SCRATCH_OPTION.description },
    ...projects
      .filter((candidate) => !candidate.scratch)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        detail: candidate.detail,
        ...(candidate.trusted ? {} : { disabledReason: candidate.reason ?? UNTRUSTED_REASON }),
      })),
  ], [projects]);

  /* The default target is the first trusted project, and scratch only when
     nothing trusted is linked. A pick whose project has vanished or lost trust
     falls back to that default rather than launching somewhere the menu no
     longer offers. */
  const defaultWorkdirId: string = projectOptions.find((p) => p.trusted)?.projectId ?? SCRATCH_OPTION.id;
  const workdirId = workdirPick !== null
    && workdirs.some((w) => w.id === workdirPick && !w.disabledReason)
    ? workdirPick
    : defaultWorkdirId;

  /* EVERY model this node offers, not the selected persona's tool's subset.
     The catalog rows come WITH their effort stops — `modelsFor` drops
     `efforts`, and the composer's effort dial is drawn over the model's own
     list.

     WHY NOT FILTERED BY TOOL, which is what this was until 2026-09-22. The
     filter made the picker a function of the teammate, and it failed in both
     directions. With NO teammate on the roster there was no tool, so
     `catalogModelsFor` returned [] and the popup rendered an EMPTY model menu
     — the launch card's most important control, blank, with no reason given.
     With a claude-code persona selected it hid every Codex row, so half this
     node's catalog was unreachable from the Run popup unless you first went
     and found a persona that happened to record the other tool. Cross-provider
     routing made that sharply worse: connecting the Groq key buys six models
     that a Claude persona could never be used to reach.

     THE TOOL NOW FOLLOWS THE MODEL instead, below. That is the right direction
     of travel — the catalog entry KNOWS its tool, a teammate merely remembers
     one — and it keeps the pair honest either way, because `canLaunch` still
     refuses a (tool, model) combination the catalog does not pair. */
  const catalog = useMemo(() => modelCatalog(currentNodeKey()), []);
  const models = useMemo(
    () => catalog.map((entry) => ({
      id: entry.model,
      label: entry.label,
      ...(entry.note ? { note: entry.note } : {}),
    })),
    [catalog],
  );
  /* An override survives only while the catalog still offers it. Switching
     teammate clears it entirely (see `pickTeammate`) — the LaunchQuickConfig
     rule: a persona's recorded tool and model travel together, and keeping
     half would mix two personas' settings.

     The last fallback is what makes a rosterless space launchable at all: with
     no persona to inherit from, the card names the catalog's first model
     rather than leaving `model` null and failing `canLaunch` with "this
     teammate has no persisted model" about a teammate that does not exist. */
  const model = modelOverride && catalog.some((entry) => entry.model === modelOverride)
    ? modelOverride
    : teammate?.model ?? catalog[0]?.model ?? null;

  /* THE TOOL, resolved in the order of most-specific fact first:
       1. an explicit model pick carries its own tool — that IS the pick;
       2. otherwise the persona's recorded tool, because a hand-edited teammate
          whose tool and model disagree should keep behaving as it has;
       3. otherwise the resolved model's tool, for a space with no roster.
     Null only when nothing above names one, which `canLaunch` reports. */
  const modelEntry = model ? catalog.find((entry) => entry.model === model) : undefined;
  const toolId = (modelOverride && modelEntry)
    ? modelEntry.agentTool
    : teammate?.agentTool ?? modelEntry?.agentTool ?? null;
  const effortStops = useMemo<readonly LaunchModelEffort[]>(
    () => catalog.find((entry) => entry.model === model)?.efforts ?? [],
    [catalog, model],
  );
  /* A stop the current model does not take is not sent and not shown: the
     spawn carries what the dial displays, or the pair would quietly disagree. */
  const effortPinned = effort !== null && effortStops.includes(effort) ? effort : null;

  /* The credential the ··· menu chooses. Constrained to the providers
     `credentialSources` can actually carry — offering a choice the contract
     would refuse is a guess dressed as a control. */
  const credentialProvider = toolId ? AGENT_CREDENTIAL_PROVIDER[toolId] ?? null : null;
  const credentialKey = credentialProvider === 'anthropic' || credentialProvider === 'openai'
    ? credentialProvider
    : null;
  const credentialProviderLabel = credentialKey ? CREDENTIAL_PROVIDER_LABEL[credentialKey] : null;

  /* THE HARNESS ROWS APPLY TO CLAUDE CODE ONLY — the lean surface is a
     claude-code launch shape, and every other tool ignores it at the node. */
  const harnessApplies = toolId === 'claude-code';
  const [installed, setInstalled] = useState<{ forId: string; facts: LaunchPluginFacts | null } | null>(null);
  const teammateKey = teammate?.id ?? null;
  /* THE LOADER RIDES A REF — the host rebuilds it on every graph event, and
     keying the effect on it re-read the plugins once per event. */
  const loadPluginsRef = useRef(loadInstalledPlugins);
  loadPluginsRef.current = loadInstalledPlugins;
  const canLoadPlugins = loadInstalledPlugins !== undefined;
  /* Keyed on teammate AND tasks: the facts carry the launch's skill defaults,
     which a plugin tick must keep (F3). */
  const factsKey = teammateKey ? `${teammateKey}|${taskKey}` : null;
  useEffect(() => {
    const load = loadPluginsRef.current;
    if (!harnessApplies || !teammateKey || !factsKey || !load) return;
    let live = true;
    load(teammateKey, taskKey ? taskKey.split(',') : [])
      .then((facts) => { if (live) setInstalled({ forId: factsKey, facts }); })
      .catch(() => { if (live) setInstalled({ forId: factsKey, facts: null }); });
    return () => { live = false; };
  }, [harnessApplies, teammateKey, taskKey, factsKey, canLoadPlugins]);
  const facts = installed && installed.forId === factsKey ? installed.facts : null;
  const installedPlugins = facts?.installed ?? null;
  const pluginSkills = facts?.pluginSkills ?? null;
  const pluginSkillCounts = useMemo(
    () => (pluginSkills
      ? Object.fromEntries(Object.entries(pluginSkills.byPlugin).map(([id, ids]) => [id, ids.length]))
      : null),
    [pluginSkills],
  );
  const installedPluginsNote = !loadInstalledPlugins
    ? PLUGINS_UNAVAILABLE
    : installed === null || installed.forId !== factsKey
      ? 'Reading the installed plugins…'
      : installed.facts === null
        ? PLUGINS_UNAVAILABLE
        : installed.facts.installed.length === 0
          ? 'No Claude plugins are installed for this launch.'
          : null;

  const pickTeammate = useCallback((id: string | null) => {
    setTeammateId(id);
    /* Re-seed WHOLE: the new persona's recorded tool and model win, so the
       override is dropped and the effort returns to the High seed. */
    setModelOverride(null);
    setEffort('high');
    /* The plugin pick is about the OLD teammate's defaults; the harness pick
       is a launch-shape choice and survives the switch. */
    setPlugins(null);
  }, []);

  /* The tool's provider and GitHub, each only when picked: an absent key is
     Auto, and an empty object is not sent at all. */
  const credentialSources = useMemo(() => {
    const sources: NonNullable<LaunchConfig['credentialSources']> = {
      ...(credential && credentialKey ? { [credentialKey]: credential } : {}),
      ...(githubCredential ? { github: githubCredential } : {}),
    };
    return Object.keys(sources).length > 0 ? sources : null;
  }, [credential, credentialKey, githubCredential]);

  const config: LaunchConfig = useMemo(() => ({
    teamMemberId: (teammate?.id ?? null) as EntityId | null,
    agentToolId: toolId,
    model,
    reasoningEffort: effortPinned,
    accessMode,
    ...(credentialSources ? { credentialSources } : {}),
    ...(harnessApplies && harnessSurface ? { harnessSurface } : {}),
    ...(harnessApplies && plugins !== null && harnessSurface !== 'inherit'
      ? { plugins, ...(pluginSkills ? { pluginSkills } : {}) }
      : {}),
    mode,
    target: workdirId === SCRATCH_OPTION.id
      ? { kind: 'scratch' as const }
      : { kind: 'project' as const, projectId: workdirId as ProjectId },
    workdirMode,
    ...(workdirMode === 'worktree' && worktreeBaseRef ? { worktreeBaseRef } : {}),
  }), [teammate, toolId, model, effortPinned, accessMode, credentialSources, worktreeBaseRef, harnessApplies, harnessSurface, plugins, pluginSkills, mode, workdirId, workdirMode]);

  return {
    config,
    projectOptions,
    bind: {
      workdirs,
      workdirId,
      onPickWorkdir: setWorkdirPick,
      workdirMode,
      onWorkdirModeChange: setWorkdirMode,
      workdirChoosable: config.target.kind === 'project',
      teammates,
      teammateId,
      onPickTeammate: pickTeammate,
      models,
      model,
      onPickModel: setModelOverride,
      effortStops,
      effort: effortPinned,
      onEffortChange: setEffort,
      accessMode,
      onAccessModeChange: setAccessMode,
      credentialProviderLabel,
      credential,
      onCredentialChange: setCredential,
      harnessApplies,
      harnessSurface,
      onHarnessChange: setHarnessSurface,
      installedPlugins,
      installedPluginsNote,
      pluginSkillCounts,
      plugins,
      onPluginsChange: setPlugins,
      mode,
      onModeChange: setModeOverride,
    },
    more: {
      worktreeBaseRef,
      onWorktreeBaseRefChange: setWorktreeBaseRef,
      githubCredential,
      onGithubCredentialChange: setGithubCredential,
    },
  };
}
