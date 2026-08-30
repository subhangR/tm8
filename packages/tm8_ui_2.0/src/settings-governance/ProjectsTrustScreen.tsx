/**
 * T2-2 — PROJECTS & TRUST. Oracle:
 * `T0-1 workspace structure review (1)/T2 Settings, Trust & Authoring Hi-Fi.dc.html`,
 * `data-screen-label="T2-2 — Projects & trust"`, lines 143–272.
 *
 * The frame's own headline is the design law: **TRUST IS SAFETY UI, NOT A
 * SETTING** (L145). Everything below follows from it.
 *
 * FOUR TRUTHS, FOUR TREATMENTS — and the frame is built the way it is because
 * they are different truths, not four views of one:
 *   1. `LinkedProjectsCard`  (L150–187) — SPACE-side links. Light card.
 *   2. `ProjectRegistryCard` (L188–229) — NODE-side registry. Dark card.
 *   3. `UntrustedConsentCard`(L230–244) — the consent MOMENT.
 *   4. `SessionProjectsCard` (L245–261) — association chips vs the ⚿
 *      provenance line: "they never share styling, so history can't be
 *      rewritten by editing chips" (oracle note L268).
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, said once so no reader has to guess:
 * the space-side project LIST is a genuine `seam.query()` read. Every WRITE
 * this frame draws — link, unlink, new, edit, trust, untrust, associate — has
 * no executor in the stamped seam, and renders disabled-with-reason carrying
 * the mechanism (GG1–GG9 in `reasons.ts`). The consent card is the exception
 * and the reason it is a separate export: `confirmUntrusted` is a REAL member
 * of `ExecutionSpawnInput` (contract.ts:1046), so a host that owns a spawn can
 * wire this card and it works today.
 *
 * THE ONE THING THIS SCREEN MUST NEVER DO: paint a project `trusted` or
 * `untrusted` from anything but a read trust level. `ProjectResource.trust`
 * has no seam read, so the chip is HOLLOW until a host supplies it. An
 * unverified root shown as trusted is the worst defect this surface could
 * carry, and hollow-until-read is the only shape that cannot produce it.
 */
import { useId, useState } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { Pill } from '../kit';
import { DisabledAction } from '../panels';
import {
  frozenNote,
  projectRowOf,
  unlinkRefusal,
  untrustRefusal,
  SCRATCH_LABEL,
  type ProjectFacts,
  type ProjectRow,
  type SessionProjects,
} from './governance-model';
import { GOVERNANCE_REASONS } from './reasons';
import type { LoadState } from './port';
import {
  CardNote,
  EmptyRegion,
  FieldRow,
  GovCard,
  GovEyebrow,
  KnownText,
  LoadRegion,
  RefusedControl,
  UnreadRegion,
} from './parts';
import './governance.css';

export interface ProjectsTrustScreenProps {
  /** "space · atelier" (oracle L154). */
  spaceLabel: string;
  projects: LoadState<readonly EntitySummary[]>;
  /** Facts no seam read supplies. Absent ⇒ every one renders hollow. */
  factsFor?: (project: EntitySummary) => ProjectFacts | undefined;
  /** The session PROJECTS block. Absent ⇒ the region says why it is empty. */
  sessionProjects?: SessionProjects;
  /** A pending untrusted-run request. Absent ⇒ the card explains itself. */
  consent?: UntrustedConsentRequest | null;
  onConsentDecision?: (decision: UntrustedConsentDecision) => void;
  /** "view sessions" on the unlink refusal (L174). */
  onOpenSessions?: (projectEntityId: string) => void;
}

