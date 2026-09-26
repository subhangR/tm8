import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextBudgets, ExecutionSpawnInput } from '@tm8/contract';

import {
  accessModeLabel,
  buildSpawnInput,
  canLaunch,
  continuesSubject,
  describeProfile,
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
import {
  JEV_ENTITY_GROUPS,
  JevEntryPoint,
  modelApplyRefusal,
  modelLabel,
  useJevSuggestions,
  type JevApplyHost,
  type JevPort,
} from '../jev';
import { composeLaunchSelection, LAUNCH_SELECTION_GROUPS, type LaunchContextRow } from '../domain/launch-selection';
import {
  appliedReasons,
  BudgetOverride,
  groupMeter,
  LaunchSelectionChips,
  type LaunchRanked,
  type LaunchSelectionBudgetProps,
  useLaunchSelection,
  type LaunchSelectionSources,
} from '../launch-selection';
import type { FileUploadTask } from '../files/upload';
import { LaunchCard, type LaunchCardAttachment, type LaunchCardCandidate } from './LaunchCard';
import { describePicks, readPicks, readRemember, writePicks, writeRemember, type RememberedPicks } from './launch-picks';
import { useLaunchComposerState } from './useLaunchComposerState';
/* The popup mounts WITHOUT the screen, so it carries the stylesheets itself —
   the same mounting-styles-it rule the screen's import states. */
import './new-session.css';

/**
 * THE LAUNCH COMPOSER POPUP — the Run button's configuration, as the launch
 * card (v2, artifact 01a0dd42 rev 4) in a modal layer.
 *
 * It replaces the inline `LaunchQuickConfig` expand behind Run/Coordinate on
 * the task surfaces (owner's ask, 2026-09-07: "when we hit button — we pop up
 * this screen and take inputs"). The RULED interaction survives the reskin:
 * the verb OPENS this; the popup carries the primary Launch that commits.
 * Two clicks to launch, never one.
 *
 * THE BIG TEXTAREA IS INSTRUCTIONS FOR THIS LAUNCH ONLY (owner's ruling on
 * the v2 card, 2026-09-26 — superseding the 2026-09-07 ruling that it was the
 * task's description). It rides the spawn as `promptExtra` and never touches
 * the task. The TASK'S DESCRIPTION is edited from the subject chip in the
 * attach row: it opens holding the task's real body (loaded through
 * `loadDescription`, because a list row's summary does not carry it), and a
 * launch persists an edit onto the task together with a title edit in ONE
 * patch, sequenced BEFORE the spawn so the agent's first turn reads the task
 * as edited.
 *
 * ATTACHED ITEMS ARE CONTEXT, NEVER SUBJECTS — a spawn has one subject. An
 * entity picked in the attach menu, or a file uploaded from this computer,
 * becomes an ADDED reference in the launch's references selection (I9), so it
 * rides `selection.referenceIds` exactly like a reference added from the
 * "Starts with" chip. The node takes docs, artifacts, drawings, files and
 * tasks there; sessions it does not, and the menu says so.
 *
 * DISMISSAL: Escape closes an open menu first, then the advanced drawer,
 * then the popup (the card owns that ordering); the scrim and ✕ close it; and
 * Launch closes the popup ONLY ON SUCCESS (owner's final ruling 2026-09-07) —
 * a refusal keeps it up with the reason floating over the card and a shake,
 * so a failed launch can never be pixel-identical to a successful one.
 *
 * A SESSION SUBJECT IS CONTINUED, NOT EDITED (migration 200, `continuesSubject`):
 * the title field names the NEW session, and nothing is loaded from or saved
 * onto the session being continued.
 */

/** The persona rows as the panels supply them — `LaunchTeammateOption`'s shape. */
/** `ExecutionDispatchInput.note`'s cap in the contract schema. */
const DISPATCH_NOTE_MAX = 4000;

export interface PopupTeammate {
  id: string;
  label: string;
  agentTool?: string | null;
  model?: string | null;
}

export interface LaunchComposerPopupProps {
  /**
   * The entity being run — supplies the assignment link and the session title.
   * `kind` decides whether the launch edits it or continues it.
   */
  subject: { id: string; title: string; kind?: string };
  spaceId: string;
  teammates: readonly PopupTeammate[];
  projects?: readonly LaunchProjectOption[];
  capacity?: LaunchCapacity;
  /** Commits the spawn. ABSENT ⇒ Launch refuses with the unwired reason (R5 #9). */
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  /**
   * The subject's current description, for the subject chip's editor. Absent
   * ⇒ the editor starts empty and an edit still reaches `onSaveSubject`.
   */
  loadDescription?: () => Promise<string | null>;
  /**
   * Persists edits back onto the SUBJECT — the title, the description, or
   * both, in one patch. Runs BEFORE the spawn so the agent's first turn reads
   * the updated task; a refused save stops the launch with its reason.
   * Absent ⇒ the title still names the SESSION, and the description is shown
   * read-only (an edit here would reach nothing).
   */
  onSaveSubject?: (edits: { title?: string; description?: string }) => void | Promise<unknown>;
  onDismiss?: () => void;
  /** The session mode the OPENING VERB commits — `ActionDef.launchMode`. */
  mode?: LaunchMode;
  /** The opening verb's word — `ActionDef.label`. Absent ⇒ "Run". */
  verbLabel?: string;
  /** Fresh id minted when the viewer deliberately submits. */
  newClientMutationId?: () => string;
  /** Compatibility injection for deterministic component tests. */
  clientMutationId?: string;
  /** ✦ Ask Jev (design 01a0cb80 §3.2). Absent ⇒ the button is refused with the reason. */
  jev?: JevPort;
  /** The drawer's Plugins list. Absent ⇒ it says the node cannot list them. */
  loadInstalledPlugins?: LoadInstalledPlugins;
  /**
   * The launch's per-group context (I9): defaults pre-ticked, removals and
   * additions — and the pool the attach menu offers. Absent ⇒ the chips say
   * the defaults are unknown, nothing can be attached, and the launch sends
   * no selection.
   */
  selection?: LaunchSelectionSources;
  /** The resolved Interaction Profile for a teammate, for the drawer's line. */
  profileFor?: (teamMemberId: string | null) => ProfileResolution | undefined;
  /**
   * Uploads one file into the space library (no anchor). Absent ⇒ the attach
   * menu's Files row says this surface cannot upload, and drops do nothing.
   */
  upload?: (file: File) => FileUploadTask;
  /**
   * Hands the SUBJECT to the space's dispatcher instead of launching it
   * (`execution.dispatch`). The dispatcher picks the teammate, model and
   * memories, so nothing on the card applies except the subject edits (saved
   * first, as for Launch) and the instructions, which ride as the
   * dispatcher's `note`. Absent ⇒ no Dispatch button at all.
   */
  onDispatch?: (note?: string) => void | Promise<unknown>;
}

/** An upload in flight or failed — a finished one is a reference by then. */
interface PendingUpload {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'failed';
  error?: string;
  cancel(): void;
}

const kb = (n: number) => (n < 1024 ? `${String(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

let uploadSequence = 0;

export function LaunchComposerPopup({
  subject,
  spaceId,
  teammates,
  projects = [],
  capacity,
  onSpawn,
  loadDescription,
  onSaveSubject,
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
}: LaunchComposerPopupProps) {
  /* The panels' option shapes, adapted ONCE into the composer's vocabulary.
     Absent facts stay absent — no invented owner, no invented path. */
  const teammateRows = useMemo<readonly LaunchTeammate[]>(
    () => teammates.map((t) => ({
      id: t.id,
      name: t.label,
      initial: t.label.charAt(0).toUpperCase(),
      model: t.model ?? '',
      agentTool: t.agentTool ?? '',
      owner: '',
    })),
    [teammates],
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
  const { config, projectOptions, bind, more } = useLaunchComposerState({
    teammates: teammateRows,
    projects: projectRows,
    launchMode: mode,
    ...(loadInstalledPlugins ? { loadInstalledPlugins } : {}),
    taskIds: subjectTaskIds,
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
  /* A Jev Apply that sets the model in the same commit as the teammate
     (Apply all) is the person's latest choice: the teammate's remembered
     model and effort must not land on top of it. The flag lives for one
     commit — the effect after the restore clears it. */
  const jevModelApplied = useRef(false);
  const onPickTeammate = bind.onPickTeammate;
  const pickTeammate = useCallback((id: string | null) => {
    onPickTeammate(id);
    setPickCount((n) => n + 1);
  }, [onPickTeammate]);
  useEffect(() => {
    const picks = readPicks(resolvedTeammate);
    setRestored(picks);
    if (!picks) return;
    const b = restoreRef.current;
    const keepModel = jevModelApplied.current;
    if (picks.model && !keepModel) b.onPickModel(picks.model);
    if (picks.effort !== undefined && !keepModel) b.onEffortChange(picks.effort);
    if (picks.accessMode) b.onAccessModeChange(picks.accessMode);
    if (picks.workdirMode) b.onWorkdirModeChange(picks.workdirMode);
  }, [resolvedTeammate, pickCount]);
  useEffect(() => { jevModelApplied.current = false; });

  /* THE DESCRIPTION, autofilled. `null` means "not answered yet": the load
     seeds it exactly once, and ONLY if the viewer has not started typing —
     text under the cursor is never overwritten by a slow read. `seed` keeps
     what the task actually said, so the save can tell an edit from an echo.

     THE LOAD RUNS ONCE PER MOUNT, deliberately outside the dependency
     machinery: hosts pass `loadDescription` as an inline closure whose
     identity changes every parent render, and a dep on it cancelled the
     in-flight read on the first re-render — the answer arrived, found
     `alive === false`, and was discarded, so the field stayed empty (found
     live, 2026-09-07). The ref pins the closure from the first render;
     `alive` now means "this popup is still mounted", nothing shorter. */
  const continuing = continuesSubject(subject);
  const [draft, setDraftState] = useState<string | null>(loadDescription && !continuing ? null : '');
  const seed = useRef('');
  const loadRef = useRef(continuing ? undefined : loadDescription);
  useEffect(() => {
    const load = loadRef.current;
    if (!load) return;
    let alive = true;
    load()
      .then((text) => {
        if (!alive) return;
        seed.current = text ?? '';
        setDraftState((current) => (current === null ? (text ?? '') : current));
      })
      .catch(() => {
        if (alive) setDraftState((current) => (current === null ? '' : current));
      });
    return () => { alive = false; };
    // Once per mount — see the docblock; the ref carries the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const description = draft ?? '';

  /* This launch's instructions — `promptExtra`, never the task. */
  const [instructions, setInstructions] = useState('');

  /* THE TASK'S TITLE, AS A VALUE — not a placeholder (owner's ask 2026-09-07).
     The field opens holding the real name so "continue" is doing nothing and
     "rename" is ordinary editing; a launch persists an edit to the task. */
  const defaultTitle = launchTitleFor(subject);
  const [title, setTitle] = useState(defaultTitle);

  /* ✦ ASK JEV reads the popup's LIVE text, not the saved task (design §3.2):
     the task description as edited (it is saved before the spawn) plus this
     launch's instructions — together, what the agent will be briefed with. */
  const jevDraft = useMemo(
    () => ({
      title: title.trim() || defaultTitle,
      description: [description, instructions.trim()].filter(Boolean).join('\n\n'),
    }),
    [title, defaultTitle, description, instructions],
  );
  /* THE LAUNCH'S CONTEXT (I9) — the same per-group selection the launch
     sheet holds, as three count chips that each open their group. */
  const selection = useLaunchSelection({
    load: selectionSources?.load,
    teammateId: config.teamMemberId,
    subjectId: subject.id,
    /* The harness this popup launches decides what a skill's entry costs, so
       the meter measures it. The popup picks no Interaction Profile, so none
       is sent and the teammate's own pins. */
    agentTool: config.agentToolId,
  });
  /* A finished upload toggles the selection LATER than the render that
     started it; the ref is the selection as it is now. */
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /* THIS LAUNCH'S BUDGET OVERRIDE — the same `config.contextBudgets` the
     sheet sends. Empty means the profile's budgets hold. */
  const [contextBudgets, setContextBudgets] = useState<ContextBudgets>({});
  const catalog = useMemo(() => modelCatalog(currentNodeKey()), []);

  /* WHERE JEV'S APPLY WRITES: the popup's own selection edits and the card's
     own setters. Nothing reaches the launch except through these, and only on
     a person's Apply click; each Apply has an Undo. The TOOL follows the
     model here (the catalog entry knows it), and `modelRefusal` guarantees
     it is the tool Jev named. */
  const host: JevApplyHost = {
    defaults: selection.defaults,
    edits: selection.edits,
    setEdit: (group, edit, rows) => { selection.setEdit(group, edit, rows); },
    setTeammate: (id) => bind.onPickTeammate(id),
    model: config.model && config.agentToolId
      ? { model: config.model, agentToolId: config.agentToolId, reasoningEffort: config.reasoningEffort }
      : null,
    setModel: (choice) => {
      jevModelApplied.current = true;
      bind.onPickModel(choice.model);
      bind.onEffortChange(choice.reasoningEffort);
    },
    modelRefusal: (suggestion) => modelApplyRefusal(suggestion, { catalog }),
  };
  const jev = useJevSuggestions({
    port: jevPort,
    spaceId,
    subjectId: subject.id,
    teammateId: config.teamMemberId,
    draft: jevDraft,
    ...(config.agentToolId === 'claude-code' || config.agentToolId === 'codex' ? { agentTool: config.agentToolId } : {}),
    host,
    contextBudgets,
  });
  const jevModel = jev.groups.model.status === 'ok' ? jev.groups.model.value : null;
  /* What the context groups' meters and rows read from Jev — the same
     facts the sheet passes: its ok answers (prompt bytes, budget) and, for
     the defaults an Apply removed, why ("over budget", "below Jev's floor"). */
  const jevRanked: LaunchRanked = {};
  const jevReasons: NonNullable<LaunchSelectionBudgetProps['reasons']> = {};
  for (const group of JEV_ENTITY_GROUPS) {
    const state = jev.entity[group].state;
    if (state.status !== 'ok') continue;
    jevRanked[group] = state.value;
    jevReasons[group] = appliedReasons(state.value, jev.applied[group]?.removed, selection, group);
  }
  const contextIndex = jev.contextIndex ?? selection.contextIndex;

  /* THE INITIAL-CONTEXT METER: every group's measured bytes against every
     group's budget. Shown only when all of it is known — a partial sum
     would be a smaller number than the launch really carries. */
  const meters = LAUNCH_SELECTION_GROUPS.map((group) => groupMeter(selection, group, jevRanked[group], contextIndex, contextBudgets));
  const usedTotal = meters.every((m) => m && m.usedBytes !== null)
    ? meters.reduce((sum, m) => sum + (m?.usedBytes ?? 0), 0)
    : null;
  const budgetTotal = meters.every((m) => m && typeof m.budget === 'number')
    ? meters.reduce((sum, m) => sum + (typeof m?.budget === 'number' ? m.budget : 0), 0)
    : null;

  /* ---- ATTACHMENTS: added references, plus uploads still in flight ---- */
  const [uploads, setUploads] = useState<readonly PendingUpload[]>([]);
  /** A finished upload's size, for its chip. */
  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>({});
  const referenceLock = selection.lock('references');
  const addedReferences = selection.added.references.filter((row) => selection.edits.references.added.includes(row.id));
  const defaultReferenceIds = new Set(
    selection.defaults.references.status === 'ready' ? selection.defaults.references.rows.map((r) => r.id) : [],
  );
  const attachments: LaunchCardAttachment[] = [
    ...addedReferences.map((row) => ({
      key: row.id,
      kind: row.kind,
      title: row.title,
      ...(sizes[row.id] !== undefined ? { meta: kb(sizes[row.id]!) } : { meta: row.kind }),
    })),
    ...uploads.map((u) => ({
      key: u.key,
      kind: 'file',
      title: u.name,
      meta: kb(u.size),
      status: u.status,
      ...(u.error ? { error: u.error } : {}),
    })),
  ];
  const referencePool = selectionSources?.candidates.references;
  const candidates: LaunchCardCandidate[] | undefined = referencePool?.filter((row) => row.id !== subject.id).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    state: defaultReferenceIds.has(row.id)
      ? 'default'
      : selection.edits.references.added.includes(row.id) ? 'attached' : 'attachable',
  }));
  const [attachNotice, setAttachNotice] = useState<string | null>(null);

  const toggleCandidate = (id: string) => {
    const row = referencePool?.find((r) => r.id === id);
    if (!row) return;
    setAttachNotice(selection.toggle('references', row));
  };

  const detach = (key: string) => {
    const pending = uploads.find((u) => u.key === key);
    if (pending) {
      pending.cancel();
      setUploads((current) => current.filter((u) => u.key !== key));
      return;
    }
    const row = addedReferences.find((r) => r.id === key);
    if (row) setAttachNotice(selection.toggle('references', row));
  };

  const startUploads = useCallback((files: readonly File[]) => {
    if (!upload) return;
    for (const file of files) {
      uploadSequence += 1;
      const key = `upload:${String(uploadSequence)}`;
      const task = upload(file);
      setUploads((current) => [...current, { key, name: file.name, size: file.size, status: 'uploading', cancel: task.cancel }]);
      task.result.then(
        (done) => {
          /* A file is a reference the node takes (`SPAWN_SELECTION_REFERENCE_KINDS`),
             so the uploaded entity joins the references selection as an addition. */
          const row: LaunchContextRow = {
            id: done.fileEntityId, kind: 'file', title: done.name || file.name, text: null, derived: false, via: null,
          };
          const refused = selectionRef.current.toggle('references', row);
          setSizes((current) => ({ ...current, [done.fileEntityId]: done.sizeBytes }));
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

  const [pending, setPending] = useState(false);
  /** The node's own words when it refuses. Null until it does. */
  const [nodeRefusal, setNodeRefusal] = useState<string | null>(null);
  /** One shake per refusal — cleared by its own animationend. */
  const [shaking, setShaking] = useState(false);

  const uploading = uploads.filter((u) => u.status === 'uploading').length;
  const verdict = canLaunch(config, { projects: projectOptions, capacity });
  const refusal = !onSpawn
    ? 'Launching isn’t connected on this surface yet — the configuration is real; this screen does not dispatch it.'
    : !verdict.ok ? verdict.reason
      /* An edited group's defaults are re-reading: wait, or that group would
         launch on its defaults and drop the person's removals. */
      : selection.launchBlock
        ?? (uploading > 0 ? `Waiting for ${String(uploading)} upload${uploading === 1 ? '' : 's'} to finish before launching.` : null);

  /*
   * DISMISS ONLY ON SUCCESS — the owner's final ruling (2026-09-07, reversing
   * the brief close-on-trigger experiment): a refused launch must not be
   * pixel-identical to a successful one, so failure keeps the card up, prints
   * the node's reason over it, AND SHAKES it so the refusal is felt even
   * before it is read.
   *
   * Save first, then spawn — sequenced so the agent's first turn reads the
   * task as edited, and a refused save stops the launch with its reason
   * rather than launching against edits that did not land.
   */
  const fail = (error: unknown) => {
    setPending(false);
    setNodeRefusal(
      String((error as { message?: string })?.message ?? error)
        || 'the node refused this launch and gave no reason',
    );
    setShaking(true);
  };

  /* The subject edits both verbs save before they hand anything off — onto a
     TASK only. Coordinate on a teammate's profile makes the teammate the
     subject, and a typed session title was PATCHed onto it as its title:
     launching renamed the teammate. For any other subject the title names the
     session and nothing is written back, as for a continued session. A
     subject with no kind is a task (every host passes the row's kind). */
  const savesOntoSubject = !continuing && (subject.kind === undefined || subject.kind === 'task');
  const saveSubject = (sessionTitle: string): Promise<unknown> => {
    const edits: { title?: string; description?: string } = !savesOntoSubject ? {} : {
      ...(sessionTitle !== subject.title ? { title: sessionTitle } : {}),
      /* Only a REAL edit is saved: an untouched autofill (or a load that never
         answered) writes nothing back. Clearing the text IS an edit — it
         empties the task's description deliberately. */
      ...(onSaveSubject && draft !== null && description !== seed.current ? { description } : {}),
    };
    return onSaveSubject && Object.keys(edits).length > 0
      ? Promise.resolve(onSaveSubject(edits))
      : Promise.resolve();
  };

  const commit = () => {
    if (!onSpawn || pending || refusal) return;
    setNodeRefusal(null);
    setPending(true);
    const sessionTitle = title.trim() || defaultTitle;
    const saved = saveSubject(sessionTitle);
    /* PER-GROUP SEND (I9), read at commit time: the ticks are whatever is on
       screen — attachments included, as added references. An untouched group
       is omitted (its defaults load) with a reason; an edited group is its
       exact set. No group edited ⇒ no `selection`. */
    const jevFields = jev.toSpawnFields();
    const promptExtra = instructions.trim();
    const launchFields = {
      ...composeLaunchSelection(selection.outcomes(), jevFields.defaultReasons),
      ...(jevFields.jevRunId ? { jevRunId: jevFields.jevRunId } : {}),
      ...(Object.keys(contextBudgets).length > 0 ? { contextBudgets } : {}),
      ...(promptExtra ? { promptExtra } : {}),
    };
    const launched = { ...config };
    saved
      .then(() => onSpawn(
        buildSpawnInput({
          clientMutationId: newClientMutationId?.() ?? clientMutationId ?? newLaunchMutationId(),
          spaceId,
          config: { ...config, ...launchFields },
          // Still named `taskIds` on the wire; the server maps a non-task
          // subject through `derive_task_for_entity` (064).
          taskIds: subjectTaskIds,
          title: sessionTitle,
        }),
      ))
      .then(() => {
        if (remember && launched.teamMemberId) {
          writePicks(launched.teamMemberId, {
            model: launched.model,
            effort: launched.reasoningEffort,
            accessMode: launched.accessMode,
            ...(launched.target.kind === 'project' && launched.workdirMode ? { workdirMode: launched.workdirMode } : {}),
          });
        }
        onDismiss?.();
      })
      .catch(fail);
  };

  const dispatch = onDispatch
    ? () => {
      if (pending) return;
      setNodeRefusal(null);
      setPending(true);
      const note = instructions.trim();
      /* The contract caps a dispatcher note at 4000 characters; say so here
         rather than let the node answer with a schema error. */
      if (note.length > DISPATCH_NOTE_MAX) {
        fail(new Error(`Dispatch carries at most ${String(DISPATCH_NOTE_MAX)} characters of instructions (these are ${String(note.length)}).`));
        return;
      }
      saveSubject(title.trim() || defaultTitle)
        .then(() => onDispatch(note ? note : undefined))
        .then(() => onDismiss?.())
        .catch(fail);
    }
    : undefined;

  /* THE ONE-LINE SUMMARY: what Launch starts, where. */
  const modeWord = config.mode.replace(/-/g, ' ');
  const workdirName = bind.workdirs.find((w) => w.id === bind.workdirId)?.name ?? '';
  const where = config.target.kind === 'scratch'
    ? { lead: '', name: 'scratch', tail: '' }
    : config.workdirMode === 'worktree'
      ? { lead: 'a worktree of ', name: workdirName, tail: '' }
      : { lead: '', name: workdirName, tail: ' (shared checkout)' };
  const contextCount = attachments.length;
  const summaryText = `Starts a ${modeWord} in ${where.lead}${where.name}${where.tail}${contextCount ? ` · +${String(contextCount)} context` : ''}`;
  const summary = (
    <>
      Starts a <b>{modeWord}</b> in {where.lead}<b>{where.name}</b>{where.tail}
      {contextCount ? ` · +${String(contextCount)} context` : ''}
    </>
  );

  const modelWord = (id: string) => catalog.find((m) => m.model === id)?.label ?? id;
  const restoredLine = restored
    ? describePicks(restored, { model: modelWord, access: accessModeLabel }) || null
    : null;
  const profile = profileFor?.(config.teamMemberId);
  const advancedEdited = config.mode !== (mode ?? 'worker')
    || bind.credential !== null
    || more.githubCredential !== null
    || bind.harnessSurface !== null
    || bind.plugins !== null
    || Object.keys(contextBudgets).length > 0;

  const heading = `${verbLabel ?? 'Run'} configuration`;

  return (
    <div className="nsx-popup nsx-popup--card" role="dialog" aria-modal="true" aria-label={heading} data-testid="launch-quick-config">
      {/* The scrim IS the outside: any click on it is a click away. */}
      <div className="nsx-popup__scrim" onClick={onDismiss} aria-hidden="true" />
      <LaunchCard
        verbLabel={verbLabel ?? 'Run'}
        teammates={bind.teammates}
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
        onClose={() => onDismiss?.()}
        startsWith={
          <>
            <LaunchSelectionChips
              selection={selection}
              candidates={selectionSources?.candidates ?? {}}
              ranked={jevRanked}
              contextIndex={contextIndex}
              budgets={contextBudgets}
              reasons={jevReasons}
            />
            {/* THE ONE JEV ENTRY POINT (Subhang's I9b note) — the same
                collapsed ✦ button and panel the launch sheet mounts. */}
            <JevEntryPoint
              jev={jev}
              modelLabel={jevModel ? modelLabel(jevModel, catalog) : ''}
            />
            <span className="lcd-spacer" />
            {usedTotal ? (
              <>
                {budgetTotal ? (
                  <span
                    className="lcd-meter"
                    data-over={usedTotal > budgetTotal || undefined}
                    title={`initial context: ${kb(usedTotal)} of ${kb(budgetTotal)}`}
                  >
                    <i style={{ width: `${String(Math.min(100, Math.round((usedTotal / budgetTotal) * 100)))}%` }} />
                  </span>
                ) : null}
                <span className="lcd-budget" data-testid="lcd-budget" title="the initial context this launch carries">
                  {budgetTotal ? `${kb(usedTotal)} / ${kb(budgetTotal)}` : kb(usedTotal)}
                </span>
              </>
            ) : null}
          </>
        }
        title={title}
        onTitleChange={setTitle}
        titlePlaceholder={defaultTitle}
        instructions={instructions}
        onInstructionsChange={setInstructions}
        instructionsPlaceholder={continuing
          ? 'Instructions for the new session (optional) — it reads this session’s transcript first…'
          : 'What should this session do? Instructions for this launch only — the task stays as written.'}
        subject={subject}
        continuing={continuing}
        description={draft}
        onDescriptionChange={setDraftState}
        descriptionReadOnly={onSaveSubject
          ? null
          : 'This surface can’t save onto the task, so its description is read-only here.'}
        attachments={attachments}
        onDetach={detach}
        candidates={candidates}
        onToggleCandidate={toggleCandidate}
        attachRefusal={referenceLock ?? attachNotice}
        {...(upload ? { onFiles: startUploads } : {})}
        {...(selectionSources?.hydrateReferences ? { onAttachOpen: selectionSources.hydrateReferences } : {})}
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
        summary={summary}
        summaryText={summaryText}
        {...(dispatch ? { onDispatch: dispatch } : {})}
        onSubmit={commit}
        busy={pending}
        /* A node/save refusal is a NOTICE, not a block: the card stays up
           so the viewer can correct and retry. `canLaunch` / unwired / an
           upload in flight still withhold. */
        refusal={refusal}
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
      />
    </div>
  );
}
