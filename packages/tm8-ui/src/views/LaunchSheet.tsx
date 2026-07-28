/**
 * LaunchSheet — the full launch configuration (D44/D51, T5-5 anatomy).
 *
 * COMPOSITION, as ruled: an OVERLAY over the centre's stack region, not a
 * column and not a Z4 view. The canvas says "rides the panel stack … so launch
 * never loses the workspace behind it", and three things confirm overlay rather
 * than column:
 *   · the drawn shadow is `--pn-sh-pop` — elevation over content; no stack
 *     panel carries one;
 *   · "never loses the workspace behind it" means the grid stays AS-IS
 *     beneath, which a column that reshapes the track violates;
 *   · A1a measured that a stack-order column would consume width `cMin(V)`
 *     never reserved — `selectVisibleCount` knows pinned+stack and nothing
 *     else — squeezing panels under their 320 floor. An L4 violation arriving
 *     through a selector that is correctly answering a question nobody asked.
 * So this component touches NO geometry: not V, not cMin, not selectPanelIds.
 * That is the point of the ruling, and adding a geometry contract here would
 * quietly reintroduce the problem the ruling avoids.
 *
 * THREE SHELL OBLIGATIONS ride with it (A1a's findings, all mandatory) — see
 * `useLaunchSheet` below for two of them; the third is that no cMin contract
 * exists, which is enforced by there being no import of it in this file.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { LaunchCapacity } from '../domain/launch';
import type { LaunchProject, LaunchProfile, LaunchTeammate } from './launch-fixtures';

export interface LaunchSheetProps {
  /** The entity being launched from. The sheet is bound to it and dies with it. */
  subjectId: EntityId;
  /** T5-5's FROM strip: the launch context, named honestly. */
  fromChip: string;
  fromCaption: string;
  teammates: readonly LaunchTeammate[];
  projects: readonly LaunchProject[];
  profiles: readonly LaunchProfile[];
  /** Node capacity, stated BEFORE commitment (T5-5 footer). Domain's shape. */
  capacity: LaunchCapacity;
  /** A refusal renders IN the sheet, never as a toast (T5-5 annotation 6). */
  refusal?: { cause: string; detail: string } | null;
  onLaunch(config: LaunchSelection): void;
  onCancel(): void;
}

export interface LaunchSelection {
  subjectId: EntityId;
  teammateId: string;
  /** M:N, RULING J. First pick is the initial cwd — provenance only. */
  projectIds: string[];
  profileId: string;
}

/** The resolution order T5-5's annotation states. Only the winner is drawn. */
const RESOLUTION_ORDER = ['teammate default', 'space default', 'server default'] as const;

