import { useCallback, useMemo, useState } from 'react';
import type {
  ContainerNetworkPreset,
  ContainerProfile,
  ContainersCreateInput,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import { Eyebrow, Pill } from '../kit';
import { DisabledAction, type UnavailableReason } from './honesty/DisabledWithReason';
import './new-container-sheet.css';

/**
 * NEW CONTAINER — the birth flow (Design §13.3).
 *
 * IT COMMITS `containers.create`, NEVER `entities.create`. `container` joins
 * `CreatableEntityKind`'s exclusion and the node refuses a generic create with
 * "owned by the container lifecycle", exactly as it does for `work_session`.
 * There is no second path to fall back to, which is also why the registry row
 * sets `quickCreate: false`: the placeholder flow would mount a Create control
 * that always refuses.
 *
 * ── WHY THE INPUT BUILDER IS A SEPARATE PURE FUNCTION ─────────────────────
 *
 * `buildContainersCreateInput` below takes a draft and returns the contract
 * DTO, with no React in it. That split is what makes the payload TESTABLE as a
 * payload — the acceptance criterion for this lane is that the sheet builds a
 * `ContainersCreateInput` verbatim, and asserting that through a rendered form
 * would test the form's labels as much as the wire shape. It is the
 * `buildSpawnInput` precedent, for the same reason.
 *
 * ── THE HOST-PATH RULE, WHICH IS THE EASY ONE TO GET WRONG ────────────────
 *
 * A mount's `host` path is WRITE-ONLY (AMENDMENT 1, ruling R5). The input side
 * `ContainerMountInput` carries `{ host, guest, ro }`; the read side
 * `ContainerMount` carries `{ guest, ro }` and nothing else, because
 * `internal.command_entity` embeds `entity_content` in the command result a
 * client receives, so a node-local path in that arm would reach every viewer.
 *
 * Consequence for this sheet, stated rather than assumed: it MAY send a host
 * path and can never read one back, so there is no mount EDITOR here and no
 * field seeded from a stored value. P0 offers the project mount only —
 * `projectId`, which the node resolves to a working dir server-side — which is
 * the one form of "mount something" that needs no client-held host path at all.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * No `spec.env` field. Secrets reach a machine through the credential path and
 * never through `spec.env` (§12.3), and the contract refuses secret-looking
 * KEYS at the door — but an ordinary-looking key can still hold a secret, and
 * a create form is where someone would paste one. Offering no field is the
 * only version of this that cannot be misused.
 *
 * No phone arrangement of its own. The host places this in whatever sheet it
 * uses — `mobile/CONTRACT.md` §4: "seven bespoke sheets are seven chances to
 * disagree about what dismiss means", and the position of a phone sheet
 * belongs to the frame, which is the only thing that knows where the tab bar
 * and the keyboard inset are. This component is the CONTENT.
 */

/** The profiles P0 offers, with the sentence that says what each one is for. */
const PROFILE_CHOICES: readonly { id: ContainerProfile; label: string; blurb: string }[] = [
  { id: 'shell', label: 'Shell', blurb: 'A plain Linux box with a login shell. The only profile the fake provider builds.' },
  { id: 'desktop', label: 'Desktop', blurb: 'An X session with a screen surface. Needs a provider that offers one.' },
  { id: 'browser', label: 'Browser', blurb: 'Chrome with a CDP endpoint, for agents driving a real browser.' },
  { id: 'dind', label: 'Docker', blurb: 'A nested Docker daemon. Can parent other containers.' },
];

const NETWORK_CHOICES: readonly { id: ContainerNetworkPreset; label: string; blurb: string }[] = [
  { id: 'locked', label: 'Locked', blurb: 'No egress except what you allow by name.' },
  { id: 'balanced', label: 'Balanced', blurb: 'The package registries and forges a build needs.' },
  { id: 'open', label: 'Open', blurb: 'Unrestricted egress.' },
];

/** What the form holds. Every member is a control on screen. */
export interface NewContainerDraft {
  profile: ContainerProfile;
  title: string;
  /** Mounted at /workspace by the node. Null ⇒ no project mount. */
  projectId: EntityId | null;
  network: ContainerNetworkPreset;
  /** The form asks "keep it after the session ends"; the wire says `ephemeral`. */
  persistent: boolean;
  /** Advanced. Null ⇒ the node picks the best provider satisfying policy. */
  provider: string | null;
  /** Untrusted-project gate — the same confirm a spawn requires. */
  confirmUntrusted: boolean;
}

export const NEW_CONTAINER_DEFAULTS: NewContainerDraft = {
  profile: 'shell',
  title: '',
  projectId: null,
  network: 'balanced',
  persistent: false,
  provider: null,
  confirmUntrusted: false,
};

/**
 * The draft → the contract DTO, verbatim. No field is invented and no field is
 * renamed on the way out.
 *
 * `clientMutationId` IS THE CALLER'S and is passed in rather than minted here:
 * `containers.create` is ledgered (`internal.ledger_replay`), so replaying the
 * same id returns the FIRST result instead of building a second machine. A
 * function that minted its own would make that guarantee unreachable — a
 * double-submit would be two containers — and it would make this impure.
 *
 * OMITTED, NOT NULLED, where the caller chose nothing. The server's schemas are
 * `.strict()` and a `null` is a different instruction from an absent key: null
 * `provider` means "you pick", absent `title` means "no title". Sending
 * `title: ''` would name a container the empty string.
 */
export function buildContainersCreateInput(
  draft: NewContainerDraft,
  ctx: { spaceId: SpaceId; clientMutationId: string },
): ContainersCreateInput {
  const title = draft.title.trim();
  return {
    clientMutationId: ctx.clientMutationId,
    spaceId: ctx.spaceId,
    profile: draft.profile,
    ...(title.length > 0 ? { title } : {}),
    /* NULL is meaningful here — "the node picks the best provider satisfying
       policy" — so it is sent rather than omitted when nothing was chosen. */
    provider: draft.provider,
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(draft.confirmUntrusted ? { confirmUntrusted: true as const } : {}),
    lifecycle: { ephemeral: !draft.persistent },
    spec: { network: { preset: draft.network, allow: [] } },
    /* `start` DEFAULTS TO TRUE in the contract, and this form has no control
       for it: a machine you asked for and that does not run is a puzzle, not a
       feature. Stated explicitly so the default cannot move underneath. */
    start: true,
  };
}

export interface NewContainerSheetProps {
  spaceId: SpaceId;
  /**
   * Commits the create. ABSENT ⇒ the button renders disabled-with-reason
   * rather than inert — a node with `TM8_CONTAINERS=off` answers 501 for every
   * runtime op, and that refusal must be visible, not a dead control.
   */
  onCreate?: (input: ContainersCreateInput) => void | Promise<void>;
  /**
   * Why creating is unavailable, when it is — the honesty pair, not a
   * sentence: `cause` is what is true, `remedy` is the named next step. A node
   * with `TM8_CONTAINERS=off` has a cause the viewer cannot act on and a
   * remedy only an operator can, and the two-part shape is what lets the
   * control say both without pretending they are the same.
   */
  unavailableReason?: UnavailableReason;
  onCancel?: () => void;
  /** Projects offerable as the /workspace mount. */
  projects?: readonly { id: EntityId; title: string; trusted?: boolean }[];
  /** Seam for the id, so a replay returns the first container (see above). */
  mutationId?: () => string;
}

export function NewContainerSheet(props: NewContainerSheetProps) {
  const [draft, setDraft] = useState<NewContainerDraft>(NEW_CONTAINER_DEFAULTS);
  const [submitting, setSubmitting] = useState(false);

  const project = useMemo(
    () => props.projects?.find((p) => p.id === draft.projectId) ?? null,
    [props.projects, draft.projectId],
  );
  /*
   * The same gate a spawn applies: an untrusted working dir needs an explicit
   * confirm, and the server refuses without it. Asked here so the refusal
   * never arrives as a surprise after the button.
   *
   * `!== true`, NOT `=== false`, AND THE DIFFERENCE IS THE WHOLE POINT.
   * `trusted` is optional on the prop, so it has three states, and `=== false`
   * silently sorts the third one — ABSENT — into "trusted": a host that does
   * not know a project's trust level would skip the confirm entirely and send
   * a create the node then refuses, for a reason the viewer was never shown.
   *
   * This is the SAME inverse-default this lane argues against one file over,
   * for the container capability booleans: absent is not permission. A trust
   * level nobody answered for must read as untrusted, because the cost of the
   * two mistakes is not symmetric — an unnecessary confirm is a checkbox, and
   * a skipped one runs someone else's code inside the machine.
   */
  const needsConfirm = project !== null && project.trusted !== true;
  const blocked = needsConfirm && !draft.confirmUntrusted;

  const submit = useCallback(() => {
    if (!props.onCreate || blocked) return;
    setSubmitting(true);
    const clientMutationId = props.mutationId?.() ?? `containers.create:${String(Date.now())}`;
    void Promise.resolve(props.onCreate(buildContainersCreateInput(draft, { spaceId: props.spaceId, clientMutationId })))
      .finally(() => setSubmitting(false));
  }, [props, draft, blocked]);

  const set = <K extends keyof NewContainerDraft>(key: K, value: NewContainerDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      className="pn-ncs"
      data-testid="new-container-sheet"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <fieldset className="pn-ncs__group">
        <legend><Eyebrow>PROFILE</Eyebrow></legend>
        <div className="pn-ncs__cards" role="radiogroup" aria-label="Profile">
          {PROFILE_CHOICES.map((choice) => (
            <button
              type="button"
              key={choice.id}
              role="radio"
              aria-checked={draft.profile === choice.id}
              className="pn-ncs__card"
              data-selected={draft.profile === choice.id ? 'yes' : 'no'}
              onClick={() => set('profile', choice.id)}
            >
              <span className="pn-ncs__card-label">{choice.label}</span>
              <span className="pn-ncs__card-blurb">{choice.blurb}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="pn-ncs__field">
        <Eyebrow>TITLE</Eyebrow>
        <input
          className="pn-ncs__input"
          value={draft.title}
          placeholder="build box"
          onChange={(e) => set('title', e.target.value)}
        />
      </label>

      {props.projects && props.projects.length > 0 ? (
        <label className="pn-ncs__field">
          <Eyebrow>PROJECT</Eyebrow>
          <select
            className="pn-ncs__input"
            value={draft.projectId ?? ''}
            onChange={(e) => set('projectId', e.target.value === '' ? null : (e.target.value as EntityId))}
          >
            <option value="">No project</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <span className="pn-ncs__hint">Mounted read-write at /workspace.</span>
        </label>
      ) : null}

      {/* THE UNTRUSTED GATE IS A REAL REFUSAL, not a warning: without the
          confirm the server refuses, so the button below is disabled and says
          so rather than letting the click discover it. */}
      {needsConfirm ? (
        <label className="pn-ncs__confirm">
          <input
            type="checkbox"
            checked={draft.confirmUntrusted}
            onChange={(e) => set('confirmUntrusted', e.target.checked)}
          />
          <span>
            <Pill tone="wait">untrusted</Pill>{' '}
            This project has not been marked trusted. Code in it will execute inside the container.
          </span>
        </label>
      ) : null}

      <fieldset className="pn-ncs__group">
        <legend><Eyebrow>NETWORK</Eyebrow></legend>
        <div className="pn-ncs__cards" role="radiogroup" aria-label="Network">
          {NETWORK_CHOICES.map((choice) => (
            <button
              type="button"
              key={choice.id}
              role="radio"
              aria-checked={draft.network === choice.id}
              className="pn-ncs__card"
              data-selected={draft.network === choice.id ? 'yes' : 'no'}
              onClick={() => set('network', choice.id)}
            >
              <span className="pn-ncs__card-label">{choice.label}</span>
              <span className="pn-ncs__card-blurb">{choice.blurb}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="pn-ncs__confirm">
        <input
          type="checkbox"
          checked={draft.persistent}
          onChange={(e) => set('persistent', e.target.checked)}
        />
        <span>Keep this machine after the session that made it ends.</span>
      </label>

      <div className="pn-ncs__actions">
        {props.onCancel ? (
          <button type="button" className="pn-ncs__cancel" onClick={props.onCancel}>Cancel</button>
        ) : null}
        {props.onCreate && !blocked ? (
          <button type="submit" className="pn-ncs__create" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create container'}
          </button>
        ) : (
          <DisabledAction
            label="Create container"
            reason={
              blocked
                ? {
                  cause: 'This project is not marked trusted, and code in it will execute inside the container.',
                  remedy: 'Tick the confirmation above — the node refuses the create without it.',
                }
                : (props.unavailableReason ?? {
                  cause: 'This node does not build containers: containers.create answered not_implemented.',
                  remedy: 'TM8_CONTAINERS=on, with a provider configured.',
                })
            }
          >
            Create container
          </DisabledAction>
        )}
      </div>
    </form>
  );
}
