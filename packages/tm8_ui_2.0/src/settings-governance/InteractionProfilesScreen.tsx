/**
 * T2-4 — INTERACTION PROFILES. Oracle:
 * `T2 Settings, Trust & Authoring Hi-Fi.dc.html`,
 * `data-screen-label="T2-4 — Interaction profiles"`, lines 392–493.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT BUILD, and why that is the finding
 * rather than an omission.
 *
 * The frame has three columns: a LIST (L398–427), a Z3 DETAIL PANEL
 * (L428–474), and a session PINNED-PROVENANCE card (L476–483). The middle and
 * right columns are ALREADY BUILT — `panels/bodies/RestrictedBody.tsx` renders
 * exactly this kind's detail (its handover names the oracle region: T0-4 lines
 * 714–762, "status-banner / preview / field-rows / items (DEFAULT FOR) /
 * pin-provenance"), inside `EntityDetailPanel`'s own chrome, which owns the
 * action bar and the tab strip.
 *
 * Rebuilding them here would be D64's defect precisely — two renderings of one
 * fact, which is the class the live-session bar was unmounted for. So this
 * screen builds the column that does NOT exist anywhere: the lifecycle-grouped
 * LIST and the space-level governance verbs around it, and it OPENS the
 * existing panel rather than imitating it. The integration note in HANDOVER.md
 * names the exact mount.
 *
 * WHAT IS REAL: the list is a genuine `seam.query()` read, and every row's
 * lifecycle state and version come from `EntitySummary.state` — contract data,
 * not decoration. WHAT IS NOT: run counts and default scopes have no seam read
 * (GG13/GG15) and render hollow; every lifecycle verb (propose, duplicate,
 * retire, set-default) has no executor (GG10–GG12) and renders refused.
 */
import { useId } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { Pill, type PillTone } from '../kit';
import { DisabledAction } from '../panels';
import {
  PROFILE_LIFECYCLE,
  profileGroups,
  profileRowOf,
  rankDefaults,
  type ProfileDefaultScope,
  type ProfileLifecycle,
  type ProfileRow,
} from './governance-model';
import { GOVERNANCE_REASONS } from './reasons';
import type { LoadState } from './port';
import {
  CardNote,
  EmptyRegion,
  GovCard,
  GovEyebrow,
  KnownText,
  LoadRegion,
  RefusedControl,
} from './parts';
import './governance.css';

/**
 * The registry already rules these tones for this kind
 * (`registry.ts:700-704`: draft idle, active run, retired idle). They are
 * restated as a local map ONLY because reading them out of the registry row
 * requires naming the kind, which §15.2 forbids in this lane — and the
 * handover flags the duplication rather than letting it pass silently. If the
 * registry's tones change, this map is the thing that must follow.
 */
const LIFECYCLE_TONE: Record<ProfileLifecycle, PillTone> = {
  draft: 'idle',
  active: 'run',
  retired: 'idle',
};

export interface InteractionProfilesScreenProps {
  spaceLabel: string;
  profiles: LoadState<readonly EntitySummary[]>;
  /**
   * Which scopes default to a profile. Absent ⇒ EVERY row's badge is hollow,
   * which is correct: no seam read supplies it, and "not the default" is a
   * claim this build cannot make.
   */
  defaultsFor?: (profile: EntitySummary) => readonly ProfileDefaultScope[] | undefined;
  /** Opens the EXISTING Z3 detail panel. Absent ⇒ rows refuse, with the reason. */
  onOpenProfile?: (profileId: string) => void;
  /** The row currently open in the panel beside this list. */
  selectedProfileId?: string | null;
}

