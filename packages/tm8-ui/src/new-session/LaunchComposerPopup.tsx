import { useMemo, useState } from 'react';
import type { ExecutionSpawnInput } from '@tm8/contract';

import {
  buildSpawnInput,
  canLaunch,
  newLaunchMutationId,
  type LaunchCapacity,
  type LaunchConfig,
  type LaunchMode,
  type LaunchProject,
  type LaunchProjectOption,
  type LaunchTeammate,
} from '../domain/launch';
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
 * WHAT THE PROMPT MEANS HERE. This popup launches an EXISTING task — the
 * subject's own body reaches the agent as its first turn. The textarea is
 * therefore OPTIONAL EXTRA CONTEXT, carried as `promptExtra`, which arrives
 * wrapped as `<untrusted_data type="launch-context">` — material the agent
 * acts ON, not instructions it acts BY. The placeholder says "context", not
 * "instructions", for exactly that reason. `requirePrompt={false}` is the
 * canvas's own prop for this host.
 *
 * DISMISSAL LAYERS: Escape closes an open menu first, then the popup (the
 * composer owns that ordering); the scrim click closes the popup; a REFUSED
 * launch never closes it — the node's reason renders under the card and the
 * viewer's configuration survives to be corrected.
 */

/** The persona rows as the panels supply them — `LaunchTeammateOption`'s shape. */
export interface PopupTeammate {
  id: string;
  label: string;
  agentTool?: string | null;
  model?: string | null;
}

export interface LaunchComposerPopupProps {
  /** The entity being run — supplies the assignment link and the session title. */
  subject: { id: string; title: string };
  spaceId: string;
  teammates: readonly PopupTeammate[];
  projects?: readonly LaunchProjectOption[];
  capacity?: LaunchCapacity;
  /** Commits the spawn. ABSENT ⇒ Launch refuses with the unwired reason (R5 #9). */
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  /**
   * Persists an edited title back onto the SUBJECT (owner's ask 2026-09-07:
   * the popup's title is the task's, editable, and a launch saves the edit).
   * Runs BEFORE the spawn — the rename is cheap and correctable, the spawn is
   * the irreversible act, so a refused rename stops the launch rather than a
   * failed launch leaving a half-applied pair. Absent ⇒ the edit still names
   * the SESSION, and the task keeps its title.
   */
  onRenameSubject?: (title: string) => void | Promise<unknown>;
  onDismiss?: () => void;
  /** The session mode the OPENING VERB commits — `ActionDef.launchMode`. */
  mode?: LaunchMode;
  /** The opening verb's word — `ActionDef.label`. Absent ⇒ "Run". */
  verbLabel?: string;
  /** Fresh id minted when the viewer deliberately submits. */
  newClientMutationId?: () => string;
  /** Compatibility injection for deterministic component tests. */
  clientMutationId?: string;
}

export function LaunchComposerPopup({
  subject,
  spaceId,
  teammates,
  projects = [],
  capacity,
  onSpawn,
  onRenameSubject,
  onDismiss,
  mode,
  verbLabel,
  newClientMutationId,
  clientMutationId,
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

  const { config: baseConfig, projectOptions, bind } = useLaunchComposerState({
    teammates: teammateRows,
    projects: projectRows,
    launchMode: mode,
  });

  const [draft, setDraft] = useState('');
  /* THE TASK'S TITLE, AS A VALUE — not a placeholder (owner's ask 2026-09-07).
     The field opens holding the real name so "continue" is doing nothing and
     "rename" is ordinary editing; a launch persists an edit to the task. */
  const [title, setTitle] = useState(subject.title);
  const [pending, setPending] = useState(false);
  /** The node's own words when it refuses. Null until it does. */
  const [nodeRefusal, setNodeRefusal] = useState<string | null>(null);

  const config: LaunchConfig = draft.trim()
    ? { ...baseConfig, promptExtra: draft.trim() }
    : baseConfig;

  const verdict = canLaunch(config, { projects: projectOptions, capacity });
  const refusal = !onSpawn
    ? 'Launching isn’t connected on this surface yet — the configuration is real; this screen does not dispatch it.'
    : verdict.ok ? null : verdict.reason;

  const commit = () => {
    if (!onSpawn || pending) return;
    setNodeRefusal(null);
    setPending(true);
    const sessionTitle = title.trim() || subject.title;
    /* RENAME FIRST, THEN SPAWN. The rename is cheap and correctable; the
       spawn is the build's irreversible act — so a refused rename stops the
       launch with its reason, and a refused spawn never leaves the pair
       half-applied in the wrong order (a renamed task with no session is a
       persisted edit, which is what the edit asked for). */
    const renamed = onRenameSubject && sessionTitle !== subject.title
      ? Promise.resolve(onRenameSubject(sessionTitle))
      : Promise.resolve();
    renamed
      .then(() => onSpawn(
        buildSpawnInput({
          clientMutationId: newClientMutationId?.() ?? clientMutationId ?? newLaunchMutationId(),
          spaceId,
          config,
          // Still named `taskIds` on the wire; the server maps a non-task
          // subject through `derive_task_for_entity` (064).
          taskIds: [subject.id],
          title: sessionTitle,
        }),
      ))
      /* DISMISS ONLY ON SUCCESS — a refused launch pixel-identical to a
         successful one is the facet collapse LaunchQuickConfig documents. */
      .then(() => onDismiss?.())
      .catch((error: unknown) => {
        setPending(false);
        setNodeRefusal(
          String((error as { message?: string })?.message ?? error)
            || 'the node refused this launch and gave no reason',
        );
      });
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
      <div className="nsx-popup__frame">
        <NewSessionComposer
          {...bind}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={commit}
          busy={pending}
          refusal={nodeRefusal ?? refusal}
          /* The subject names the session unless the viewer types their own. */
          derivedTitle={subject.title}
          title={title}
          onTitleChange={setTitle}
          requirePrompt={false}
          promptPlaceholder="Extra context for this launch — optional…"
          onDismissRequest={onDismiss}
          autoFocus
        />
      </div>
    </div>
  );
}