export function ProjectsTrustScreen({
  spaceLabel,
  projects,
  factsFor,
  sessionProjects,
  consent,
  onConsentDecision,
  onOpenSessions,
}: ProjectsTrustScreenProps) {
  return (
    <div className="gov-screen gov-screen--trust" data-testid="projects-trust-screen">
      <div className="gov-col">
        <LinkedProjectsCard
          spaceLabel={spaceLabel}
          projects={projects}
          factsFor={factsFor}
          onOpenSessions={onOpenSessions}
        />
        <CardNote>
          space settings › linked projects — unlink refusal states its blocker; untrusted states its
          consequence
        </CardNote>
      </div>
      <div className="gov-col">
        <ProjectRegistryCard />
        <CardNote>
          node admin › project registry — the registry is a NODE read this build cannot make, so the
          card states the unasked question rather than showing an empty list
        </CardNote>
      </div>
      <div className="gov-col gov-col--wide">
        <UntrustedConsentCard request={consent ?? null} onDecision={onConsentDecision} />
        <CardNote>the consent moment — consequence first, checkbox, verb names the risk</CardNote>
        <SessionProjectsCard projects={sessionProjects} />
        <CardNote>
          many-to-many: associations are editable chips · provenance is one locked mono line — two
          truths, two treatments
        </CardNote>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 · Linked projects (SPACE side) — oracle L150–187
// ---------------------------------------------------------------------------

function LinkedProjectsCard({
  spaceLabel,
  projects,
  factsFor,
  onOpenSessions,
}: {
  spaceLabel: string;
  projects: LoadState<readonly EntitySummary[]>;
  factsFor?: (project: EntitySummary) => ProjectFacts | undefined;
  onOpenSessions?: (projectEntityId: string) => void;
}) {
  const titleId = useId();
  return (
    <GovCard
      labelledBy={titleId}
      title="Linked projects"
      subtitle={spaceLabel}
      action={
        <RefusedControl reason={GOVERNANCE_REASONS.linkProject} glyph="⊕" emphasis="primary">
          Link project
        </RefusedControl>
      }
    >
      <LoadRegion state={projects} what="linked projects">
        {(items) =>
          items.length === 0 ? (
            <EmptyRegion>
              No projects are linked to this space — a linked project is what gives a session a
              working directory to run in. Link one from the CLI with{' '}
              <code className="gov-mono">tm8 project link</code>, or add a project when you create a
              space.
            </EmptyRegion>
          ) : (
            <ul className="gov-rows">
              {items.map((item) => (
                <LinkedProjectRow
                  key={item.id}
                  row={projectRowOf(item, factsFor?.(item))}
                  onOpenSessions={onOpenSessions}
                />
              ))}
            </ul>
          )
        }
      </LoadRegion>
    </GovCard>
  );
}

function LinkedProjectRow({
  row,
  onOpenSessions,
}: {
  row: ProjectRow;
  onOpenSessions?: (projectEntityId: string) => void;
}) {
  const refusal = unlinkRefusal(row);
  const frozen = frozenNote(row);
  return (
    <li className="gov-row" data-testid="linked-project-row">
      <div className="gov-row__head">
        <span aria-hidden className="gov-row__glyph">
          ⬒
        </span>
        <span className="gov-row__title">{row.title}</span>
        <TrustChip row={row} />
        <span className="gov-card__spacer" />
        {/* Unlink is refused for one of three ranked reasons — see
            `unlinkRefusal`. The control is always present and always focusable:
            a hidden Unlink teaches nothing about why the root is pinned. */}
        <DisabledAction reason={refusal} label="Unlink">
          unlink
        </DisabledAction>
      </div>
      <div className="gov-row__meta">
        <KnownText value={row.workingDir} render={(dir) => <span className="gov-mono">{dir}</span>} />
        <span aria-hidden className="gov-row__dot">
          ·
        </span>
        <KnownText
          value={row.usage}
          render={(usage) => (
            <span className="gov-mono">
              {usage.live} live · {usage.recorded} total
            </span>
          )}
        />
        {/* The oracle's actionable refusal (L174): the blocker names its
            remedy AND the place to go. Without a handler the link would be a
            live control that does nothing, so it renders refused instead. */}
        {row.usage.known && row.usage.value.live > 0 ? (
          onOpenSessions ? (
            <button
              type="button"
              className="gov-link"
              onClick={() => onOpenSessions(row.id)}
            >
              view sessions
            </button>
          ) : (
            <DisabledAction
              reason={{
                cause: 'Opening this root’s sessions isn’t wired here',
                remedy: 'the host did not pass an `onOpenSessions` handler to this screen',
              }}
              label="view sessions"
            >
              view sessions
            </DisabledAction>
          )
        ) : null}
      </div>
      {frozen ? (
        <div className="gov-row__frozen">
          <Pill tone="wait">link frozen</Pill>
          <span className="gov-mono">{frozen.text}</span>
          {frozen.spaces.map((space) => (
            <span key={space} className="gov-mono gov-row__space">
              {space}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The trust chip. Three states, and the third is the one that matters: an
 * UNREAD trust level renders hollow with its cause, never as either verdict.
 * Beside it sits the untrust verb, refused with the action registry's own copy.
 */
function TrustChip({ row }: { row: ProjectRow }) {
  return (
    <span className="gov-trust">
      <KnownText
        value={row.trust}
        hollow={<span className="gov-trust__unread">trust unread</span>}
        render={(level) =>
          level === 'trusted' ? (
            <Pill tone="run">✓ trusted</Pill>
          ) : (
            <Pill tone="wait">⚠ untrusted</Pill>
          )
        }
      />
      {row.trust.known && row.trust.value === 'trusted' ? (
        <DisabledAction reason={untrustRefusal()} label="Untrust">
          untrust
        </DisabledAction>
      ) : null}
      {row.trust.known && row.trust.value === 'untrusted' ? (
        <>
          <span className="gov-consequence">
            agents cannot run here until someone with admin trusts it
          </span>
          <DisabledAction reason={GOVERNANCE_REASONS.grantTrust} label="Review and trust">
            review &amp; trust
          </DisabledAction>
        </>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 2 · Project registry (NODE side) — oracle L188–229
// ---------------------------------------------------------------------------

/**
 * The node-admin registry. Every part of this card is unreadable and
 * unwritable from the stamped seam, and the card says so in the place each
 * fact would have been — rather than rendering an empty list, which would
 * assert a measurement (an empty registry) that nobody took.
 *
 * The EDIT form (oracle L215–226) is drawn because the frame draws it: the
 * reader learns what a project record consists of, and each control carries
 * its own refusal. The trust segmented control is the sharpest case — it is
 * the only place in the app where trust would be granted, and `grantTrust` has
 * no ActionRef at all, not even a deferred one.
 */
function ProjectRegistryCard() {
  const titleId = useId();
  return (
    <GovCard
      labelledBy={titleId}
      tone="node"
      title="Project registry"
      subtitle="node admin"
      action={
        <RefusedControl reason={GOVERNANCE_REASONS.newProject} emphasis="primary">
          New project
        </RefusedControl>
      }
    >
      <UnreadRegion reason={GOVERNANCE_REASONS.registryRead} />
      <div className="gov-registry-edit">
        <GovEyebrow>EDIT · THE SHAPE OF A PROJECT RECORD</GovEyebrow>
        <FieldRow label="working dir">
          <span className="gov-mono gov-unknown">not readable from this space</span>
        </FieldRow>
        <FieldRow label="repo url">
          <span className="gov-mono gov-unknown">not readable from this space</span>
        </FieldRow>
        <FieldRow label="trust">
          <span className="gov-segment" role="group" aria-label="Trust level">
            <DisabledAction reason={GOVERNANCE_REASONS.grantTrust} label="Set trusted">
              trusted
            </DisabledAction>
            <DisabledAction reason={untrustRefusal()} label="Set untrusted">
              untrusted
            </DisabledAction>
          </span>
        </FieldRow>
        <RefusedControl reason={GOVERNANCE_REASONS.editProject}>Save project</RefusedControl>
      </div>
    </GovCard>
  );
}

// ---------------------------------------------------------------------------
// 3 · The consent moment — oracle L230–244
// ---------------------------------------------------------------------------

export interface UntrustedConsentRequest {
  /** "scout" — who would run (oracle L232 "Run scout in an untrusted project?"). */
  actorLabel: string;
  /** "vendor-scripts". */
  projectLabel: string;
  /** The node-side id the decision carries back. */
  projectId?: string;
}

export type UntrustedConsentDecision =
  | { consented: true; confirmUntrusted: true; projectId?: string }
  | { consented: false };

/**
 * THE CONSENT MOMENT — and the one genuinely wireable control in T2-2.
 *
 * `confirmUntrusted?: true` is a real member of `ExecutionSpawnInput`
 * (contract.ts:1046), described there as "explicit consent carrier for
 * untrusted Projects and scratch roots". So this card does not simulate
 * anything: it collects the decision and hands it to whoever owns the spawn.
 * With no `onDecision` it renders refused rather than live-and-inert.
 *
 * THE ANATOMY IS THE SAFETY PROPERTY, in the oracle's own order (note L266):
 * consequence FIRST ("the agent gets shell access to this directory — it can
 * read, write and execute anything in it"), then the amber banner naming who
 * carries the risk, then the checkbox, then a verb that NAMES the risk
 * ("Run untrusted ▸", never "OK"). Confirm stays refused until the box is
 * ticked — the tick is the consent, and a confirm that works without it would
 * make the checkbox decorative.
 *
 * When no request is pending the card COLLAPSES to one line rather than
 * rendering an expanded empty region (design law 9). The reader still learns
 * the moment exists and when it appears.
 */
export function UntrustedConsentCard({
  request,
  onDecision,
}: {
  request: UntrustedConsentRequest | null;
  onDecision?: (decision: UntrustedConsentDecision) => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const checkboxId = useId();

  if (!request) {
    return (
      <GovCard>
        <div className="gov-collapsed" data-testid="consent-idle">
          <GovEyebrow>UNTRUSTED-RUN CONSENT</GovEyebrow>
          <span>
            Nothing is waiting on consent. This card appears when a run targets a root whose trust
            has not been granted — the risk is stated, and the run is yours, not the space’s policy.
          </span>
        </div>
      </GovCard>
    );
  }

  const confirmReason = !understood
    ? {
        cause: 'Confirm the risk first',
        remedy: 'this run grants shell access to a root nobody has reviewed',
      }
    : !onDecision
      ? {
          cause: 'This card has nowhere to send the decision',
          remedy: 'the host did not pass an `onDecision` handler — the consent is collected and would be dropped',
        }
      : null;

  return (
    <GovCard>
      <div className="gov-consent" data-testid="consent-card">
        <h3 className="gov-consent__title">
          Run {request.actorLabel} in an untrusted project?
        </h3>
        <p className="gov-consent__body">
          <span className="gov-mono">⬒ {request.projectLabel}</span> hasn’t been reviewed. The agent
          gets shell access to this directory — it can read, write and execute anything in it.
        </p>
        <p className="gov-consent__banner" role="note">
          <span aria-hidden>⚠</span>
          <span className="gov-mono">
            untrusted — this run is on you, not the space’s trust policy
          </span>
        </p>
        <label className="gov-consent__check" htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          I understand the risk
        </label>
        <div className="gov-consent__actions">
          {onDecision ? (
            <button
              type="button"
              className="gov-btn"
              onClick={() => onDecision({ consented: false })}
            >
              Cancel
            </button>
          ) : (
            <DisabledAction
              reason={{
                cause: 'Cancel has nowhere to send the decision',
                remedy: 'the host did not pass an `onDecision` handler',
              }}
              label="Cancel"
            >
              Cancel
            </DisabledAction>
          )}
          {confirmReason ? (
            <DisabledAction reason={confirmReason} label="Run untrusted">
              Run untrusted ▸
            </DisabledAction>
          ) : (
            <button
              type="button"
              className="gov-btn gov-btn--ink"
              onClick={() =>
                onDecision?.({
                  consented: true,
                  confirmUntrusted: true,
                  projectId: request.projectId,
                })
              }
            >
              Run untrusted ▸
            </button>
          )}
        </div>
      </div>
    </GovCard>
  );
}

// ---------------------------------------------------------------------------
// 4 · Session projects: association vs provenance — oracle L245–261
// ---------------------------------------------------------------------------

/**
 * The oracle's third note is the law this component encodes STRUCTURALLY:
 * "Association ≠ provenance. Chips (editable, removable) vs the ⚿ mono line
 * (immutable, set at launch). They never share styling, so history can't be
 * rewritten by editing chips."
 *
 * `SessionProjects.launchedFrom` has no remove handler in its type, so no
 * amount of later editing can give the provenance line one. The chips carry a
 * ✕ that is refused (no seam command creates or destroys an `in_project`
 * edge), and the difference between "no associations" and "we never read the
 * edges" is preserved: the first is a measured empty, the second is hollow.
 */
export function SessionProjectsCard({ projects }: { projects?: SessionProjects }) {
  if (!projects) {
    return (
      <GovCard>
        <div className="gov-collapsed" data-testid="session-projects-idle">
          <GovEyebrow>SESSION DETAIL · PROJECTS</GovEyebrow>
          <span>
            No session is selected. With one, this shows its editable project associations above the
            immutable root it launched from.
          </span>
        </div>
      </GovCard>
    );
  }
  return (
    <GovCard>
      <div className="gov-session-projects" data-testid="session-projects">
        <GovEyebrow>SESSION DETAIL · PROJECTS</GovEyebrow>
        <div className="gov-chips">
          <KnownText
            value={projects.associations}
            hollow={<span className="gov-unknown">associations unread</span>}
            render={(items) =>
              items.length === 0 ? (
                <span className="gov-empty-inline">no project associations</span>
              ) : (
                <>
                  {items.map((item) => (
                    <span key={item.id} className="gov-chip">
                      <span aria-hidden>⬒</span> {item.label}
                      <DisabledAction
                        reason={GOVERNANCE_REASONS.associateProject}
                        label={`Remove ${item.label}`}
                      >
                        ✕
                      </DisabledAction>
                    </span>
                  ))}
                </>
              )
            }
          />
          <RefusedControl reason={GOVERNANCE_REASONS.associateProject}>
            associate
          </RefusedControl>
        </div>
        <div className="gov-provenance">
          <span aria-hidden className="gov-provenance__key">
            ⚿
          </span>
          <KnownText
            value={projects.launchedFrom}
            hollow={<span className="gov-unknown">launch root unread</span>}
            render={(from) =>
              from === null ? (
                <Pill tone="wait">{SCRATCH_LABEL}</Pill>
              ) : (
                <span className="gov-mono">
                  launched from ⬒ {from.label}
                  {from.workingDir.known ? ` · ${from.workingDir.value}` : ''} · immutable
                </span>
              )
            }
          />
        </div>
      </div>
    </GovCard>
  );
}
