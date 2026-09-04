import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExecutionSpawnInput } from '@tm8/contract';
import {
  accessModeLabel,
  agentTool,
  buildSpawnInput,
  describeAccessMode,
  nextAccessMode,
  canLaunch,
  defaultConfigFor,
  defaultLaunchTarget,
  describeCapacity,
  describeProfile,
  describeTeammateLoad,
  EDGES_NOT_HYDRATED_REASON,
  modelsFor,
  newLaunchMutationId,
  type LaunchCapacity,
  type LaunchConfig,
  type LaunchMode,
  type LaunchProjectOption,
  type ProfileResolution,
  type TeammateLaunchState,
} from '../../domain';
import { DisabledAction, DisabledIconControl, toReason } from '../honesty/DisabledWithReason';
import { useDismissable } from '../useDismissable';

/**
 * THE QUICK LAUNCH CONFIG — the inline expand behind every Run button.
 *
 * THE INTERACTION, ruled: Run EXPANDS this; the expand carries the primary
 * `Launch ▸` that commits; `full options` escapes to the five-section sheet.
 * Two clicks to launch, never one — deliberately diverging from the maestro
 * reference this transplants, whose Play fires immediately. That works there
 * because it is a single-user local tool with a remembered override, so the
 * first click is never the first decision. Here a spawn is the build's only
 * consequential irreversible act (R7 defers undo entirely), so the config you
 * are about to use is visible at the moment you commit it.
 *
 * WHAT THIS SHOWS AND WHAT IT DOES NOT: teammate, model, and the resolved
 * profile LINE with its provenance — an inherited default must never read as
 * a choice someone made. Everything deeper (profile options with status
 * honesty, M:N projects, refusal cards) lives in the sheet, and the escape
 * says so rather than implying this is the whole surface.
 *
 * REFUSALS COME FROM `canLaunch`, never from this component. Every one names
 * its mechanism, because "Launch is greyed out" with no reason is exactly the
 * failure L6 exists to prevent.
 */

/**
 * The minimum this config needs to know about a persona — exactly what
 * `defaultConfigFor` consumes.
 *
 * Deliberately NOT `EntitySummary` and NOT the sheet's `LaunchTeammate`: the
 * contract summary would force an unsafe read of the untyped `state` arm, and
 * the sheet's view model would point `panels/` at `views/`, which composes
 * panels rather than the reverse. Both adapt to this in one line at the shell.
 */
export interface LaunchTeammateOption {
  id: string;
  label: string;
  agentTool?: string | null;
  model?: string | null;
}

export interface LaunchQuickConfigProps {
  /**
   * The entity being run — supplies the assignment link and the session title.
   * ANY kind, not just a task: the server derives a task to anchor the session
   * on when the subject is not one (migration 064), so this stays a bare
   * `{id,title}` and no kind check belongs here.
   */
  subject: { id: string; title: string };
  spaceId: string;
  /** Selectable personas, already adapted to the shape above. */
  teammates: readonly LaunchTeammateOption[];
  /** Linked projects; the first trusted row is the quick launch root. */
  projects?: readonly LaunchProjectOption[];
  /** Live-session load per teammate. `null` count ⇒ hollow, never zero. */
  loadFor?: (teamMemberId: string) => TeammateLaunchState;
  /**
   * Resolves the governing profile FOR A TEAMMATE. A resolver, not a value:
   * `teammate-default` is a step in the chain, so switching teammate can
   * change which profile wins — a pre-resolved prop would silently keep
   * showing the previous persona's default.
   */
  profileFor?: (teamMemberId: string | null) => ProfileResolution | undefined;
  /**
   * Slots free before commitment (T5-5). Passed to `canLaunch`, so an
   * at-capacity node refuses HERE rather than at spawn time.
   */
  capacity?: LaunchCapacity;
  /**
   * Commits the spawn. ABSENT ⇒ Launch renders disabled-with-reason rather
   * than enabled-inert (R5 #9) — the same structural rule as every other verb.
   */
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  /** Opens the five-section sheet. Absent ⇒ disabled-with-reason. */
  onFullOptions?: () => void;
  onDismiss?: () => void;
  /**
   * What counts as "inside" for outside-click dismissal. Hosts whose TRIGGER
   * sits outside this component must pass an element containing both, or the
   * trigger's own mousedown dismisses the config a moment before its click
   * re-opens it — and the toggle can never close. Defaults to this component.
   */
  boundsRef?: React.RefObject<HTMLElement | null>;
  /** Fresh id minted when the viewer deliberately submits. */
  newClientMutationId?: () => string;
  /** Compatibility injection for deterministic component tests. */
  clientMutationId?: string;
  /**
   * The session mode the OPENING VERB commits — `ActionDef.launchMode`.
   *
   * One config serves Run, Coordinate and Launch session. Absent ⇒ the
   * config's own default (`worker`), which is Run's. Passing it is what stops
   * Coordinate from opening this card and spawning a worker.
   */
  mode?: LaunchMode;
  /**
   * The opening verb's word — `ActionDef.label`. Absent ⇒ "Run", which is the
   * verb this card was built for and still its only caller-less default.
   */
  verbLabel?: string;
}