export function LaunchSheet(props: LaunchSheetProps) {
  const { teammates, projects, profiles } = props;

  /**
   * ESC CLOSES THE SHEET — the ACTING half of the modal contract.
   *
   * Declaring the modal (useLaunchSheet's `isModalOpen`) only makes PanelStack
   * DECLINE to pop the panel underneath. That is necessary and it is not
   * sufficient: with the guard in place and no handler here, Escape was
   * swallowed — the wrong behaviour suppressed, the right one never installed —
   * while the header advertised "esc closes". A surface that names a dismissal
   * it does not implement is an honesty defect, not merely a missing feature.
   *
   * `capture: true` so the sheet takes the key before the window-level
   * listeners, and `stopPropagation` so exactly one surface consumes it — the
   * §7 layer law: whoever handles the event consumes it.
   */
  const { onCancel } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const [teammateId, setTeammateId] = useState(() => teammates[0]?.id ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(() =>
    projects.filter((p) => p.selectedByDefault && p.trusted).map((p) => p.id),
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileId, setProfileId] = useState('');

  const teammate = teammates.find((t) => t.id === teammateId);

  /**
   * The resolved profile and WHERE IT CAME FROM. D51 requires the chain to be
   * visible at launch; T5-5 draws only the winner plus a "resolved from X"
   * phrase, so the chain itself is an authored addition (ledgered) rendering
   * the order the canvas states in prose.
   */
  const resolution = useMemo(() => {
    if (profileId) {
      return { profile: profiles.find((p) => p.id === profileId), from: 'your pick', step: -1 };
    }
    const byTeammate = profiles.find((p) => p.id === teammate?.defaultProfileId);
    if (byTeammate) return { profile: byTeammate, from: `${teammate?.name}'s default`, step: 0 };
    const bySpace = profiles.find((p) => p.isSpaceDefault);
    if (bySpace) return { profile: bySpace, from: 'space default', step: 1 };
    return { profile: profiles.find((p) => p.isServerDefault), from: 'server default', step: 2 };
  }, [profileId, profiles, teammate]);

  const toggleProject = (id: string) =>
    setProjectIds((current) =>
      current.includes(id) ? current.filter((p) => p !== id) : [...current, id],
    );

  return (
    <div className="ls" role="dialog" aria-modal="true" aria-label="Launch session" data-testid="launch-sheet">
      <header className="ls__head">
        <span className="ls__title">Launch session</span>
        <span className="ls__hint">sheet on the stack · esc closes</span>
        <div className="ls__spacer" />
        <button type="button" className="ls__x" onClick={props.onCancel} aria-label="Close launch sheet">
          ✕
        </button>
      </header>

      {/* FROM strip — the launch context, so provenance is visible before commit. */}
      <div className="ls__from">
        <span className="ls__eyebrow">FROM</span>
        <span className="ls__chip">{props.fromChip}</span>
        <span className="ls__caption">{props.fromCaption}</span>
      </div>

      {/* The ONLY scrolling region. Header, FROM and footer stay pinned — that
          is what the canvas draws, and it keeps the commit control reachable
          however long the project list grows. */}
      <div className="ls__body">
        <section className="ls__section">
          <div className="ls__eyebrow">TEAMMATE</div>
          {teammates.map((t) => {
            const on = t.id === teammateId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`ls__row ${on ? 'ls__row--on' : ''}`}
                onClick={() => setTeammateId(t.id)}
              >
                <span className="ls__avatar" aria-hidden="true">{t.initial}</span>
                <span className="ls__rowtext">
                  <span className="ls__rowname">{t.name}</span>
                  {/* Model is the row's SUBTITLE, not a fourth section — D51's
                      five items are concerns, not sections (ruled). */}
                  <span className="ls__rowsub">
                    {t.model} · {t.agentTool} · owned by {t.owner}
                  </span>
                </span>
                {on && <span className="ls__check ls__check--radio" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </section>

        <section className="ls__section">
          <div className="ls__eyebrow">PROJECTS — PICK ANY, OR NONE</div>
          {projects.map((p) => {
            const on = projectIds.includes(p.id);
            const first = projectIds[0] === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-disabled={!p.trusted || undefined}
                // L6/D28: untrusted is DISABLED WITH REASON and still
                // focusable — the reason is unreachable if the control is not.
                className={`ls__row ${on ? 'ls__row--on' : ''} ${p.trusted ? '' : 'ls__row--refused'}`}
                onClick={(e) => (p.trusted ? toggleProject(p.id) : e.preventDefault())}
                title={p.trusted ? undefined : p.reason}
              >
                <span className="ls__glyph" aria-hidden="true">{p.scratch ? '◌' : '⬒'}</span>
                <span className="ls__rowtext">
                  <span className={p.scratch ? 'ls__rowname ls__rowname--quiet' : 'ls__rowname'}>
                    {p.name}
                  </span>
                  <span className={`ls__rowsub ${p.trusted ? 'ls__rowsub--ok' : 'ls__rowsub--bad'}`}>
                    {p.trusted ? p.detail : p.reason}
                    {first ? ' · initial cwd' : ''}
                  </span>
                </span>
                <span className={`ls__check ${on ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </section>

        <section className="ls__section">
          <div className="ls__eyebrow">INTERACTION PROFILE</div>

          <div className="ls__row ls__row--inert">
            <span className="ls__glyph" aria-hidden="true">⛭</span>
            <span className="ls__rowtext">
              <span className="ls__rowname">{resolution.profile?.name ?? 'no profile'}</span>
              <span className="ls__rowsub">
                resolved from {resolution.from} · profiles narrow, never grant
              </span>
            </span>
            <button type="button" className="ls__change" onClick={() => setProfileOpen((o) => !o)}>
              change ▾
            </button>
          </div>

          {/* D51 requires the CHAIN visible. T5-5 draws only the winner, so the
              chain is authored: brass marks the winning step (D53 — brass is
              the winner; the one frame that puts brass on the outranked scope
              disagrees with both its own prose and the suite convention). */}
          <div className="ls__chain" aria-label="Profile resolution">
            {RESOLUTION_ORDER.map((step, i) => (
              <span key={step} className="ls__chainstep">
                <span className={`ls__step ${resolution.step === i ? 'ls__step--won' : ''}`}>{step}</span>
                {i < RESOLUTION_ORDER.length - 1 && <span className="ls__arrow" aria-hidden="true">→</span>}
              </span>
            ))}
          </div>

          {profileOpen && (
            <div className="ls__picker">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-disabled={p.status !== 'active' || undefined}
                  className={`ls__row ${p.status === 'active' ? '' : 'ls__row--refused'}`}
                  onClick={(e) => {
                    if (p.status !== 'active') return e.preventDefault();
                    setProfileId(p.id);
                    setProfileOpen(false);
                  }}
                  title={p.status === 'active' ? undefined : statusReason(p.status)}
                >
                  <span className="ls__glyph" aria-hidden="true">⊜</span>
                  <span className="ls__rowtext">
                    <span className="ls__rowname">{p.name}</span>
                    <span className={`ls__rowsub ${p.status === 'active' ? '' : 'ls__rowsub--bad'}`}>
                      {p.status === 'active' ? `v${p.version}` : statusReason(p.status)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Stated BEFORE the commit control, per T2-4's law and D51. Flat
              statement of fact, not a warning — the canvas gives it the
              quietest grey in the palette, and that tone is deliberate. */}
          <span className="ls__pinned">
            pinned at launch — immutable for this session&apos;s whole life (T2-4)
          </span>
        </section>

        {props.refusal && (
          // T5-5: refusal renders IN the sheet — red word, cause, what did NOT
          // happen, and the picks kept. Never a toast apology.
          <div className="ls__refusal" role="alert">
            <span className="ls__refusalhead">
              <span className="ls__refusaldot" aria-hidden="true" />
              {props.refusal.cause}
            </span>
            <span className="ls__refusalbody">{props.refusal.detail}</span>
          </div>
        )}
      </div>

      <footer className="ls__foot">
        <span className="ls__capacity">
          node loopback ·{' '}
          <span className="ls__slots">
            {props.capacity.slotsTotal} slots, {props.capacity.slotsTotal - props.capacity.slotsFree} in
            use
          </span>
        </span>
        <div className="ls__spacer" />
        <button type="button" className="ls__cancel" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ls__launch"
          onClick={() =>
            props.onLaunch({
              subjectId: props.subjectId,
              teammateId,
              projectIds,
              profileId: resolution.profile?.id ?? '',
            })
          }
        >
          Launch ▸
        </button>
      </footer>
    </div>
  );
}

/**
 * Authored copy for non-selectable profiles. T2-4 draws draft/retired rows as
 * AUTHORING targets (still clickable there) and never as launch options, so no
 * pick-time refusal copy exists in the suite. D51 requires the honesty, and
 * the vocabulary is borrowed from T5-5's untrusted-project row: a mono reason
 * that names the mechanism and points somewhere actionable.
 */
function statusReason(status: 'draft' | 'retired'): string {
  return status === 'draft'
    ? 'draft — not activated yet · activate it in Settings ↗'
    : 'retired — kept for sessions already pinned to it · pick an active profile';
}
