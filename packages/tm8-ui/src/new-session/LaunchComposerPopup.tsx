import { McpPicker } from '../mcp/McpPicker';
import type { McpSelection } from '../mcp/port';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  ContextBudgets,
  CredentialsServiceKeysStatusView,
  EntityId,
  ExecutionDispatchResult,
  ProjectId,
  ExecutionSpawnInput,
  SpawnSelectionGroup,
} from '@tm8/contract';

import {
  accessModeLabel,
  buildSpawnInput,
  canLaunch,
  continuesSubject,
  describeProfile,
  effortLabel,
  launchTitleFor,
  newLaunchMutationId,
  type LaunchCapacity,
  type LaunchMode,
  type LaunchProject,
  type LaunchProjectOption,
  type LaunchTeammate,
  type LoadInstalledPlugins,
  type ProfileResolution,
} from '../domain/launch';
import { modelCatalog } from '../domain/model-catalog';
import { currentNodeKey } from '../domain/launch';
import { CRAFT_KIND } from '../domain/craft';
import {
  formatRunCost,
  JEV_ENTITY_GROUPS,
  JEV_UNWIRED_REASON,
  modelApplyRefusal,
  modelLabel,
  openJevKeySettings,
  useJevSuggestions,
  type JevApplyHost,
  type JevPort,
} from '../jev';
import { composeLaunchSelection, type LaunchContextRow } from '../domain/launch-selection';
import {
  BudgetOverride,
  REASON_WORDS,
  useLaunchSelection,
  type LaunchSelectionSources,
} from '../launch-selection';
import type { FileUploadTask } from '../files/upload';
import { LaunchCardV3, VERBS, aKind, type JevButton, type LaunchCandidate, type LaunchVerb } from './LaunchCardV3';
import { addToEdits, buildStrip, STRIP_KINDS, stripKindOf, type StripJev, type StripRow } from './launch-strip';
import { clearDraft, readDraft, writeDraft } from './launch-draft';
import type { LaunchStarted } from './launch-started';
import { describePicks, readPicks, readRemember, writePicks, writeRemember, type RememberedPicks } from './launch-picks';
import { useLaunchComposerState } from './useLaunchComposerState';
import { useOverlayHost } from '../kit/useOverlayHost';
import { rosterForLaunchScope, useCraftLaunchScope } from './launch-scope';
/* The popup mounts WITHOUT the screen, so it carries the stylesheets itself —
   the same mounting-styles-it rule the screen's import states. */
import './new-session.css';

/**
 * THE LAUNCH COMPOSER POPUP — the Run button's configuration, as the launch
 * card v3 (mock 01a0df08, owner's decisions on task 01a0dee8) in a modal
 * layer. It replaced the v2 card outright (owner, form 01a0df25).
 *
 * The verb OPENS this; Launch (or ⌘↵) and Dispatch commit it on their FIRST
 * press (owner, task 01a182d2: "remove second launch, and show it as loading
 * page"). The card itself is the statement of what goes, so it draws only
 * what this launch carries — no preview step repeating it with "None." rows.
 *
 * THE HANDOFF (`onLaunchStarted`): a host that draws its own progress takes
 * the launch the moment it is pressed and the card dismisses at once; any
 * other host keeps the card up, collapsed to one "Launching …" line, until
 * the node answers.
 *
 * THE CARD IS A LAYER OVER THE TASK. The task's title and description are
 * read here (the subject chip's peek) and edited on the task — nothing is
 * written back from the card. The notes box rides the spawn as `promptExtra`
 * (and the dispatch as its `note`); a DRAFT of it is kept per subject until
 * a launch succeeds (owner: close keeps a draft).
 *
 * THE STRIP IS THE SELECTION. Its type groups are a view over the three
 * selection groups (`launch-strip.ts`); ticks, Attach picks and uploads are
 * ordinary selection edits and ride `selection.*Ids` exactly as before.
 *
 * ✦ JEV asks for the strip's groups and its picks land TICKED (owner); Undo
 * reverts only Jev's own adds and removals. A teammate change clears them.
 *
 * IDEMPOTENT RETRIES: one client mutation id per distinct launch (and per
 * distinct dispatch), so a retry after a timeout replays the node's ledger
 * rather than starting a second session.
 *
 * DISMISSAL: Escape closes a menu, then the drawer, then the popup (the
 * shell owns that order); the scrim closes an open menu first, then the
 * popup; ✕ closes it; a commit closes it ONLY ON SUCCESS (or at once when
 * the host took the launch over) — a refusal keeps it up with the reason and a
 * shake (owner's ruling 2026-09-07).
 */

/** Where a press is: see `phase` in the popup. */
type PressPhase = 'idle' | 'launching' | 'dispatching' | 'detached';

/**
 * How long a press holds the card before ✕ and Escape may DETACH it: a
 * spawn that hangs to its 180 s timeout must not lock the person behind the
 * scrim, but a normal one answers well inside this.
 */
export const DETACH_AFTER_MS = 8000;

/** `ExecutionDispatchInput.note`'s cap in the contract schema. */
const DISPATCH_NOTE_MAX = 4000;

/** The persona rows as the panels supply them — `LaunchTeammateOption`'s shape. */
export interface PopupTeammate {
  id: string;
  label: string;
  agentTool?: string | null;
  model?: string | null;
  /** `team_members.mode`; absent on a node that doesn't project it. */
  mode?: string | null;
}