export function LaunchQuickConfig({
  subject,
  spaceId,
  teammates,
  projects = [],
  loadFor,
  profileFor,
  capacity,
  onSpawn,
  onFullOptions,
  onDismiss,
  boundsRef,
  clientMutationId,
  newClientMutationId,
  mode,
  verbLabel,
}: LaunchQuickConfigProps) {
  const ref = useRef<HTMLDivElement>(null);
  const noop = useCallback(() => {}, []);
  useDismissable(true, boundsRef ?? ref, onDismiss ?? noop);

  const first = teammates[0];
  const defaultProjectId = projects.find((project) => project.trusted)?.projectId ?? null;
  /**
   * THE ONE PLACE A CONFIG IS SEEDED — and it exists because scattering that
   * was already a bug twice over.
   *
   * The mode comes from the VERB that opened this card (`ActionDef.launchMode`),
   * not from the persona: one config serves Run, Coordinate and Launch session,
   * and `defaultConfigFor` hard-codes `mode: 'worker'`. There are THREE re-seed
   * paths — the initializer, the late-teammate effect, and the teammate SELECT —
   * and each one re-seeds WHOLE on purpose, because a teammate's recorded tool
   * and model travel together and patching one field would mix two personas.
   *
   * Spreading the mode at each call site fixed two of the three and missed the
   * one the USER drives: picking a teammate is the first thing anyone does, and
   * it silently demoted Coordinate back to a worker. Routing every seed through
   * here is what makes a fourth path impossible to get wrong, rather than
   * merely unlikely.
   */
  const seedConfig = useCallback(
    (teammate: LaunchTeammateOption | undefined): LaunchConfig => {
      const base = teammate
        ? defaultConfigFor(teammate, defaultProjectId)
        : emptyConfig(defaultProjectId);
      return mode ? { ...base, mode } : base;
    },
    [defaultProjectId, mode],
  );

  const [config, setConfig] = useState<LaunchConfig>(() => seedConfig(first));

  /**
   * RE-SEED WHEN THE SELECTION STOPS EXISTING.
   *
   * The initializer above runs ONCE. Mounted before its sources arrived — or
   * left open while the selected persona was deleted — the config held a
   * `teamMemberId` that matches no option, so the teammate select rendered
   * BLANK (a select whose value matches no option has no selected index) and
   * the model select rendered "no known models", because the model list is
   * derived from the SEEDING TEAMMATE's recorded `agentToolId` and there was
   * none. Both selects then stayed empty for the life of the expand.
   *
   * Guarded on membership, not on arrival: a deliberate choice is never
   * overwritten, because a chosen teammate is by definition still in the list.
   */
  useEffect(() => {
    if (!first) return;
    if (config.teamMemberId !== null && teammates.some((t) => t.id === config.teamMemberId)) return;
    // Re-seed WHOLE, for the same reason the change handler does: a teammate's
    // recorded tool and model travel together, and patching one field would mix
    // two personas' settings.
    setConfig(seedConfig(first));
    // `seedConfig` belongs here: omitted, this effect closed over a stale
    // `mode`. The mount key makes that unreachable in practice — a verb change
    // remounts — but a dep list that is wrong only because something else
    // prevents the call is a trap for whoever removes that something else.
  }, [first, teammates, config.teamMemberId, defaultProjectId, seedConfig]);

  /** The node's own words when it refuses. Null until it does. */
  const [nodeRefusal, setNodeRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const models = useMemo(() => modelsFor(config.agentToolId), [config.agentToolId]);
  const refusal = canLaunch(config, { projects, capacity });

  const selected = teammates.find((t) => t.id === config.teamMemberId);
  const load = selected && loadFor ? loadFor(selected.id) : null;

  return (
    <div className="lq" ref={ref} data-testid="launch-quick-config">
      <div className="lq__head">
        {/* THE CARD NAMES THE VERB THAT OPENED IT. One config serves Run,
            Coordinate and Launch session, and this said "Run configuration"
            verbatim — so pressing Coordinate opened a card naming the OTHER
            verb, over a payload that (once the mode fix landed) really did
            coordinate. Same naming-one-act-performing-another class as the
            mode bug, moved into the copy. The word comes from the caller's
            own `ActionDef.label`, so it cannot drift from the button. */}
        <span className="lq__heading" data-testid="launch-heading">
          {`${verbLabel ?? 'Run'} configuration`}
        </span>
        <span className="lq__subject" title={subject.title}>
          {subject.title}
        </span>
        {onDismiss ? (
          <button type="button" className="lq__close" aria-label="Close run configuration" onClick={onDismiss}>
            ×
          </button>
        ) : null}
      </div>
      <div className="lq__row">
        <label className="lq__field">
          <span className="lq__label">Teammate</span>
          <select
            className="lq__select"
            value={config.teamMemberId ?? ''}
            data-testid="launch-teammate"
            onChange={(e) => {
              const next = teammates.find((t) => t.id === e.target.value);
              // Re-seed from the NEW teammate's record rather than patching one
              // field: its recorded tool and model travel together, and a
              // half-updated config would silently mix two personas' settings.
              // Through `seedConfig`, so the VERB's mode survives the swap —
              // this is the path that dropped it, and it is the one a user
              // touches first.
              if (next) setConfig(seedConfig(next));
            }}
          >
            {teammates.length === 0 ? <option value="">no teammates available</option> : null}
            {teammates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="lq__field">
          <span className="lq__label">Model</span>
          <select
            className="lq__select"
            value={config.model ?? ''}
            data-testid="launch-model"
            onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value || null }))}
          >
            {/* An empty list means this UI does not know the tool. Offering a
                model it may reject would turn a guess into a spawn-time
                refusal, so the absence is stated instead. */}
            {models.length === 0 ? (
              <option value="">
                {`no known models for ${agentTool(config.agentToolId)?.label ?? config.agentToolId ?? 'this tool'}`}
              </option>
            ) : null}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* THE ACCESS TOGGLE — one click per step through the same postures the
          sheet lists in a select. It exists because the posture is the setting
          people change most often and the only path to it was the five-section
          sheet; a chip that names the CURRENT posture (never a bare icon) keeps
          the escalation legible at the moment of commitment. `Default` is a
          step, not a gap: it says the teammate and node decide. */}
      <div className="lq__access">
        <span className="lq__label">Access</span>
        <button
          type="button"
          className={`lq__accessbtn lq__accessbtn--${config.accessMode ?? 'default'}`}
          data-testid="launch-access-toggle"
          data-access-mode={config.accessMode ?? 'default'}
          title={`${describeAccessMode(config.accessMode)} — click to change`}
          aria-label={`Access mode: ${describeAccessMode(config.accessMode)}. Click to change.`}
          onClick={() => setConfig((c) => ({ ...c, accessMode: nextAccessMode(c.accessMode) }))}
        >
          {accessModeLabel(config.accessMode)}
        </button>
      </div>

      {/* The resolved profile as a LINE with its provenance — never a bare
          value. An inherited default that looks like a choice is the same lie
          as a hollow zero. */}
      <p className="lq__profile" data-testid="launch-profile">
        {/* No resolution yet is the SAME fact as an empty chain, so it must
            read in the same words — `describeProfile` owns that sentence. */}
        {describeProfile(
          profileFor?.(config.teamMemberId) ?? { profileId: null, label: '', source: 'none' },
        )}
      </p>

      {/* "Capacity before commitment" — stated BEFORE the click, not explained
          after a refusal. */}
      {capacity ? (
        <p className="lq__capacity" data-testid="launch-capacity">
          {describeCapacity(capacity)}
        </p>
      ) : null}

      {/* Capacity honesty: zero and unknown are different facts. */}
      {load ? (
        <p
          className={load.liveSessionCount === null ? 'lq__load lq__load--hollow' : 'lq__load'}
          title={load.liveSessionCount === null ? (load.hollowReason ?? EDGES_NOT_HYDRATED_REASON) : undefined}
          data-testid="launch-load"
        >
          {describeTeammateLoad(load)}
        </p>
      ) : null}

      {/* T5-5's refusal card, inline. The node's own sentence, not a generic
          apology — and it sits ABOVE the actions so it is read before the
          button that produced it is pressed again. */}
      {nodeRefusal ? (
        <p className="lq__refusal" role="alert" data-testid="launch-refusal">
          <span className="lq__refusal-label">Launch refused</span>
          {` — ${nodeRefusal}`}
        </p>
      ) : null}

      <div className="lq__actions">
        {onFullOptions ? (
          <button type="button" className="lq__more" onClick={onFullOptions} data-testid="launch-full-options">
            full options ▸
          </button>
        ) : (
          <DisabledIconControl
            label="Full launch options"
            reason={{
              cause: 'The full launch sheet isn’t open yet',
              remedy: 'projects, profile options and refusal detail live there',
            }}
          >
            full options ▸
          </DisabledIconControl>
        )}

        <span className="lq__spacer" />

        {refusal.ok === false ? (
          <DisabledAction reason={toReason(refusal.reason)}>Launch ▸</DisabledAction>
        ) : !onSpawn ? (
          /* R5 #9 again, structurally: no dispatcher ⇒ disabled-with-reason,
             never a live button that does nothing. */
          <DisabledAction
            reason={{
              cause: 'Launching isn’t connected yet',
              remedy: 'the configuration is real; this screen does not dispatch it in this build',
            }}
          >
            Launch ▸
          </DisabledAction>
        ) : (
          <button
            type="button"
            className="lq__launch"
            data-testid="launch-commit"
            disabled={pending}
            onClick={() => {
              setNodeRefusal(null);
              setPending(true);
              Promise.resolve(
                onSpawn(
                  buildSpawnInput({
                    clientMutationId: newClientMutationId?.() ?? clientMutationId ?? newLaunchMutationId(),
                    spaceId,
                    config,
                    // Still named `taskIds` on the wire; the server maps each
                    // id through `derive_task_for_entity` (064), so a non-task
                    // subject arrives here unchanged and is resolved there.
                    taskIds: [subject.id],
                    title: subject.title,
                  }),
                ),
              )
                // DISMISS ONLY ON SUCCESS. The first version fired and closed
                // unconditionally, so a REFUSED launch was pixel-identical to
                // a successful one — the config vanished, nothing appeared,
                // and the node's refusal went only to the console. That is the
                // same facet collapse as a hollow zero: two different outcomes
                // rendering as one.
                .then(() => onDismiss?.())
                .catch((error: unknown) => {
                  setPending(false);
                  // A refusal is a FACT about the node, not a UI failure, so
                  // it keeps the configuration on screen to be corrected
                  // rather than discarding the viewer's work.
                  setNodeRefusal(
                    String((error as { message?: string })?.message ?? error) ||
                      'the node refused this launch and gave no reason',
                  );
                });
            }}
          >
            {pending ? 'Launching…' : 'Launch ▸'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * No teammates to seed from. Every field stays null rather than guessing a
 * default tool: `canLaunch` then refuses with the missing-teammate reason,
 * which is the true blocker. A seeded tool would make the form look ready.
 */
function emptyConfig(defaultProjectId: LaunchProjectOption['projectId'] | null): LaunchConfig {
  return {
    teamMemberId: null,
    agentToolId: null,
    model: null,
    reasoningEffort: null,
    accessMode: null,
    mode: 'worker',
    target: defaultLaunchTarget(defaultProjectId),
  };
}
