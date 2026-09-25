import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExecutionSpawnInput } from '@tm8/contract';

import {
  buildSpawnInput,
  canLaunch,
  continuesSubject,
  launchTitleFor,
  newLaunchMutationId,
  type LaunchCapacity,
  type LaunchMode,
  type LaunchProject,
  type LaunchProjectOption,
  type LaunchTeammate,
  type LoadInstalledPlugins,
} from '../domain/launch';
import { modelCatalog } from '../domain/model-catalog';
import { currentNodeKey } from '../domain/launch';
import {
  AskJevButton,
  JevReviewDrawer,
  JevStrip,
  modelApplyRefusal,
  modelLabel,
  useJevSuggestions,
  type JevPort,
} from '../jev';
import { composeSelection } from '../domain/launch-selection';
import { LaunchSelectionDisclosure, useLaunchSelection, type LaunchSelectionSources } from '../launch-selection';
import { NewSessionComposer } from './NewSessionComposer';
import { useLaunchComposerState } from './useLaunchComposerState';
/* The popup mounts WITHOUT the screen, so it carries the stylesheet itself —
   the same mounting-styles-it rule the screen's import states. */
import './new-session.css';

/**
 * THE LAUNCH COMPOSER POPUP — the Run button's configuration, as the canvas
 * card in a modal tile.
 *
 * It replaces the inline `LaunchQuickConfig` expand behind Run/Coordinate on
 * the task surfaces (owner's ask, 2026-09-07: "when we hit button — we pop up
 * this screen and take inputs"). The RULED interaction survives the reskin:
 * the verb OPENS this; the popup carries the primary Launch that commits.
 * Two clicks to launch, never one.
 *
 * THE TEXTAREA IS THE TASK'S DESCRIPTION (owner's ruling 2026-09-07) — not a
 * separate "extra context" side-channel. It opens holding the task's real
 * body (loaded through `loadDescription`, because a list row's summary does
 * not carry it), edits like any field, and a launch persists the edit onto
 * the task together with a title edit in ONE patch. The agent then reads the
 * UPDATED description as its first-turn briefing, because the save is
 * sequenced before the spawn. This mirrors the create screen, where the same
 * textarea BECOMES `content.description` — one field, one meaning, both hosts.
 *
 * DISMISSAL: Escape closes an open menu first, then the popup (the composer
 * owns that ordering); the scrim click closes it; and Launch closes the tile
 * ONLY ON SUCCESS (owner's final ruling 2026-09-07) — a refusal keeps it up
 * with the reason under the card and a shake, so a failed launch can never
 * be pixel-identical to a successful one.
 *
 * A SESSION SUBJECT IS CONTINUED, NOT EDITED (migration 200, `continuesSubject`):
 * the title field names the NEW session and the textarea carries instructions
 * for it as `promptExtra`; neither is loaded from nor saved onto the session
 * being continued.
 */