export interface LaunchComposerPopupProps {
  /**
   * The entity being run — supplies the assignment link and the session title.
   * `kind` decides whether the launch works it or continues it.
   */
  subject: { id: string; title: string; kind?: string };
  spaceId: string;
  teammates: readonly PopupTeammate[];
  projects?: readonly LaunchProjectOption[];
  capacity?: LaunchCapacity;
  /**
   * A refusal that arrives after the person DETACHED the card (closed it
   * mid-flight, after DETACH_AFTER_MS): the card is gone, so the host shows
   * it (a toast). Absent ⇒ it reaches the person only through the session
   * list.
   */
  onDetachedRefusal?(reason: string): void;
  /** Commits the spawn. ABSENT ⇒ Launch refuses with the unwired reason (R5 #9). */
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  /** Called synchronously when Launch is pressed, before the node answers. Return true to take over the progress display: the popup dismisses at once and the host owns everything after (progress, success, failure). Return false/undefined to keep the in-card "Launching…" state until onSpawn settles (today's behaviour, kept for hosts that do not implement it). */
  onLaunchStarted?(launch: LaunchStarted): boolean | void;
  /** The subject's current description, for the read-only peek. */
  loadDescription?: () => Promise<string | null>;
  /** The viewer may edit the task: the peek offers "Edit on the task ↗" (closing onto it). */
  canEditSubject?: boolean;
  onDismiss?: () => void;
  /** The session mode the OPENING VERB commits — `ActionDef.launchMode`. The card's verb switch starts on it. */
  mode?: LaunchMode;
  /** The opening verb's word — `ActionDef.label`. Absent ⇒ "Run". */
  verbLabel?: string;
  /** Mints a client mutation id; called once per distinct launch. */
  newClientMutationId?: () => string;
  /** Compatibility injection for deterministic component tests. */
  clientMutationId?: string;
  /** ✦ Jev (design 01a0cb80). Absent ⇒ ✦ is greyed with the reason. */
  jev?: JevPort;
  /** The drawer's Plugins list. Absent ⇒ it says the node cannot list them. */
  loadInstalledPlugins?: LoadInstalledPlugins;
  /**
   * The launch's per-group context (I9): defaults pre-ticked, removals and
   * additions — and the pool Attach offers. Absent ⇒ the strip says the
   * defaults are unknown, nothing can be attached, and no selection is sent.
   */
  selection?: LaunchSelectionSources;
  /** The resolved Interaction Profile for a teammate, for the drawer's line. */
  profileFor?: (teamMemberId: string | null) => ProfileResolution | undefined;
  /** Uploads one file into the space library (no anchor). Absent ⇒ Attach says this surface cannot upload. */
  upload?: (file: File) => FileUploadTask;
  /**
   * Hands the SUBJECT to the space's dispatcher (`execution.dispatch`) with
   * the notes as its `note`; the dispatcher picks everything else. Absent ⇒
   * no Dispatch button. The result's `delivery` is read: 'undelivered' is
   * shown as a warning, never as success.
   */
  onDispatch?: (note?: string, clientMutationId?: string) => void | Promise<unknown>;
  /**
   * `credentials.serviceKeys.status` — whether ✦ has a TypeSafe key to use
   * (the member's own, else the node's) BEFORE the first click. Absent ⇒ ✦
   * shows in colour until an ask comes back no_key.
   */
  jevKeyStatus?: () => Promise<CredentialsServiceKeysStatusView>;
  /**
   * Sessions working on the subject created since a time. After a spawn
   * TIMEOUT the card asks this before offering a retry: a retry while the
   * first attempt is still in flight starts a second session (the ledger
   * replays only a finished one). Absent ⇒ the card can't check, and says so.
   */
  sessionsSince?: (subjectId: string, since: string) => Promise<readonly { id: string; title: string }[]>;
}

/** An upload in flight or failed — a finished one is a strip row by then. */
interface PendingUpload {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'failed';
  error?: string;
  cancel(): void;
  /** Kept so a failed upload can be retried. */
  file: File;
}

let uploadSequence = 0;

/** One idempotency key per distinct payload: the same payload again reuses its key. */
function keyLedger(mint: () => string) {
  let last: { payload: string; key: string } | null = null;
  return {
    keyFor(payload: string): string {
      if (!last || last.payload !== payload) last = { payload, key: mint() };
      return last.key;
    },
  };
}

const IN_FULL_REFUSAL =
  'Sending more in full needs a node change that isn’t built yet (an in-full channel separate from the task). Add it to the strip instead — it goes in as a context index entry.';

const TEAMMATES_UNSENT = 'Not sent yet — the node can’t take teammates in a launch’s selection (coming with selection.teammateIds).';

const NO_KEY_WORDS = 'Jev is off — no key. Add your TypeSafe key in Settings → Agent credentials.';

const groupOf = (row: { kind: string }): SpawnSelectionGroup => (
  row.kind === 'memory' ? 'memories' : row.kind === 'skill' ? 'skills' : 'references'
);


/**
 * The notes box's placeholder. Continuing reads the old transcript first; a
 * DESIGN says what Run does with it (Craft → Designs, D4: the agent creates
 * what its graph pages describe); anything else keeps its own text.
 */
export function notesPlaceholderFor(subjectKind: string | undefined, continuing: boolean): string {
  if (continuing) return 'Notes for the new session (optional) — it reads this session’s transcript first…';
  if (subjectKind === CRAFT_KIND) {
    return 'Run this craft: the agent creates what its graph pages describe. Notes or extra context (optional)…';
  }
  return 'Notes or extra context for this launch — the task stays as written.';
}