export function InteractionProfilesScreen({
  spaceLabel,
  profiles,
  defaultsFor,
  onOpenProfile,
  selectedProfileId,
}: InteractionProfilesScreenProps) {
  const titleId = useId();
  return (
    <div className="gov-screen gov-screen--profiles" data-testid="interaction-profiles-screen">
      <div className="gov-col">
        <GovCard
          labelledBy={titleId}
          title={
            <>
              <span aria-hidden>⊜ </span>Profiles
            </>
          }
          subtitle={spaceLabel}
          action={
            <RefusedControl reason={GOVERNANCE_REASONS.newProfile} glyph="＋" emphasis="primary">
              New
            </RefusedControl>
          }
        >
          <LoadRegion state={profiles} what="interaction profiles">
            {(items) => {
              const rows = items.map((item) => profileRowOf(item, defaultsFor?.(item)));
              return items.length === 0 ? (
                <EmptyRegion>
                  This space defines no interaction profiles. Sessions run on the node’s core
                  default until one is proposed and activated.
                </EmptyRegion>
              ) : (
                <div className="gov-groups">
                  {profileGroups(rows).map((group) => (
                    <section key={group.id} className="gov-group">
                      {/*
                        A group with no rows still renders, with a MEASURED
                        zero: we listed every profile in the space and found
                        none in this state. That is a different fact from the
                        hollow counts inside the rows, and the reader can only
                        tell them apart if the honest zero is actually shown.
                      */}
                      <GovEyebrow>
                        {group.label} · {group.rows.length}
                      </GovEyebrow>
                      {group.rows.length === 0 ? (
                        <span className="gov-empty-inline">none in this state</span>
                      ) : (
                        <ul className="gov-rows">
                          {group.rows.map((row) => (
                            <ProfileListRow
                              key={row.id}
                              row={row}
                              selected={row.id === selectedProfileId}
                              onOpen={onOpenProfile}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              );
            }}
          </LoadRegion>
          <footer className="gov-card__foot">
            retired profiles stay referenceable — sessions keep their pin
          </footer>
        </GovCard>
        <CardNote>
          list — lifecycle groups carry measured counts; default badges name their scope, and are
          hollow until a default read exists
        </CardNote>
      </div>

      <div className="gov-col gov-col--wide">
        <LifecycleGovernanceCard />
        <CardNote>
          the lifecycle verbs live beside the list because they are SPACE governance, not entity
          edits — the entity’s own panel (the restricted archetype) renders the detail
        </CardNote>
      </div>
    </div>
  );
}

function ProfileListRow({
  row,
  selected,
  onOpen,
}: {
  row: ProfileRow;
  selected: boolean;
  onOpen?: (profileId: string) => void;
}) {
  const label = `${row.title} — ${row.status}`;
  return (
    <li className={selected ? 'gov-row gov-row--selected' : 'gov-row'} data-testid="profile-row">
      <div className="gov-row__head">
        <span aria-hidden className="gov-row__glyph">
          ⊜
        </span>
        {onOpen ? (
          <button type="button" className="gov-row__open" onClick={() => onOpen(row.id)}>
            {row.title}
          </button>
        ) : (
          <DisabledAction
            reason={{
              cause: 'Opening this profile isn’t wired here',
              remedy: 'the host did not pass an `onOpenProfile` handler — the detail panel exists and nothing routes to it',
            }}
            label={label}
          >
            {row.title}
          </DisabledAction>
        )}
        <span className="gov-card__spacer" />
        <Pill tone={LIFECYCLE_TONE[row.status]}>{row.status}</Pill>
      </div>
      <div className="gov-row__meta">
        <DefaultBadges row={row} />
        <span className="gov-mono">{row.version === null ? 'version unread' : `v${row.version}`}</span>
        <span aria-hidden className="gov-row__dot">
          ·
        </span>
        <KnownText value={row.runs} render={(n) => <span className="gov-mono">{n} runs</span>} />
      </div>
    </li>
  );
}

/**
 * D53 at this surface: the teammate default OUTRANKS the space default, the
 * winner is brass, and the outranked badge stays VISIBLE and grey. Hiding the
 * loser would make the resolution unexplainable at exactly the moment someone
 * asks why a session did not use the space default.
 */
function DefaultBadges({ row }: { row: ProfileRow }) {
  return (
    <KnownText
      value={row.defaultFor}
      hollow={<span className="gov-unknown">defaults unread</span>}
      render={(scopes) => {
        if (scopes.length === 0) return <span className="gov-empty-inline">not a default</span>;
        const { winner, outranked } = rankDefaults(scopes);
        return (
          <>
            {winner ? <Pill tone="brand">{winner.label}</Pill> : null}
            {outranked.map((scope) => (
              <Pill key={`${scope.scope}:${scope.label}`} tone="idle" title="outranked by a more specific default">
                {scope.label}
              </Pill>
            ))}
          </>
        );
      }}
    />
  );
}

/**
 * The lifecycle verbs and the law they obey. Oracle note L486, verbatim in
 * substance: "Lifecycle is one-way: draft → active → retired. Activating
 * creates v(n+1); editing an active profile forces 'duplicate as draft'.
 * Retired stays visible (idle grey), never deleted."
 *
 * Every verb here is refused, and the copy names WHICH mechanism is missing —
 * the contract has the events (`interaction_profile.activated`,
 * `.retired`, contract.ts:328-330) and the seam has no command that emits them.
 * The restricted-kind refusals (no free linking, no children) are the oracle's
 * OWN sentences (L444, L445), kept verbatim: a restriction that teaches is the
 * point of the treatment.
 */
function LifecycleGovernanceCard() {
  const titleId = useId();
  return (
    <GovCard labelledBy={titleId} tone="node" title="Lifecycle" subtitle="one-way, by design">
      <div className="gov-lifecycle">
        <div className="gov-lifecycle__rail" role="list" aria-label="Profile lifecycle">
          {PROFILE_LIFECYCLE.map((state, i) => (
            <span key={state} role="listitem" className="gov-lifecycle__step">
              <Pill tone={LIFECYCLE_TONE[state]}>{state}</Pill>
              {i < PROFILE_LIFECYCLE.length - 1 ? (
                <span aria-hidden className="gov-lifecycle__arrow">
                  →
                </span>
              ) : null}
            </span>
          ))}
        </div>
        <p className="gov-prose">
          Activating creates the next version; editing an active profile forces a duplicate as
          draft. Retiring is not reversible, and a retired profile is never deleted — sessions keep
          their pin, so the version they ran with stays readable forever.
        </p>
        <div className="gov-verbs">
          <RefusedControl reason={GOVERNANCE_REASONS.duplicateProfile}>
            Duplicate as draft
          </RefusedControl>
          <RefusedControl reason={GOVERNANCE_REASONS.retireProfile}>Retire</RefusedControl>
          <RefusedControl reason={GOVERNANCE_REASONS.setProfileDefault} glyph="＋">
            Set default
          </RefusedControl>
        </div>
        <div className="gov-verbs">
          <RefusedControl reason={GOVERNANCE_REASONS.profileLink} glyph="⊕">
            Link
          </RefusedControl>
          <RefusedControl reason={GOVERNANCE_REASONS.profileAddChild}>Add child</RefusedControl>
        </div>
        <p className="gov-prose gov-prose--quiet">
          The prompt a profile carries is not readable here: {GOVERNANCE_REASONS.profilePreview.remedy}.
        </p>
      </div>
    </GovCard>
  );
}