/** The persona rows as the panels supply them — `LaunchTeammateOption`'s shape. */
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
   * The subject's current description, for the body field's autofill. Absent
   * ⇒ the field starts empty and an edit still reaches `onSaveSubject`.
   */
  loadDescription?: () => Promise<string | null>;
  /**
   * Persists edits back onto the SUBJECT — the title, the description, or
   * both, in one patch. Runs BEFORE the spawn so the agent's first turn reads
   * the updated task; a failed save is logged and the launch proceeds (the
   * tile is already closed, and a silently-stopped launch would be worse).
   * Absent ⇒ the edits still shape the SESSION, and the task keeps its record.
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
  /** The ··· menu's Plugins list. Absent ⇒ the row says the node cannot list them. */
  loadInstalledPlugins?: LoadInstalledPlugins;
  /**
   * The launch's per-group context (I9): defaults pre-ticked, removals and
   * additions. Absent ⇒ the Context line says the defaults are unknown, and
   * the launch sends no selection.
   */
  selection?: LaunchSelectionSources;
}

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
}: LaunchComposerPopupProps) {
  /* The panels' option shapes, adapted ONCE into the composer's vocabulary.
     Absent facts stay absent — no invented owner, no invented path — and the
     composer renders only the facts a row actually carries. */
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
  const { config, projectOptions, bind } = useLaunchComposerState({
    teammates: teammateRows,
    projects: projectRows,
    launchMode: mode,
    ...(loadInstalledPlugins ? { loadInstalledPlugins } : {}),
    taskIds: subjectTaskIds,
  });

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

  /* THE TASK'S TITLE, AS A VALUE — not a placeholder (owner's ask 2026-09-07).
     The field opens holding the real name so "continue" is doing nothing and
     "rename" is ordinary editing; a launch persists an edit to the task. */
  const defaultTitle = launchTitleFor(subject);
  const [title, setTitle] = useState(defaultTitle);

  /* ✦ ASK JEV reads the popup's LIVE text, not the saved task (design §3.2):
     the popup saves these edits before it spawns, so the draft is what the
     agent will actually be briefed with. Editing either after an answer makes
     the state stale. */
  const jevDraft = useMemo(
    () => ({ title: title.trim() || defaultTitle, description }),
    [title, defaultTitle, description],
  );
  const jev = useJevSuggestions({
    port: jevPort,
    spaceId,
    subjectId: subject.id,
    teammateId: config.teamMemberId,
    draft: jevDraft,
  });
  /* THE LAUNCH'S CONTEXT (I9) — the same per-group selection the launch
     sheet holds, behind one collapsed line. */
  const selection = useLaunchSelection({
    load: selectionSources?.load,
    teammateId: config.teamMemberId,
    subjectId: subject.id,
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const jevModel = jev.groups.model.status === 'ok' ? jev.groups.model.value : null;
  const jevCatalog = jevModel ? modelCatalog(currentNodeKey()) : [];

  const [pending, setPending] = useState(false);
  /** The node's own words when it refuses. Null until it does. */
  const [nodeRefusal, setNodeRefusal] = useState<string | null>(null);
  /** One shake per refusal — cleared by its own animationend. */
  const [shaking, setShaking] = useState(false);

  const verdict = canLaunch(config, { projects: projectOptions, capacity });
  const refusal = !onSpawn
    ? 'Launching isn’t connected on this surface yet — the configuration is real; this screen does not dispatch it.'
    : verdict.ok ? null : verdict.reason;

  /*
   * DISMISS ONLY ON SUCCESS — the owner's final ruling (2026-09-07, reversing
   * the brief close-on-trigger experiment): a refused launch must not be
   * pixel-identical to a successful one, so failure keeps the tile up, prints
   * the node's reason under the card, AND SHAKES the tile so the refusal is
   * felt even before it is read.
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

  const commit = () => {
    if (!onSpawn || pending) return;
    setNodeRefusal(null);
    setPending(true);
    const sessionTitle = title.trim() || defaultTitle;
    const edits: { title?: string; description?: string } = continuing ? {} : {
      ...(sessionTitle !== subject.title ? { title: sessionTitle } : {}),
      /* Only a REAL edit is saved: an untouched autofill (or a load that never
         answered) writes nothing back. Clearing the text IS an edit — it
         empties the task's description deliberately. */
      ...(draft !== null && description !== seed.current ? { description } : {}),
    };
    const saved = onSaveSubject && Object.keys(edits).length > 0
      ? Promise.resolve(onSaveSubject(edits))
      : Promise.resolve();
    /* PER-GROUP SEND (I9), read at commit time: the ticks are whatever is on
       screen. An untouched group is omitted (its defaults load) with a
       reason; an edited group is its exact set; Jev's answered groups replace
       the popup's own. No group edited ⇒ no `selection`. */
    const jevFields = jev.toSpawnFields();
    const launchFields = {
      ...composeSelection(selection.outcomes(), jevFields.groups, jevFields.defaultReasons),
      ...(jevFields.jevRunId ? { jevRunId: jevFields.jevRunId } : {}),
    };
    saved
      .then(() => onSpawn(
        buildSpawnInput({
          clientMutationId: newClientMutationId?.() ?? clientMutationId ?? newLaunchMutationId(),
          spaceId,
          config: continuing && description.trim()
            ? { ...config, promptExtra: description.trim(), ...launchFields }
            : { ...config, ...launchFields },
          // Still named `taskIds` on the wire; the server maps a non-task
          // subject through `derive_task_for_entity` (064).
          taskIds: subjectTaskIds,
          title: sessionTitle,
        }),
      ))
      .then(() => onDismiss?.())
      .catch(fail);
  };

  const heading = `${verbLabel ?? 'Run'} configuration`;

  return (
    <div className="nsx-popup" role="dialog" aria-modal="true" aria-label={heading} data-testid="launch-quick-config">
      {/* The scrim IS the outside: any click on it is a click away. */}
      <div className="nsx-popup__scrim" onClick={onDismiss} aria-hidden="true" />
      {/* NO CHROME ABOVE THE CARD (owner's ask 2026-09-07): the tile is the
          whole surface. The verb survives as the dialog's accessible name, the
          subject as the title field's VALUE, and dismissal as Escape and the
          scrim. */}
      <div
        className="nsx-popup__frame"
        data-shake={shaking || undefined}
        onAnimationEnd={() => setShaking(false)}
      >
        <NewSessionComposer
          {...bind}
          draft={description}
          onDraftChange={setDraftState}
          onSubmit={commit}
          busy={pending}
          /* A node/save refusal is a NOTICE, not a block: the tile stays up
             so the viewer can correct and retry. Feeding it through `refusal`
             greys Launch out and the only exit is dismiss, which drops the
             edits that never landed. `canLaunch` / unwired still withhold. */
          refusal={refusal}
          notice={nodeRefusal}
          /* The subject names the session unless the viewer types their own. */
          derivedTitle={defaultTitle}
          title={title}
          onTitleChange={setTitle}
          requirePrompt={false}
          promptPlaceholder={continuing
            ? 'Instructions for the new session (optional) — it reads this session’s transcript first…'
            : 'Task description — the agent reads this as its briefing…'}
          onDismissRequest={onDismiss}
          autoFocus
          beforeLaunch={
            <AskJevButton state={jev.state} askRefusal={jev.askRefusal} onAsk={() => jev.ask()} />
          }
          aboveControls={
            <>
            <LaunchSelectionDisclosure
              selection={selection}
              /* In Jev mode Jev's ticks ARE memories and skills (the review
                 drawer shows them); references stay the popup's own. */
              groups={jev.jevMode ? ['references'] : ['memories', 'skills', 'references']}
              candidates={selectionSources?.candidates ?? {}}
            />
            <JevStrip
              jev={jev}
              roster={teammateRows}
              selectedTeammateId={config.teamMemberId}
              onSelectTeammate={(id) => bind.onPickTeammate(id)}
              reviewOpen={reviewOpen}
              onReview={() => setReviewOpen((open) => !open)}
              model={{
                label: jevModel ? modelLabel(jevModel, jevCatalog) : '',
                refusal: jevModel ? modelApplyRefusal(jevModel, { catalog: jevCatalog }) : null,
                applied: Boolean(jevModel)
                  && jevModel?.model === config.model
                  && jevModel?.agentTool === config.agentToolId
                  && jevModel?.effort === config.reasoningEffort,
                /* Model and effort through the card's own setters; the TOOL
                   follows the model here (the catalog entry knows it), and
                   the refusal above guarantees it is the tool Jev named. */
                onApply: (suggestion) => {
                  bind.onPickModel(suggestion.model);
                  bind.onEffortChange(suggestion.effort);
                },
              }}
            />
            </>
          }
        />
        {reviewOpen && jev.state !== 'idle' ? (
          <JevReviewDrawer jev={jev} onClose={() => setReviewOpen(false)} />
        ) : null}
      </div>
    </div>
  );
}