export function LaunchComposerPopup({
  subject,
  spaceId,
  teammates,
  projects = [],
  capacity,
  onSpawn,
  onLaunchStarted,
  onDetachedRefusal,
  loadDescription,
  canEditSubject = false,
  onDismiss,
  mode,
  verbLabel,
  newClientMutationId,
  clientMutationId,
  jev: jevPort,
  loadInstalledPlugins,
  selection: selectionSources,
  profileFor,
  upload,
  onDispatch,
  jevKeyStatus,
  sessionsSince,
}: LaunchComposerPopupProps) {
  const overlay = useOverlayHost();
  /* The panels' option shapes, adapted ONCE into the composer's vocabulary.
     Absent facts stay absent — no invented owner, no invented path. */
  /* In a craft, Auto is the Crafter (launch-scope.tsx). */
  const launchScope = useCraftLaunchScope();
  const teammateRows = useMemo<readonly LaunchTeammate[]>(
    () => rosterForLaunchScope(teammates, launchScope).map((t) => ({
      id: t.id,
      name: t.label,
      initial: t.label.charAt(0).toUpperCase(),
      model: t.model ?? '',
      agentTool: t.agentTool ?? '',
      owner: '',
    })),
    [teammates, launchScope],
  );
  const projectRows = useMemo<readonly LaunchProject[]>(
    () => projects.map((p) => ({
      id: p.projectId,
      name: p.name,
      trusted: p.trusted,
      detail: '',
      ...(p.untrustedReason ? { reason: p.untrustedReason } : {}),
    })),
    [projects],
  );

  /* The spawn's `taskIds`, so a plugin tick's exact skill set keeps what the
     subject equips (F3). Memoized: the hook keys its read on it. */
  const subjectTaskIds = useMemo(() => [subject.id], [subject.id]);
  /* PLUGIN FACTS ARE READ WHEN THE ··· DRAWER FIRST OPENS — the only place the
     Plugins row is drawn — never at open (lane E). */
  const [pluginsWanted, setPluginsWanted] = useState(false);
  const wantPlugins = useCallback(() => setPluginsWanted(true), []);
  const { config, projectOptions, bind, more } = useLaunchComposerState({
    teammates: teammateRows,
    projects: projectRows,
    launchMode: mode,
    ...(loadInstalledPlugins ? { loadInstalledPlugins } : {}),
    taskIds: subjectTaskIds,
    initialAccessMode: null,
    pluginsWanted,
  });

  /* PER-TEAMMATE REMEMBERED PICKS: when the resolved teammate changes (the
     first render included), its last launch's model, effort, access and
     checkout are put back. A teammate switch re-seeds the persona's own
     defaults first (`pickTeammate`); this runs after and wins. */
  const [remember, setRemember] = useState(readRemember);
  const [restored, setRestored] = useState<RememberedPicks | null>(null);
  const resolvedTeammate = config.teamMemberId;
  const restoreRef = useRef(bind);
  restoreRef.current = bind;
  /* Re-picking the teammate already resolved changes no id, so the effect
     below would not re-run while `pickTeammate` had already re-seeded the
     persona's defaults: the picks were wiped under a "restored: …" line
     (found live on a real node). Every pick from the menu re-runs it. */
  const [pickCount, setPickCount] = useState(0);
  const onPickTeammate = bind.onPickTeammate;
  /* A teammate picked BY HAND is the person's: Jev no longer overrides it
     (Decision 7 amendment) — its pick waits in the menu instead. */
  const teammateTouched = useRef(false);
  const pickTeammate = useCallback((id: string | null) => {
    teammateTouched.current = true;
    onPickTeammate(id);
    setPickCount((n) => n + 1);
  }, [onPickTeammate]);
  useEffect(() => {
    const picks = readPicks(resolvedTeammate);
    setRestored(picks);
    if (!picks) return;
    const b = restoreRef.current;
    if (picks.model) b.onPickModel(picks.model);
    if (picks.effort !== undefined) b.onEffortChange(picks.effort);
    if (picks.accessMode) b.onAccessModeChange(picks.accessMode);
    if (picks.workdirMode) b.onWorkdirModeChange(picks.workdirMode);
  }, [resolvedTeammate, pickCount]);

  /* THE DESCRIPTION, for the read-only peek. Loaded once per mount — hosts
     pass the loader as an inline closure (see the v2 note in git history:
     a dep on it cancelled the read on every parent render). */
  const continuing = continuesSubject(subject);
  const [description, setDescription] = useState<string | null>(loadDescription && !continuing ? null : '');
  const loadRef = useRef(continuing ? undefined : loadDescription);
  useEffect(() => {
    const load = loadRef.current;
    if (!load) return;
    let alive = true;
    load().then(
      (text) => { if (alive) setDescription(text ?? ''); },
      () => { if (alive) setDescription(''); },
    );
    return () => { alive = false; };
  }, []);

  /* THE NOTES — `promptExtra`, never the task — and their per-subject draft. */
  const [draft] = useState(() => readDraft(subject.id));
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const defaultTitle = launchTitleFor(subject);

  /* THE LAUNCH'S CONTEXT (I9). */
  const selection = useLaunchSelection({
    load: selectionSources?.load,
    teammateId: config.teamMemberId,
    subjectId: subject.id,
    /* The harness this popup launches decides what a skill's entry costs. */
    agentTool: config.agentToolId,
  });
  /* A finished upload toggles the selection LATER than the render that
     started it; the ref is the selection as it is now. */
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /* A DRAFT'S STRIP EDITS come back once the defaults are read. */
  const draftApplied = useRef(!draft?.edits);
  useEffect(() => {
    if (draftApplied.current || !draft?.edits) return;
    if (JEV_ENTITY_GROUPS.some((g) => selection.defaults[g].status === 'loading')) return;
    draftApplied.current = true;
    for (const group of JEV_ENTITY_GROUPS) {
      const edit = draft.edits[group];
      if (edit.added.length || edit.removed.length) selection.setEdit(group, edit, draft.added?.[group] ?? []);
    }
  }, [draft, selection]);

  /* THIS LAUNCH'S BUDGET OVERRIDE. Empty means the profile's budgets hold. */
  const [contextBudgets, setContextBudgets] = useState<ContextBudgets>({});
  const catalog = useMemo(() => modelCatalog(currentNodeKey()), []);

  /* WHERE JEV'S APPLY WRITES: the selection, and — the owner kept Jev's
     teammate and model suggestions (answers 01a0df30) — the card's own
     setters, for surfaces that surface them. */
  const host: JevApplyHost = {
    defaults: selection.defaults,
    edits: selection.edits,
    setEdit: (group, edit, rows) => { selection.setEdit(group, edit, rows); },
    setTeammate: (id) => bind.onPickTeammate(id),
    model: config.model && config.agentToolId
      ? { model: config.model, agentToolId: config.agentToolId, reasoningEffort: config.reasoningEffort }
      : null,
    setModel: (choice) => {
      bind.onPickModel(choice.model);
      bind.onEffortChange(choice.reasoningEffort);
    },
    modelRefusal: (suggestion) => modelApplyRefusal(suggestion, { catalog }),
  };
  const jevDraft = useMemo(
    () => ({ title: defaultTitle, description: [description ?? '', notes.trim()].filter(Boolean).join('\n\n') }),
    [defaultTitle, description, notes],
  );
  const jev = useJevSuggestions({
    port: jevPort,
    spaceId,
    subjectId: subject.id,
    teammateId: config.teamMemberId,
    draft: jevDraft,
    ...(config.agentToolId === 'claude-code' || config.agentToolId === 'codex' ? { agentTool: config.agentToolId } : {}),
    host,
    contextBudgets,
    reaskOnChange: false,
  });
  const contextIndex = jev.contextIndex ?? selection.contextIndex;

  /* ---- UPLOADS: in flight or failed; a finished one is a strip row ---- */
  const [uploads, setUploads] = useState<readonly PendingUpload[]>([]);
  const startUploads = useCallback((files: readonly File[]) => {
    if (!upload) return;
    for (const file of files) {
      uploadSequence += 1;
      const key = `upload:${String(uploadSequence)}`;
      const task = upload(file);
      setUploads((current) => [...current, { key, name: file.name, size: file.size, status: 'uploading', cancel: task.cancel, file }]);
      task.result.then(
        (done) => {
          /* A file is a reference the node takes (`SPAWN_SELECTION_REFERENCE_KINDS`),
             so the uploaded entity joins the references selection as an addition
             — the strip's Files group. */
          const row: LaunchContextRow = {
            id: done.fileEntityId, kind: 'file', title: done.name || file.name, text: null, derived: false, via: null,
          };
          const refused = selectionRef.current.toggle('references', row);
          setUploads((current) => (refused
            ? current.map((u) => (u.key === key ? { ...u, status: 'failed' as const, error: refused } : u))
            : current.filter((u) => u.key !== key)));
        },
        (error: unknown) => {
          const reason = String((error as { message?: string })?.message ?? error);
          setUploads((current) => current.map((u) => (u.key === key ? { ...u, status: 'failed' as const, error: reason } : u)));
        },
      );
    }
  }, [upload]);
  const removeUpload = (key: string) => {
    uploads.find((u) => u.key === key)?.cancel();
    setUploads((current) => current.filter((u) => u.key !== key));
  };
  const retryUpload = (key: string) => {
    const failed = uploads.find((u) => u.key === key);
    if (!failed) return;
    setUploads((current) => current.filter((u) => u.key !== key));
    startUploads([failed.file]);
  };

  /**
   * THE PRESS, as one named state. `moveTo` is the only transition.
   *   idle         the card is editable.
   *   launching    a press is in flight: the card is the one-line row.
   *   dispatching  the same, for Dispatch.
   *   detached     the person closed the card mid-flight (after
   *                DETACH_AFTER_MS): the press continues without it.
   * A press leaves idle; a refusal, a timeout or an undelivered dispatch
   * returns to idle (or, detached, goes to `onDetachedRefusal`); success, or
   * a host taking the handoff, dismisses and returns to idle. The ref
   * mirrors it SYNCHRONOUSLY, so a second press (or an Escape) in the same
   * frame already sees the first one.
   */
  const [phase, setPhase] = useState<PressPhase>('idle');
  const phaseNow = useRef<PressPhase>('idle');
  const moveTo = (next: PressPhase) => { phaseNow.current = next; setPhase(next); };
  const pending = phase !== 'idle';
  /* A CHANGED SUBJECT is a new card GENERATION: a press belongs to the
     generation that made it, and its late answer (success, refusal,
     timeout) is ignored once the card has moved on. */
  const generation = useRef(0);
  const subjectSeen = useRef(subject.id);
  useEffect(() => {
    if (subjectSeen.current === subject.id) return;
    subjectSeen.current = subject.id;
    generation.current += 1;
    moveTo('idle');
  }, [subject.id]);
  /** `act`, run only while the press made in generation `gen` is still this card's. */
  const ifCurrent = <A extends unknown[]>(gen: number, act: (...args: A) => void) => (...args: A) => {
    if (gen === generation.current) act(...args);
  };
  /* DETACHABLE once a press has been in flight DETACH_AFTER_MS. */
  const [detachable, setDetachable] = useState(false);
  const detachableNow = useRef(false);
  useEffect(() => {
    detachableNow.current = false;
    setDetachable(false);
    if (phase !== 'launching' && phase !== 'dispatching') return;
    const timer = setTimeout(() => { detachableNow.current = true; setDetachable(true); }, DETACH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  /* DISMISSAL: idle closes. In flight, the spawn still answers this card
     (success closes it, a refusal reopens it with the reason), so Escape,
     the scrim and ✕ do nothing — until DETACH_AFTER_MS, after which they
     detach it: the card closes and the press continues without it. */
  const dismiss = () => {
    if (phaseNow.current === 'idle') { onDismiss?.(); return; }
    if (phaseNow.current === 'detached' || !detachableNow.current) return;
    moveTo('detached');
    onDismiss?.();
  };
  /** A refusal for the person: on the card, or — detached — to the host. */
  const refuse = (reason: string) => {
    if (phaseNow.current === 'detached') { onDetachedRefusal?.(reason); moveTo('idle'); return; }
    moveTo('idle');
    setNodeRefusal(reason);
    setShaking(true);
  };
  /** The node's own words when it refuses. Null until it does. */
  const [nodeRefusal, setNodeRefusal] = useState<string | null>(null);
  /** One shake per refusal — cleared by its own animationend. */
  const [shaking, setShaking] = useState(false);
  /* A spawn that timed out: checking for its session, found one, found none, or can't tell. */
  const [timedOut, setTimedOut] = useState<null | 'checking' | 'found' | 'none' | 'unknown'>(null);
  const openedAt = useRef(new Date().toISOString());

  const [mcpSelections, setMcpSelections] = useState<McpSelection[] | undefined>();
  const [mcpReady, setMcpReady] = useState(true);
  /* TODO(lane F, task 01a182d2-9b15-79f3-8651-ab2af823b525): McpPicker's
     `onCount(n)` replaces the DrawnCount probe below, and lane F deletes it
     in that change; until then the card counts the connector rows drawn. */
  const [mcpCount, setMcpCount] = useState(0);
  const spawnKey = useRef(keyLedger(() => newClientMutationId?.() ?? clientMutationId ?? newLaunchMutationId()));
  const dispatchKey = useRef(keyLedger(newLaunchMutationId));

  const uploading = uploads.filter((u) => u.status === 'uploading').length;
  const verdict = canLaunch(config, { projects: projectOptions, capacity });
  const refusal = timedOut === 'checking'
    ? 'Checking whether the launch that timed out started…'
    : timedOut === 'found'
      ? 'A session from this launch is already working on the task.'
      : !onSpawn
    ? 'Launching isn’t connected on this surface yet — the configuration is real; this screen does not dispatch it.'
    : !verdict.ok ? verdict.reason
      /* An edited group's defaults are re-reading: wait, or that group would
         launch on its defaults and drop the person's removals. */
      /* Not ready with nothing drawn is the catalog still being read; not
         ready with rows drawn is a picked connector with no account. Lane
         F's gate sentence replaces both after its picker swap. */
      : (!mcpReady
        ? (mcpCount === 0 ? 'Reading connectors…' : 'Connectors: choose a connected account for each connector you picked.')
        : null) ?? selection.launchBlock
        ?? (uploading > 0 ? `Waiting for ${String(uploading)} upload${uploading === 1 ? '' : 's'} to finish before launching.` : null);

  /* DRAFT: kept while the card is open, cleared by a successful commit. */
  const committed = useRef(false);
  const draftNow = useRef({ notes, edits: selection.edits, added: selection.added });
  draftNow.current = { notes, edits: selection.edits, added: selection.added };
  useEffect(() => () => {
    if (committed.current) return;
    const d = draftNow.current;
    writeDraft(subject.id, { notes: d.notes, edits: d.edits, added: d.added });
  }, [subject.id]);

  const fail = (error: unknown) => {
    refuse(String((error as { message?: string })?.message ?? error) || 'the node refused this launch and gave no reason');
  };
  const succeed = () => {
    committed.current = true;
    clearDraft(subject.id);
    /* Detached, the card is already closed. */
    if (phaseNow.current !== 'detached') onDismiss?.();
    moveTo('idle');
  };

  /* A SPAWN THAT TIMED OUT MAY HAVE STARTED. Until the node dedupes an
     in-flight retry, the card looks for the session before offering one. */
  const afterTimeout = (gen: number) => {
    if (phaseNow.current === 'detached') {
      refuse('The node didn’t answer in time — the launch may have started. Look at the task’s sessions before launching again.');
      return;
    }
    moveTo('idle');
    setShaking(true);
    if (!sessionsSince) {
      setTimedOut('unknown');
      setNodeRefusal('The node didn’t answer in time — the launch may have started. This surface can’t check, so look at the task’s sessions before launching again.');
      return;
    }
    setTimedOut('checking');
    setNodeRefusal('The node didn’t answer in time — the launch may have started. Checking…');
    sessionsSince(subject.id, openedAt.current).then(
      ifCurrent(gen, (found: readonly { id: string; title: string }[]) => {
        if (found.length > 0) {
          setTimedOut('found');
          setNodeRefusal(`It started: “${found[0]!.title}” is working on this task. Nothing more to launch.`);
        } else {
          setTimedOut('none');
          setNodeRefusal('No session started on this task. Launch again to retry.');
        }
      }),
      ifCurrent(gen, () => {
        setTimedOut('unknown');
        setNodeRefusal('The node didn’t answer in time, and checking for the session failed too — look at the task’s sessions before launching again.');
      }),
    );
  };

  /** What the host is handed at the press: read off the very input sent. */
  const launchStarted = (input: ExecutionSpawnInput): LaunchStarted => {
    const mate = input.teamMemberId ? teammates.find((t) => t.id === input.teamMemberId) : undefined;
    const projectId = input.projectId ?? null;
    return {
      clientMutationId: input.clientMutationId,
      subjectId: subject.id as EntityId,
      title: input.title ?? defaultTitle,
      verb,
      teammate: input.teamMemberId ? { id: input.teamMemberId as EntityId, name: mate?.label ?? input.teamMemberId } : null,
      model: input.model ?? null,
      effort: input.reasoningEffort ?? null,
      accessMode: input.accessMode ?? null,
      workdir: projectId === null || input.workdir?.mode === 'scratch'
        ? { kind: 'scratch' }
        : {
          kind: 'project',
          projectId: projectId as ProjectId,
          mode: input.workdir?.mode === 'worktree' ? 'worktree' : 'project',
          baseRef: input.workdir?.mode === 'worktree' ? input.workdir.baseRef ?? null : null,
        },
      notes: notes.trim(),
    };
  };

  const commit = () => {
    if (!onSpawn || phaseNow.current !== 'idle' || refusal || dispatcherRefusal || timedOut === 'checking' || timedOut === 'found') return;
    setTimedOut(null);
    setNodeRefusal(null);
    /* PER-GROUP SEND (I9), read at commit time: an untouched group is
       omitted (its defaults load) with a reason; an edited group is its
       exact set. No group edited ⇒ no `selection`. */
    const jevFields = jev.toSpawnFields();
    const promptExtra = notes.trim();
    const launchFields = {
      ...composeLaunchSelection(selection.outcomes(), jevFields.defaultReasons),
      ...(jevFields.jevRunId ? { jevRunId: jevFields.jevRunId } : {}),
      ...(Object.keys(contextBudgets).length > 0 ? { contextBudgets } : {}),
      ...(promptExtra ? { promptExtra } : {}),
    };
    const launched = { ...config };
    const inputWith = (id: string) => ({
      ...buildSpawnInput({
        clientMutationId: id,
        spaceId,
        config: { ...config, ...launchFields, mcpSelections },
        // Still named `taskIds` on the wire; the server maps a non-task
        // subject through `derive_task_for_entity` (064).
        taskIds: subjectTaskIds,
        title: defaultTitle,
      }),
      /* A Run inside a craft is ABOUT the craft: the node writes session
         -[about]-> craft in the spawn, which lets the session manage that
         craft's tabs (L3). Outside a craft the key is absent. */
      ...(launchScope ? { aboutEntityId: launchScope.craftId as EntityId } : {}),
    });
    /* ONE KEY PER UNCHANGED LAUNCH: a retry of the same launch reuses its
       key, so the node's ledger replays the session instead of starting a
       second one; any change to what is launched mints a fresh key. */
    const input = inputWith(spawnKey.current.keyFor(JSON.stringify(inputWith(''))));
    const keepPicks = () => {
      if (remember && launched.teamMemberId) {
        writePicks(launched.teamMemberId, {
          model: launched.model,
          effort: launched.reasoningEffort,
          accessMode: launched.accessMode,
          ...(launched.target.kind === 'project' && launched.workdirMode ? { workdirMode: launched.workdirMode } : {}),
        });
      }
    };
    /* ONE PRESS, ONE SPAWN: the phase leaves idle before anything else, and
       `run` is the only call of `onSpawn` (on the next microtask, so the
       handoff below is still asked first). */
    moveTo('launching');
    const gen = generation.current;
    /* THE HANDOFF: asked synchronously, before the node is. A host that
       throws is a refused launch, and nothing is sent. */
    let taken = false;
    try {
      taken = onLaunchStarted?.(launchStarted(input)) === true;
    } catch (error) {
      fail(error);
      return;
    }
    const run = Promise.resolve().then(() => onSpawn(input));
    /* A host that takes it owns the progress and the failure, so the spawn's
       errors are not drawn here — the card is gone by the time they arrive. */
    if (taken) {
      run.then(keepPicks, () => { /* the host's to show */ });
      succeed();
      return;
    }
    run
      .then(ifCurrent(gen, () => {
        keepPicks();
        succeed();
      }), ifCurrent(gen, (error: unknown) => {
        const e = error as { code?: string; message?: string };
        if (e?.code === 'upstream_unavailable' || /did not answer within/.test(String(e?.message ?? ''))) afterTimeout(gen);
        else fail(error);
      }));
  };

  /* ---- THE VERB: the KIND of session ---- */
  const verb: LaunchVerb = VERBS.some((v) => v.id === config.mode) ? config.mode as LaunchVerb : 'worker';
  /* UNDER DISPATCH the picker offers only dispatcher-capable teammates —
     the server's own predicate (`team_members.mode = 'dispatcher'`,
     resolveDispatcherSession), read off the summary's projected `mode`. A
     node that doesn't project it can't be filtered honestly, so it refuses. */
  const modesKnown = teammates.length > 0 && teammates.every((t) => t.mode !== undefined);
  const canDispatch = (id: string | null) => teammates.find((t) => t.id === id)?.mode === 'dispatcher';
  const roster = verb === 'dispatcher' && modesKnown
    ? bind.teammates.filter((t) => canDispatch(t.id))
    : bind.teammates;
  const verbRef = useRef(verb);
  useEffect(() => {
    const entered = verbRef.current !== verb;
    verbRef.current = verb;
    if (!entered || verb !== 'dispatcher' || !modesKnown || canDispatch(config.teamMemberId)) return;
    const first = teammates.find((t) => t.mode === 'dispatcher');
    if (first) bind.onPickTeammate(first.id);
    // Runs on a verb change only; the roster and setter are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verb]);
  const dispatcherRefusal = verb !== 'dispatcher'
    ? null
    : !modesKnown
      ? 'This node doesn’t say which teammates can run as a dispatcher, so a dispatcher can’t be launched from here.'
      : roster.length === 0
        ? 'No teammate in this space can run as a dispatcher.'
        : !canDispatch(config.teamMemberId) ? 'Pick a teammate that can run as a dispatcher.' : null;
  const accessLock = verb === 'dispatcher'
    ? 'A dispatcher always runs with full access — the node forces it for dispatchers, whatever is picked here.'
    : null;

  /* ---- ✦ JEV ---- */
  const [jevKey, setJevKey] = useState<'yes' | 'none' | 'unknown'>('unknown');
  const keyStatusRef = useRef(jevKeyStatus);
  useEffect(() => {
    const read = keyStatusRef.current;
    if (!read) return;
    let alive = true;
    read().then((view) => {
      if (!alive || view.store === 'absent') return;
      const key = view.keys.find((k) => k.provider === 'typesafe');
      setJevKey(key && (key.connected || key.nodeFallback) ? 'yes' : 'none');
    }, () => { /* unknown stays unknown: ✦ stays in colour until an ask says no_key */ });
    return () => { alive = false; };
  }, []);

  /* ✦ asks for the strip's groups and APPLIES what comes back once every
     asked group has answered (owner: Jev's picks land ticked). */
  const [jevApplying, setJevApplying] = useState(false);
  /** A teammate change Jev made (or its Undo) — not the person's, so it doesn't clear Jev's picks. */
  const tookJevTeammate = useRef<string | null>(null);
  const askedGroups = [...JEV_ENTITY_GROUPS, 'teammates'] as const;
  const stripGroupStates = askedGroups.map((g) => jev.groups[g].status).join('|');
  useEffect(() => {
    if (!jevApplying) return;
    if (askedGroups.some((g) => jev.groups[g].status === 'asking')) return;
    setJevApplying(false);
    for (const group of JEV_ENTITY_GROUPS) if (jev.groups[group].status === 'ok') jev.applyGroup(group);
    /* JEV'S TOP TEAMMATE IS AUTO-APPLIED (owner, via the v3 coordinator);
       Undo reverts it. The strip picks above were ranked for the teammate
       asked with — until the node ranks for Jev's own pick
       (`rankedForTeamMemberId`), they stay as ranked. */
    const pick = jev.teammatePick;
    if (pick && verbRef.current !== 'dispatcher' && !teammateTouched.current && pick.entityId !== config.teamMemberId && !jev.teammateRefusal) {
      tookJevTeammate.current = pick.entityId;
      jev.applyTeammate();
    }
    // The group states are the trigger; `jev` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jevApplying, stripGroupStates]);
  const askJev = () => {
    if (jev.askRefusal) return;
    setJevCleared(false);
    setJevApplying(true);
    /* All five groups: the strip's three auto-apply; the teammate and model
       wait in their menus until clicked (owner, form 01a0df34-2cd4). */
    /* Under DISPATCH a dispatcher gets the whole roster: no teammate ranks. */
    jev.ask(verbRef.current === 'dispatcher' ? ['model', ...JEV_ENTITY_GROUPS] : undefined);
  };
  /* Undo reverts ONLY what Jev's Apply decided (the hook restores those rows
     and keeps later hand edits to others). */
  const undoJev = () => {
    for (const group of JEV_ENTITY_GROUPS) if (jev.applied[group]) jev.undo(group);
    if (jev.applied.teammate && !jev.replaced.teammate) {
      tookJevTeammate.current = jev.applied.teammate.previous;
      jev.undo('teammate');
    }
  };
  /* A TEAMMATE CHANGE CLEARS JEV'S PICKS (owner): they were ranked for the
     previous teammate. The person's own edits stay. */
  const [jevCleared, setJevCleared] = useState(false);
  const lastTeammate = useRef(config.teamMemberId);
  const undoRef = useRef(undoJev);
  undoRef.current = undoJev;
  const jevAppliedRef = useRef(jev.applied);
  jevAppliedRef.current = jev.applied;
  useEffect(() => {
    if (lastTeammate.current === config.teamMemberId) return;
    lastTeammate.current = config.teamMemberId;
    if (tookJevTeammate.current === config.teamMemberId) { tookJevTeammate.current = null; return; }
    if (JEV_ENTITY_GROUPS.some((g) => jevAppliedRef.current[g])) setJevCleared(true);
    undoRef.current();
  }, [config.teamMemberId]);

  /* ✦ JEV SUGGESTS rows at the top of the teammate and model menus. Undo
     Jev's changes leaves a clicked one alone: the person applied it. */
  /** Jev's changes the launch still carries: an applied group, or its teammate unless the person replaced it. */
  function jevStillApplied(): boolean {
    return JEV_ENTITY_GROUPS.some((g) => jev.applied[g]) || Boolean(jev.applied.teammate && !jev.replaced.teammate);
  }

  /* JEV'S TEAMMATES (Decision 7): its top pick is the launch teammate while
     the person hasn't picked one (else a click-to-apply row in the menu);
     the other suggested teammates land in the strip's Teammates group —
     drawn, but not sent until the node takes `selection.teammateIds`. */
  const jevTeamPick = jev.teammatePick;
  const jevTeammate = jevTeamPick && verb !== 'dispatcher' ? {
    label: jevTeamPick.title,
    reason: jevTeamPick.header.whenToUse ?? jevTeamPick.header.summary ?? `${jevTeamPick.level} fit`,
    current: config.teamMemberId === jevTeamPick.entityId,
    refusal: jev.teammateRefusal,
    onApply: () => { tookJevTeammate.current = jevTeamPick.entityId; jev.applyTeammate(); },
  } : null;
  const jevTeammateRows: StripRow[] = verb !== 'dispatcher' && jev.groups.teammates.status === 'ok' && !jev.groups.teammates.value.noFit && !jevCleared
    && jevStillApplied()
    ? jev.groups.teammates.value.items
      .filter((i) => i.suggested && i.entityId !== jevTeamPick?.entityId && i.entityId !== config.teamMemberId)
      .map((i) => ({
        id: i.entityId as StripRow['id'], kind: 'team_member', title: i.title, group: 'teammates' as const, ticked: true,
        source: 'jev' as const, via: null, jev: 'picked' as const, jevWhy: `${i.level} · ${i.score.toFixed(1)}`,
        unsent: TEAMMATES_UNSENT,
      }))
    : [];
  const jevOtherTeammates = jevTeammateRows.length;
  const jevModelValue = jev.groups.model.status === 'ok' ? jev.groups.model.value : null;
  const jevModel = jevModelValue ? {
    label: modelLabel(jevModelValue, catalog),
    reason: jevModelValue.reasons.join(' · ') || jevModelValue.workKind,
    current: jev.modelMatches,
    refusal: jev.modelRefusal,
    onApply: () => { jev.applyModel(); },
  } : null;
  const jevFailures = JEV_ENTITY_GROUPS.flatMap((group) => {
    const st = jev.groups[group];
    if (st.status !== 'failed' || st.reason === 'no_key') return [];
    return [{ group, reason: String(st.reason).replace(/_/g, ' '), onRetry: () => { setJevApplying(true); jev.retry(group); } }];
  });
  const jevApplied = jevStillApplied();
  const noKey = jevKey === 'none' || jev.state === 'unavailable';
  const jevButton: JevButton = {
    status: !jevPort || noKey || jev.askRefusal
      ? 'off'
      : jevApplying || JEV_ENTITY_GROUPS.some((g) => jev.groups[g].status === 'asking')
        ? 'busy'
        : jevApplied || jevFailures.length > 0 ? 'done' : jevCleared ? 'stale' : 'ready',
    reason: !jevPort ? JEV_UNWIRED_REASON : noKey ? NO_KEY_WORDS : jev.askRefusal,
    picked: JEV_ENTITY_GROUPS.reduce((n, g) => n + jev.entity[g].carried.added.length, 0),
    leftOut: JEV_ENTITY_GROUPS.reduce((n, g) => n + jev.entity[g].carried.removed.length, 0),
    cost: jev.run ? formatRunCost(jev.run) : null,
    suggests: jevModel && !jevModel.current ? 'a model' : null,
    teammate: jev.applied.teammate && !jev.replaced.teammate
      ? teammates.find((t) => t.id === jev.applied.teammate?.teamMemberId)?.label ?? null
      : null,
    otherTeammates: jevOtherTeammates,
    failures: jevFailures,
    onAsk: askJev,
    onAskAgain: () => { undoJev(); askJev(); },
    onUndo: undoJev,
    ...(jevPort && noKey ? { onFixKey: () => { onDismiss?.(); openJevKeySettings(); } } : {}),
  };

  /* ---- THE STRIP: the selection's three groups as seven type groups ---- */
  const jevWhy: Record<string, string> = {};
  for (const group of JEV_ENTITY_GROUPS) {
    const st = jev.entity[group].state;
    if (st.status !== 'ok') continue;
    for (const item of st.value.items) {
      jevWhy[item.entityId] = item.reason ? REASON_WORDS[item.reason] : `${item.level} · ${item.score.toFixed(1)}`;
    }
  }
  const stripJev: StripJev = {
    carried: { memories: jev.entity.memories.carried, skills: jev.entity.skills.carried, references: jev.entity.references.carried },
    /* Everything Jev's Apply added, ticked or not: an unticked pick stays a
       row (under Attach → Suggested), one click from coming back. */
    picked: {
      memories: jev.entity.memories.applied?.added ?? [],
      skills: jev.entity.skills.applied?.added ?? [],
      references: jev.entity.references.applied?.added ?? [],
    },
    why: jevWhy,
  };
  const strip = buildStrip({ defaults: selection.defaults, edits: selection.edits, added: selection.added, jev: stripJev, teammates: jevTeammateRows });
  const stripRows = strip.flatMap((g) => g.rows);
  const stripLoading = JEV_ENTITY_GROUPS.some((g) => selection.defaults[g].status === 'loading');
  const stripLock = stripLoading ? null : JEV_ENTITY_GROUPS.map((g) => selection.lock(g)).find(Boolean) ?? null;
  const [stripNotice, setStripNotice] = useState<string | null>(null);
  const tickRow = (row: StripRow) => {
    if (row.group === 'teammates') { setStripNotice(row.unsent ?? TEAMMATES_UNSENT); return; }
    setStripNotice(selection.toggle(row.group, { id: row.id, kind: row.kind, title: row.title, text: null, derived: false, via: null }));
  };
  const addRows = (rows: readonly LaunchContextRow[]): string | null => {
    if (rows.some((r) => r.kind === 'team_member')) return TEAMMATES_UNSENT;
    const byGroup = addToEdits(selection.defaults, selection.edits, rows, groupOf);
    for (const [group, change] of Object.entries(byGroup)) {
      if (!change) continue;
      const refused = selection.setEdit(group as SpawnSelectionGroup, change.edit, change.rows);
      if (refused) return refused;
    }
    return null;
  };

  /* ---- SENT IN FULL: drawn, refused until the node has a channel ---- */
  const [inFull, setInFull] = useState<readonly LaunchContextRow[]>([]);

  /* ---- THE + AND ATTACH POOL: memories, skills and references read in,
     plus every strip row (an unticked default picked again is ticked back).
     The task itself and sessions are never offered. ---- */
  const pools = selectionSources?.candidates;
  const poolsKnown = Boolean(pools && (pools.memories || pools.skills || pools.references));
  const tickedIds = new Set<string>(stripRows.filter((r) => r.ticked).map((r) => r.id));
  const fullIds = new Set<string>(inFull.map((r) => r.id));
  const byId = new Map<string, { row: LaunchContextRow; group: StripRow['group'] }>();
  /* Attach's Teammates type: the roster minus the launch teammate — not sendable yet. */
  for (const t of verb === 'dispatcher' ? [] : teammates) {
    if (t.id !== config.teamMemberId) byId.set(t.id, { row: { id: t.id as StripRow['id'], kind: 'team_member', title: t.label, text: null, derived: false, via: null }, group: 'teammates' });
  }
  for (const group of JEV_ENTITY_GROUPS) for (const row of pools?.[group] ?? []) byId.set(row.id, { row, group });
  for (const r of stripRows) {
    if (!byId.has(r.id)) byId.set(r.id, { row: { id: r.id, kind: r.kind, title: r.title, text: null, derived: false, via: null }, group: r.group });
  }
  const candidates: LaunchCandidate[] | undefined = poolsKnown
    ? [...byId.values()]
      .filter(({ row }) => row.id !== subject.id && row.kind !== 'work_session')
      .map(({ row, group }) => ({
        row,
        kind: stripKindOf(group, row.kind),
        inLaunch: fullIds.has(row.id) ? 'full' as const : tickedIds.has(row.id) ? 'strip' as const : null,
        ...(group === 'teammates' ? { unsent: TEAMMATES_UNSENT } : {}),
      }))
      /* In the strip's order — files first — so "All" reads like the strip. */
      .sort((a, b) => STRIP_KINDS.findIndex((d) => d.kind === a.kind) - STRIP_KINDS.findIndex((d) => d.kind === b.kind))
    : undefined;

  /* ---- DISPATCH ---- */
  const note = notes.trim();
  const dispatchRefusal = verb !== 'worker'
    ? `Dispatch can’t ask for ${aKind(verb)} yet — the node’s dispatch takes no session kind, so its dispatcher would start a worker. Launch it yourself, or switch to RUN.`
    : note.length > DISPATCH_NOTE_MAX
      ? `Dispatch carries at most ${String(DISPATCH_NOTE_MAX)} characters of notes (these are ${String(note.length)}).`
      : null;
  const dispatch = () => {
    if (!onDispatch || phaseNow.current !== 'idle' || dispatchRefusal) return;
    setNodeRefusal(null);
    moveTo('dispatching');
    const gen = generation.current;
    Promise.resolve()
      .then(() => onDispatch(note || undefined, dispatchKey.current.keyFor(`${subject.id}\n${note}`)))
      .then(ifCurrent(gen, (result: unknown) => {
        const r = result as Partial<ExecutionDispatchResult> | undefined;
        if (r?.delivery === 'undelivered') {
          /* Not a success: the request is stored on the task, but no
             dispatcher received it. Say so and keep the card up. */
          refuse(`The request is stored on the task, but the node couldn’t deliver it to ${r.dispatcherSpawned ? 'the dispatcher it just started' : 'the dispatcher'}. Dispatching again sends the same request.`);
          return;
        }
        succeed();
      }), ifCurrent(gen, fail));
  };
  const modelWord = (id: string) => catalog.find((m) => m.model === id)?.label ?? id;
  /* THE LAUNCHING LINE: the card collapses to what was pressed, not a greyed form. */
  const teammateWord = teammates.find((t) => t.id === config.teamMemberId)?.label ?? null;
  const launchingLine = phase === 'idle' || phase === 'detached'
    ? null
    : phase === 'dispatching'
      ? `Dispatching ${subject.title}`
      : [
        `Launching ${defaultTitle}`,
        teammateWord,
        config.model ? modelWord(config.model) : null,
        config.reasoningEffort ? effortLabel(config.reasoningEffort) : null,
      ].filter(Boolean).join(' · ');

  const restoredLine = restored
    ? describePicks(restored, { model: modelWord, access: accessModeLabel }) || null
    : null;
  const profile = profileFor?.(config.teamMemberId);
  const advancedEdited = bind.credential !== null
    || more.githubCredential !== null
    || bind.harnessSurface !== null
    || bind.plugins !== null
    || Object.keys(contextBudgets).length > 0;

  const heading = `${verbLabel ?? 'Run'} configuration`;

  /* Portalled out of the trigger's subtree so the scrim covers the whole
     shell — see `useOverlayHost`. */
  if (!overlay.host) return <span ref={overlay.marker} hidden />;

  return createPortal(
    <div className="nsx-popup nsx-popup--card" role="dialog" aria-modal="true" aria-label={heading} data-testid="launch-quick-config">
      <LaunchCardV3
        scrim
        onAdvancedOpen={wantPlugins}
        connectors={{ count: mcpCount, node: (
          /* §10.5: the launch grid, with D4's note — `Full` restores plugins
             and skills, never the launcher's personal Claude connectors. */
          <DrawnCount onCount={setMcpCount}><McpPicker
            teamMemberId={config.teamMemberId ?? undefined}
            targetId={subject.id}
            value={mcpSelections}
            onChange={setMcpSelections}
            onReady={setMcpReady}
            disabled={pending}
            layout="grid"
            notice={bind.harnessSurface === 'inherit'
              ? 'Full restores plugins and skills, not your Claude connectors. Connectors come from this list.'
              : 'Personal Claude app connectors aren’t loaded, whatever the harness.'}
          /></DrawnCount>
        ) }}
        verbLabel={verbLabel ?? 'Run'}
        verb={verb}
        onVerbChange={(next) => bind.onModeChange(next)}
        accessLock={accessLock}
        teammates={roster}
        teammateId={bind.teammateId}
        onPickTeammate={pickTeammate}
        remember={remember}
        onRememberChange={(on) => { setRemember(on); writeRemember(on); }}
        restoredLine={restoredLine}
        workdirs={bind.workdirs}
        workdirId={bind.workdirId}
        onPickWorkdir={bind.onPickWorkdir}
        workdirMode={bind.workdirMode}
        onWorkdirModeChange={bind.onWorkdirModeChange}
        workdirChoosable={bind.workdirChoosable ?? true}
        worktreeBaseRef={more.worktreeBaseRef}
        onWorktreeBaseRefChange={more.onWorktreeBaseRefChange}
        {...(capacity ? { capacity } : {})}
        onClose={dismiss}
        {...(upload ? { onFiles: startUploads } : {})}
        subject={subject}
        continuing={continuing}
        description={description}
        {...(canEditSubject && onDismiss && !continuing ? { onEditSubject: dismiss } : {})}
        inFull={{
          items: inFull.map((r) => ({ id: r.id, kind: r.kind, title: r.title, bytes: null, over: false })),
          refusal: IN_FULL_REFUSAL,
          onAdd: (row) => setInFull((now) => (now.some((r) => r.id === row.id) ? now : [...now, row])),
          onRemove: (id) => setInFull((now) => now.filter((r) => r.id !== id)),
          onToIndex: (id) => setInFull((now) => now.filter((r) => r.id !== id)),
        }}
        notes={notes}
        onNotesChange={setNotes}
        notesPlaceholder={notesPlaceholderFor(subject.kind, continuing)}
        strip={strip}
        stripRefusal={stripLock ?? stripNotice}
        stripLoading={stripLoading}
        onTick={tickRow}
        onAddRows={addRows}
        candidates={candidates}
        {...(selectionSources?.hydrateReferences ? { onAttachOpen: selectionSources.hydrateReferences } : {})}
        uploads={uploads.map((u) => ({ key: u.key, name: u.name, status: u.status, ...(u.error ? { error: u.error } : {}) }))}
        onDismissUpload={removeUpload}
        onRetryUpload={retryUpload}
        jev={jevButton}
        dispatch={onDispatch ? {
          refusal: dispatchRefusal,
          /* No read of the space's dispatcher sessions exists yet: unknown. */
          dispatchers: null,
          onDispatch: () => dispatch(),
        } : null}
        onLaunch={commit}
        launching={launchingLine}
        {...(detachable ? { onDetach: dismiss } : {})}
        models={catalog.map((entry) => ({
          id: entry.model,
          label: entry.label,
          provider: entry.provider,
          agentTool: entry.agentTool,
          ...(entry.note ? { note: entry.note } : {}),
        }))}
        model={bind.model}
        onPickModel={bind.onPickModel}
        effortStops={bind.effortStops}
        effort={bind.effort}
        onEffortChange={bind.onEffortChange}
        accessMode={bind.accessMode}
        onAccessModeChange={bind.onAccessModeChange}
        onSubmit={commit}
        busy={pending}
        refusal={refusal ?? dispatcherRefusal}
        notice={nodeRefusal}
        shaking={shaking}
        onShakeEnd={() => setShaking(false)}
        mode={bind.mode}
        onModeChange={bind.onModeChange}
        profileLine={profile ? describeProfile(profile) : null}
        credentialProviderLabel={bind.credentialProviderLabel}
        credential={bind.credential}
        onCredentialChange={bind.onCredentialChange}
        githubCredential={more.githubCredential}
        onGithubCredentialChange={more.onGithubCredentialChange}
        harnessApplies={bind.harnessApplies ?? false}
        harnessSurface={bind.harnessSurface ?? null}
        {...(bind.onHarnessChange ? { onHarnessChange: bind.onHarnessChange } : {})}
        installedPlugins={bind.installedPlugins ?? null}
        installedPluginsNote={bind.installedPluginsNote ?? null}
        pluginSkillCounts={bind.pluginSkillCounts ?? null}
        plugins={bind.plugins ?? null}
        {...(bind.onPluginsChange ? { onPluginsChange: bind.onPluginsChange } : {})}
        budget={<BudgetOverride value={contextBudgets} onChange={setContextBudgets} />}
        advancedEdited={advancedEdited}
        jevModel={jevModel}
        jevTeammate={jevTeammate}
      />
    </div>,
    overlay.host,
  );
}


/**
 * What in the picker is worth drawing the connectors block for: a connector
 * row, or an error/problem line (role=alert, with its Retry) — something to
 * act on. Its loading line is not.
 *
 * TODO(lane F, task 01a182d2-9b15-79f3-8651-ab2af823b525): this couples the
 * card to classes in lane F's files. It is deleted by F's swap to
 * `McpPicker onCount` in #1390, which merges after this.
 */
const MCP_DRAWN_SELECTOR = '.mcp-toggles__rows > li, [role="alert"]';

/**
 * How many things the picker drew that are worth the block (MCP_DRAWN_SELECTOR):
 * 0 while it draws none. A stand-in for lane F's `McpPicker onCount`. The
 * child stays MOUNTED at 0: it reads its catalog and readiness while hidden.
 */
function DrawnCount({ onCount, children }: { onCount(n: number): void; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => onCount(el.querySelectorAll(MCP_DRAWN_SELECTOR).length);
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [onCount]);
  return <span ref={ref} style={{ display: 'contents' }}>{children}</span>;
}
