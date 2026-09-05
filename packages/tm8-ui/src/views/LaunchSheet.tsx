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
 *
 * ── ON A PHONE IT IS A SHEET, AND THE DECISION IS RECORDED HERE ────────────
 *
 * Everything above describes a DESKTOP overlay: `position: absolute` against
 * the view root, 420px wide, riding the panel stack. None of that is available
 * on a 390px phone, and until this change none of it was adapted either — this
 * file contained no reference to `MobileSheet`, `useMobileSurface` or
 * `sheetHost`, so the phone would have drawn the desktop popover verbatim.
 *
 * THE CHOICE MADE, stated so the next reader does not re-open it: the phone
 * arrangement goes through `MobileSheet`, the frame's own sheet host. The
 * alternative — keep the bespoke `.ls` dialog and merely re-measure it at 390 —
 * is rejected by `mobile/CONTRACT.md` §4 on two counts. First, an anchored/
 * absolutely-placed overlay "does not survive the trip to a 390px header": the
 * position of a phone sheet belongs to the FRAME, which is the only thing that
 * knows where the tab bar and the keyboard inset are. Second, "seven bespoke
 * sheets are seven chances to disagree about what dismiss means" — this would
 * have been the eighth, with its own scrim, its own dismiss set and its own
 * idea of how far up the screen it stops.
 *
 * WHAT THE PHONE BRANCH DOES NOT CHANGE. The desktop path is untouched by
 * construction, not by care: `useMobileSurface()` returns `DESKTOP` wherever
 * there is no phone frame, so `oneSurface` is `false` on every desktop mount
 * and the branch below is unreachable there.
 *
 * TWO WITNESSES, DELIBERATELY SEPARATE. `data-testid="launch-sheet"` stays on
 * this component's own root — it answers "did the sheet mount". `MobileSheet`
 * contributes `data-testid="mobile-sheet"` — it answers "did it go through the
 * phone host". They are different questions and an instrument must be able to
 * report them as two fields; collapsing them is how "it rendered" gets read as
 * "it rendered correctly on a phone".
 *
 * THE ROLE MOVES WITH THE ARRANGEMENT. `MobileSheet`'s panel already declares
 * `role="dialog" aria-modal="true"`, so this root drops both on the phone
 * rather than nesting a second modal dialog inside the first — one surface,
 * one dialog, which is what a screen reader is entitled to.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { CredentialProviderName, CredentialsStatusView, EntityId } from '@tm8/contract';
import { Avatar } from '../kit';
import { MobileSheet, useMobileSurface } from '../mobile';
import './launch-sheet-mobile.css';
import {
  accessModeLabel,
  agentTool,
  describeAccessMode,
  LAUNCH_MODES,
  nextAccessMode,
  modelsFor,
  type LaunchCapacity,
  type LaunchConfig,
  type LaunchMemory,
  type LaunchMode,
  type LaunchProfile,
  type LaunchProject,
  type LaunchTarget,
  type LaunchTeammate,
} from '../domain/launch';
import { MEMORY_IDS_MAX } from '../domain/memory';

export interface LaunchSheetProps {
  /** The entity being launched from. The sheet is bound to it and dies with it. */
  subjectId: EntityId;
  /** T5-5's FROM strip: the launch context, named honestly. */
  fromChip: string;
  fromCaption: string;
  teammates: readonly LaunchTeammate[];
  projects: readonly LaunchProject[];
  profiles: readonly LaunchProfile[];
  /**
   * The space's memories, offered as a spawn-time hand-off (D3a). Absent is not
   * the same as empty and the section says which: an omitted list means nobody
   * has read memories into this client, an empty one means the space has none.
   */
  memories?: readonly LaunchMemory[];
  /** Node capacity, stated BEFORE commitment (T5-5 footer). Domain's shape. */
  capacity?: LaunchCapacity;
  /** A refusal renders IN the sheet, never as a toast (T5-5 annotation 6). */
  refusal?: { cause: string; detail: string } | null;
  /** One spawn may be outstanding; the sheet cannot submit or dismiss it. */
  launching?: boolean;
  /** Reads only the viewer's display-safe connection metadata; never a token. */
  loadCredentialStatus?(): Promise<CredentialsStatusView>;
  onLaunch(config: LaunchSelection): void;
  /**
   * D5 — route the subject through the space's resident dispatcher instead of
   * configuring the launch here. Takes ONLY the subject, mirroring
   * `ExecutionDispatchInput`, so this prop cannot grow into a second spawn
   * path: there is nowhere to put a teammate.
   *
   * Absent ⇒ the button renders refused-with-reason, never hidden.
   */
  onDispatch?(request: DispatchSelection): void;
  onCancel(): void;
}

/** Everything dispatch is allowed to know. Deliberately one field. */
export interface DispatchSelection {
  subjectId: EntityId;
}

export interface LaunchSelection extends LaunchConfig {
  subjectId: EntityId;
  teamMemberId: EntityId;
}

/** The resolution order T5-5's annotation states. Only the winner is drawn. */
const RESOLUTION_ORDER = ['teammate default', 'space default', 'node default'] as const;

/** Rosters longer than this get the filter input. Below it, a search box over
 * a list that fits on screen whole is only friction. */
const TEAMMATE_SEARCH_FROM = 5;
type CredentialChoice = '' | 'member' | 'node';
type AgentCredentialProvider = Extract<CredentialProviderName, 'anthropic' | 'openai'>;

const AGENT_CREDENTIAL_PROVIDER: Partial<Record<string, AgentCredentialProvider>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

const CREDENTIAL_PROVIDER_LABEL: Record<CredentialProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  github: 'GitHub',
};

export function LaunchSheet(props: LaunchSheetProps) {
  const { teammates, projects, profiles, memories } = props;

  /* THE ONE FORK. Read from the host's context and never from the window: the
     shell decision is `(pointer: coarse) && width < 500` and `GateApp` has
     already made it once — a second, independently-timed answer here is how two
     shells drift apart (`mobile/surface.tsx` states this at length). */
  const { oneSurface } = useMobileSurface();

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
  const { onCancel, launching = false } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || launching) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel, launching]);

  const [teammateId, setTeammateId] = useState(() => teammates[0]?.id ?? '');
  const initialTeammate = teammates[0];
  const [agentToolId, setAgentToolId] = useState(() => initialTeammate?.agentTool ?? '');
  const [model, setModel] = useState(() => initialTeammate?.model ?? '');
  const [target, setTarget] = useState<LaunchTarget>(() => {
    const project = projects.find((p) => p.selectedByDefault && p.trusted);
    return project ? { kind: 'project', projectId: project.id } : { kind: 'scratch' };
  });
  /*
   * WHY THE INITIALIZER ABOVE IS NOT ENOUGH.
   *
   * It runs once, at mount. `projects` is derived from the gate's
   * `linkedProjects`, which starts as `[]` and is filled by a later read — so a
   * sheet that opens before that read lands sees NO projects, falls to the
   * scratch branch, and stays there. The rows appear a moment later and the
   * default never does: `target` is already `scratch` and nothing recomputes it.
   *
   * The failure is silent and total. The operator sees their project listed,
   * launches, and the session runs in a server temp directory instead of the
   * repository — with no error, because a projectless spawn is a legitimate
   * request that the server honours by minting scratch.
   *
   * Re-seed when the list arrives, and only while the operator has not chosen a
   * target themselves — an explicit `scratch` click must survive a late read.
   */
  const [targetChosen, setTargetChosen] = useState(false);
  useEffect(() => {
    if (targetChosen) return;
    const project = projects.find((p) => p.selectedByDefault && p.trusted);
    if (project) setTarget({ kind: 'project', projectId: project.id });
  }, [projects, targetChosen]);
  const [mode, setMode] = useState<LaunchMode>('worker');
  const [reasoningEffort, setReasoningEffort] = useState<NonNullable<LaunchConfig['reasoningEffort']>>('low');
  // `auto` — the same posture the node falls back to when nothing names one, so
  // this sheet opening on a different default cannot silently change what a
  // launch does. It is the sheet's only pre-selected posture because the sheet
  // always SENDS one (unlike the quick config, which can send nothing at all).
  const [accessMode, setAccessMode] = useState<NonNullable<LaunchConfig['accessMode']>>('auto');
  // Each provider defaults independently to Auto (the absent key). Keeping the
  // UI state provider-keyed means switching Claude ↔ Codex does not carry an
  // Anthropic choice into OpenAI, while GitHub remains independent from both.
  const [credentialChoices, setCredentialChoices] = useState<Record<CredentialProviderName, CredentialChoice>>({
    anthropic: '',
    openai: '',
    github: '',
  });
  const [credentialStatus, setCredentialStatus] = useState<CredentialsStatusView | null>(null);
  const [credentialStatusState, setCredentialStatusState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    props.loadCredentialStatus ? 'loading' : 'idle',
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [rosterQuery, setRosterQuery] = useState('');
  /* NOTHING PRE-SELECTED. Memories are epistemic claims injected into a
     persona's context; the sheet opening on a default set would change what a
     session believes without anyone choosing it. */
  const [memoryIds, setMemoryIds] = useState<readonly EntityId[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const teammate = teammates.find((t) => t.id === teammateId);
  const models = modelsFor(agentToolId);

  // Fetch on sheet mount, not at workspace boot: this is attribution evidence
  // needed at commitment time, and a login/disconnect performed in Settings
  // immediately beforehand must not be replaced by a boot-time cached answer.
  useEffect(() => {
    const load = props.loadCredentialStatus;
    if (!load) return undefined;
    let cancelled = false;
    setCredentialStatusState('loading');
    void load().then(
      (status) => {
        if (cancelled) return;
        setCredentialStatus(status);
        setCredentialStatusState('ready');
      },
      () => {
        if (cancelled) return;
        setCredentialStatus(null);
        setCredentialStatusState('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.loadCredentialStatus]);

  const agentCredentialProvider = AGENT_CREDENTIAL_PROVIDER[agentToolId] ?? null;
  const agentCredentialSource = agentCredentialProvider
    ? credentialChoices[agentCredentialProvider]
    : '';
  const githubCredentialSource = credentialChoices.github;
  const agentConnection = agentCredentialProvider
    ? credentialStatus?.providers.find((entry) => entry.provider === agentCredentialProvider)
    : null;
  const githubConnection = credentialStatus?.providers.find((entry) => entry.provider === 'github');
  const agentIdentity = agentConnection?.connected
    ? agentConnection.login ?? 'connected'
    : null;
  const githubHandle = githubConnection?.connected && githubConnection.login
    ? `@${githubConnection.login.replace(/^@/, '')}`
    : null;
  const agentIdentityCopy = agentCredentialProvider
    ? describeProviderLaunchIdentity({
        provider: agentCredentialProvider,
        source: agentCredentialSource,
        credentialStatus,
        credentialStatusState,
        identity: agentIdentity,
        strictMissing: true,
      })
    : 'This agent tool has no personal credential provider';
  const githubIdentityCopy = describeProviderLaunchIdentity({
    provider: 'github',
    source: githubCredentialSource,
    credentialStatus,
    credentialStatusState,
    identity: githubHandle,
    strictMissing: false,
  });

  /**
   * The roster the picker draws: filtered by the query, with the SELECTED
   * teammate always kept visible even when the filter would drop it — the
   * persona a launch will run as must never be off-screen at commit time.
   */
  const matchingTeammates = useMemo(() => {
    const q = rosterQuery.trim().toLowerCase();
    if (!q) return teammates;
    return teammates.filter(
      (t) => t.name.toLowerCase().includes(q) || t.model.toLowerCase().includes(q),
    );
  }, [teammates, rosterQuery]);
  const visibleTeammates = useMemo(() => {
    if (!teammate || matchingTeammates.some((t) => t.id === teammate.id)) {
      return matchingTeammates;
    }
    return [teammate, ...matchingTeammates];
  }, [matchingTeammates, teammate]);

  /**
   * The resolved profile and WHERE IT CAME FROM. D51 requires the chain to be
   * visible at launch; T5-5 draws only the winner plus a "resolved from X"
   * phrase, so the chain itself is an authored addition (ledgered) rendering
   * the order the canvas states in prose.
   */
  const defaultResolution = useMemo(() => {
    const byTeammate = profiles.find((p) => p.id === teammate?.defaultProfileId);
    if (byTeammate) return { profile: byTeammate, from: `${teammate?.name}'s default`, step: 0 };
    const bySpace = profiles.find((p) => p.isSpaceDefault);
    if (bySpace) return { profile: bySpace, from: 'space default', step: 1 };
    return { profile: profiles.find((p) => p.isServerDefault), from: 'node default', step: 2 };
  }, [profiles, teammate]);
  const resolution = useMemo(() => {
    if (profileId) {
      return { profile: profiles.find((p) => p.id === profileId), from: 'your pick', step: -1 };
    }
    return defaultResolution;
  }, [defaultResolution, profileId, profiles]);
  const profilePickerId = `launch-interaction-profile-${useId()}`;
  const memoryPickerId = `launch-memories-${useId()}`;
  const selectedProfile = resolution.profile;
  const selectedProfileDescription = selectedProfile
    ? `${profileSurfaceDescription(selectedProfile)} · resolved from ${resolution.from}`
    : 'Terminal + Chat · starts in Chat · resolved from node default';
  const defaultOptionName = defaultResolution.profile
    ? `Use resolved default — ${defaultResolution.profile.name}`
    : 'Core Chat — node default';
  const defaultOptionDescription = defaultResolution.profile
    ? `${profileSurfaceDescription(defaultResolution.profile)} · resolved from ${defaultResolution.from}`
    : 'Terminal + Chat · starts in Chat · no authored override';

  const atCapacity = props.capacity !== undefined && props.capacity.slotsFree <= 0;

  const sheet = (
    <div
      className="ls"
      data-testid="launch-sheet"
      data-arrangement={oneSurface ? 'phone' : 'overlay'}
      /* On the phone `MobileSheet`'s panel is already the dialog, so these
         three would nest a second modal inside it. Spread rather than passed
         with a falsy value: `role={undefined}` is the same attribute-absent
         result but reads as if a role were being computed. */
      {...(oneSurface ? {} : { role: 'dialog', 'aria-modal': true, 'aria-label': 'Launch session' })}
    >
      {/*
        THE HEADER IS THE FRAME'S ON A PHONE.

        `MobileSheet` draws the title, the grabber and a 44px ✕, so drawing
        this one too would stack two title rows and two close buttons on the
        smallest screen in the product. And the hint is not merely redundant
        there, it is FALSE: "sheet on the stack · esc closes" names a panel
        stack the phone does not have and a key it does not have either. The
        shell's honesty rules do not stop at refusal cards.
      */}
      {oneSurface ? null : (
        <header className="ls__head">
          <span className="ls__title">Launch session</span>
          <span className="ls__hint">sheet on the stack · esc closes</span>
          <div className="ls__spacer" />
          <button
            type="button"
            className="ls__x"
            disabled={launching}
            onClick={props.onCancel}
            aria-label="Close launch sheet"
          >
            ✕
          </button>
        </header>
      )}

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
        {/* IMPORTANT CONFIGURATION FIRST (user ruling): teammate, then model /
            reasoning effort / permission mode. These used to sit BENEATH the
            whole roster, so on any space with real teammates the settings that
            matter most were below the fold. The roster is now a bounded,
            searchable picker so it can never push them down. */}
        <section className="ls__section">
          <div className="ls__eyebrow">TEAMMATE</div>
          {/* The teammate count is unbounded, so the picker is a SEARCH plus a
              scroll-capped roster rather than an ever-growing radio stack. The
              filter appears only once it earns its row. */}
          {teammates.length > TEAMMATE_SEARCH_FROM && (
            <input
              type="search"
              className="ls__search"
              value={rosterQuery}
              placeholder={`filter ${teammates.length} teammates…`}
              aria-label="Filter teammates"
              data-testid="launch-teammate-search"
              onChange={(event) => setRosterQuery(event.target.value)}
            />
          )}
          <div className="ls__roster" role="radiogroup" aria-label="Teammates">
            {visibleTeammates.map((t) => {
              const on = t.id === teammateId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`ls__row ${on ? 'ls__row--on' : ''}`}
                  onClick={() => {
                    setTeammateId(t.id);
                    setAgentToolId(t.agentTool);
                    setModel(t.model);
                  }}
                >
                  <Avatar
                    actorId={t.id}
                    provenance="agent"
                    label={t.name}
                    initials={t.initial}
                    size={22}
                    className="ls__avatar"
                  />
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
            {matchingTeammates.length === 0 && rosterQuery.trim() !== '' && (
              // The selection is KEPT under a non-matching filter — stated, so
              // an empty roster never reads as "nothing is selected".
              <p className="ls__roster-empty" role="status">
                no teammate matches “{rosterQuery.trim()}” — the current selection is kept
              </p>
            )}
          </div>
        </section>

        <section className="ls__section">
          <div className="ls__eyebrow">CONFIGURATION</div>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">Model</span>
              <span className="ls__rowsub">{agentTool(agentToolId)?.label ?? agentToolId}</span>
              <select
                className="ls__select"
                value={model}
                data-testid="launch-model"
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">Reasoning effort</span>
              <span className="ls__rowsub">passed to the selected provider</span>
              <select
                className="ls__select"
                value={reasoningEffort}
                data-testid="launch-reasoning-effort"
                onChange={(event) => setReasoningEffort(event.target.value as NonNullable<LaunchConfig['reasoningEffort']>)}
              >
                {['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => (
                  <option key={effort} value={effort}>{effort}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">Permission mode</span>
              <span className="ls__rowsub">approval and sandbox posture</span>
              {/* The same one-click cycle the quick config carries, so the two
                  surfaces change posture the same way. The select stays: it is
                  how you jump straight to a posture instead of stepping to it. */}
              <button
                type="button"
                className={`ls__accessbtn ls__accessbtn--${accessMode}`}
                data-testid="launch-access-toggle"
                data-access-mode={accessMode}
                title={`${describeAccessMode(accessMode)} — click to change`}
                aria-label={`Access mode: ${describeAccessMode(accessMode)}. Click to change.`}
                onClick={(event) => {
                  event.preventDefault();
                  // The sheet has committed to an explicit posture, so the
                  // cycle's `null` (inherit) step is not reachable here —
                  // skipping it keeps every click a visible change.
                  setAccessMode((current) => nextAccessMode(current) ?? 'plan');
                }}
              >
                {accessModeLabel(accessMode)}
              </button>
              <select
                className="ls__select"
                value={accessMode}
                data-testid="launch-access-mode"
                onChange={(event) => setAccessMode(event.target.value as NonNullable<LaunchConfig['accessMode']>)}
              >
                <option value="safe">Safe · ask for untrusted actions</option>
                <option value="acceptEdits">Accept edits · workspace write</option>
                <option value="auto">Auto · run what is safe, escalate the rest</option>
                <option value="plan">Plan · read only</option>
                <option value="fullAccess">Full access · bypass safeguards</option>
              </select>
            </span>
          </label>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">
                {agentCredentialProvider
                  ? `${CREDENTIAL_PROVIDER_LABEL[agentCredentialProvider]} credential`
                  : 'Agent credential'}
              </span>
              <span className="ls__rowsub">
                {agentCredentialProvider
                  ? `${CREDENTIAL_PROVIDER_LABEL[agentCredentialProvider]} account used by ${agentTool(agentToolId)?.label ?? agentToolId}`
                  : 'this tool has no personal credential provider'}
              </span>
              <select
                className="ls__select"
                value={agentCredentialSource}
                data-testid="launch-agent-credential-source"
                disabled={!agentCredentialProvider}
                onChange={(event) => {
                  if (!agentCredentialProvider) return;
                  const source = event.target.value as CredentialChoice;
                  setCredentialChoices((current) => ({
                    ...current,
                    [agentCredentialProvider]: source,
                  }));
                }}
              >
                <option value="">Auto · mine if connected, else the node&apos;s</option>
                <option value="member">
                  {agentCredentialProvider && agentIdentity
                    ? `My ${CREDENTIAL_PROVIDER_LABEL[agentCredentialProvider]} · ${agentIdentity}`
                    : 'My credential · refuse if this provider is not connected'}
                </option>
                <option value="node">Node credential · this server&apos;s agent account</option>
              </select>
              <span
                className="ls__rowsub"
                data-testid="launch-agent-identity"
                aria-live="polite"
              >
                {agentIdentityCopy}
              </span>
            </span>
          </label>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">GitHub credential</span>
              <span className="ls__rowsub">used by gh, git push and pull requests</span>
              <select
                className="ls__select"
                value={githubCredentialSource}
                data-testid="launch-github-credential-source"
                onChange={(event) => {
                  const source = event.target.value as CredentialChoice;
                  setCredentialChoices((current) => ({ ...current, github: source }));
                }}
              >
                <option value="">Auto · mine if connected, else the node&apos;s</option>
                <option value="member">
                  {githubHandle
                    ? `My GitHub · ${githubHandle}`
                    : 'My GitHub · block node fallback if not connected'}
                </option>
                <option value="node">Node GitHub · this server&apos;s account</option>
              </select>
              <span
                className="ls__rowsub"
                data-testid="launch-github-identity"
                aria-live="polite"
              >
                {githubIdentityCopy}
              </span>
            </span>
          </label>
        </section>

        <section className="ls__section">
          <div className="ls__eyebrow">WORKING DIRECTORY</div>
          <button
            type="button"
            role="radio"
            aria-checked={target.kind === 'scratch'}
            className={`ls__row ${target.kind === 'scratch' ? 'ls__row--on' : ''}`}
            onClick={() => {
              setTargetChosen(true);
              setTarget({ kind: 'scratch' });
            }}
          >
            <span className="ls__glyph" aria-hidden="true">◌</span>
            <span className="ls__rowtext">
              <span className="ls__rowname ls__rowname--quiet">scratch — no project</span>
              <span className="ls__rowsub">server-managed session directory</span>
            </span>
            <span className={`ls__check ${target.kind === 'scratch' ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
              {target.kind === 'scratch' ? '✓' : ''}
            </span>
          </button>
          {projects.map((p) => {
            const on = target.kind === 'project' && target.projectId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={!p.trusted || undefined}
                // L6/D28: untrusted is DISABLED WITH REASON and still
                // focusable — the reason is unreachable if the control is not.
                className={`ls__row ${on ? 'ls__row--on' : ''} ${p.trusted ? '' : 'ls__row--refused'}`}
                onClick={(e) => {
                  if (!p.trusted) {
                    e.preventDefault();
                    return;
                  }
                  setTargetChosen(true);
                  setTarget({ kind: 'project', projectId: p.id });
                }}
                title={p.trusted ? undefined : p.reason}
              >
                <span className="ls__glyph" aria-hidden="true">⬒</span>
                <span className="ls__rowtext">
                  <span className="ls__rowname">{p.name}</span>
                  <span className={`ls__rowsub ${p.trusted ? 'ls__rowsub--ok' : 'ls__rowsub--bad'}`}>
                    {p.trusted ? p.detail : p.reason}
                    {on ? ' · initial cwd' : ''}
                  </span>
                </span>
                <span className={`ls__check ${on ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </section>

        {/* Down here with the other rarely-touched settings (user ruling): the
            mode is a topology choice most launches never change. */}
        <section className="ls__section">
          <div className="ls__eyebrow">SESSION MODE</div>
          <label className="ls__row ls__row--inert">
            <span className="ls__rowtext">
              <span className="ls__rowname">Session mode</span>
              <span className="ls__rowsub">
                {LAUNCH_MODES.find((option) => option.id === mode)?.description ?? ''}
              </span>
              <select
                className="ls__select"
                value={mode}
                data-testid="launch-mode"
                onChange={(event) => setMode(event.target.value as LaunchMode)}
              >
                {LAUNCH_MODES.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </span>
          </label>
        </section>

        <section className="ls__section">
          <div className="ls__eyebrow">INTERACTION PROFILE</div>

          <div className="ls__row ls__row--inert">
            <span className="ls__glyph" aria-hidden="true">⛭</span>
            <span className="ls__rowtext">
              <span className="ls__rowname">{selectedProfile?.name ?? 'Core Chat — node default'}</span>
              <span className="ls__rowsub">
                {selectedProfileDescription} · profiles narrow, never grant
              </span>
            </span>
            <button
              type="button"
              className="ls__change"
              aria-label="Change interaction profile"
              aria-expanded={profileOpen}
              aria-controls={profilePickerId}
              onClick={() => setProfileOpen((o) => !o)}
            >
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
            <div
              id={profilePickerId}
              className="ls__picker"
              role="radiogroup"
              aria-label="Interaction profile options"
            >
              <button
                type="button"
                role="radio"
                aria-checked={profileId === ''}
                className={`ls__row ${profileId === '' ? 'ls__row--on' : ''}`}
                onClick={() => {
                  setProfileId('');
                  setProfileOpen(false);
                }}
              >
                <span className="ls__glyph" aria-hidden="true">◉</span>
                <span className="ls__rowtext">
                  <span className="ls__rowname">{defaultOptionName}</span>
                  <span className="ls__rowsub">{defaultOptionDescription}</span>
                </span>
                <span className={`ls__check ${profileId === '' ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
                  {profileId === '' ? '✓' : ''}
                </span>
              </button>
              {profiles.length === 0 ? (
                <p className="ls__profile-empty" role="status">
                  No authored profiles yet. Core Chat remains available.
                </p>
              ) : null}
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={profileId === p.id}
                  aria-disabled={p.status !== 'active' || undefined}
                  className={`ls__row ${profileId === p.id ? 'ls__row--on' : ''} ${p.status === 'active' ? '' : 'ls__row--refused'}`}
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
                      {p.status === 'active'
                        ? `v${p.version} · ${profileSurfaceDescription(p)}`
                        : `v${p.version} · ${statusReason(p.status)}`}
                    </span>
                  </span>
                  <span className={`ls__check ${profileId === p.id ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
                    {profileId === p.id ? '✓' : ''}
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

        {/*
          * MEMORIES — the spawn-time hand-off (D3a, `memoryIds`).
          *
          * A PICKER, NOT A MANAGER. Nothing here creates, edits, supersedes or
          * forgets: those live on the teammate's working set and the memory's
          * own panel. This screen answers exactly one question — "what extra
          * context should THIS session start with" — and every control that
          * answered a different one would be a second place to author memories.
          *
          * WHY IT SAYS "this session only": these ids are injected for the
          * spawn and do NOT join the teammate's working set. The two are easy
          * to confuse precisely because they land in the same manifest field,
          * and a picker that quietly taught a persona something permanent
          * would be a very quiet surprise.
          */}
        <section className="ls__section">
          <div className="ls__eyebrow">MEMORIES</div>
          <div className="ls__row ls__row--inert">
            <span className="ls__glyph" aria-hidden="true">◈</span>
            <span className="ls__rowtext">
              <span className="ls__rowname">
                {memoryIds.length === 0
                  ? 'None — the teammate’s own working set still applies'
                  : `${String(memoryIds.length)} picked for this session`}
              </span>
              <span className="ls__rowsub">
                injected at spawn for this session only · not added to the persona
              </span>
            </span>
            {memories ? (
              <button
                type="button"
                className="ls__change"
                aria-label="Change picked memories"
                aria-expanded={memoryOpen}
                aria-controls={memoryPickerId}
                onClick={() => setMemoryOpen((o) => !o)}
              >
                change ▾
              </button>
            ) : null}
          </div>

          {/* ABSENT AND EMPTY ARE DIFFERENT FACTS, and this is the whole reason
              the prop is optional rather than defaulted to []. "No memories in
              this space" is a measurement; "nobody read them" is not, and
              rendering the second as the first is the hollow-value law. */}
          {!memories ? (
            <p className="ls__profile-empty" role="status">
              Memories have not been read into this client, so none can be
              offered. This is unknown, not empty.
            </p>
          ) : null}

          {memoryOpen && memories ? (
            <div
              id={memoryPickerId}
              className="ls__picker"
              role="group"
              aria-label="Memory options"
            >
              {memories.length === 0 ? (
                <p className="ls__profile-empty" role="status">
                  This space has no memories yet.
                </p>
              ) : null}
              {memories.map((memory) => {
                const on = memoryIds.includes(memory.id);
                // The cap is the CONTRACT's (`memoryIds: max(32)`), enforced
                // here so the 33rd pick is refused with a reason instead of the
                // node rejecting a launch the viewer already committed to.
                const capped = !on && memoryIds.length >= MEMORY_IDS_MAX;
                return (
                  <button
                    key={memory.id}
                    type="button"
                    // CHECKBOX, not radio: this is a set, and a radiogroup here
                    // would announce single-choice to a screen reader.
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={capped || undefined}
                    className={`ls__row ${on ? 'ls__row--on' : ''} ${capped ? 'ls__row--refused' : ''}`}
                    title={capped
                      ? `The contract caps a spawn at ${String(MEMORY_IDS_MAX)} memories.`
                      : memory.detail}
                    onClick={(event) => {
                      if (capped) return event.preventDefault();
                      setMemoryIds((current) => (
                        current.includes(memory.id)
                          ? current.filter((id) => id !== memory.id)
                          : [...current, memory.id]
                      ));
                    }}
                  >
                    <span className="ls__glyph" aria-hidden="true">◈</span>
                    <span className="ls__rowtext">
                      <span className="ls__rowname">{memory.statement}</span>
                      {/* The SCOPE, not just the claim: picking a memory blind
                          is how a true statement about the wrong subject gets
                          injected. `mark` rides along so a disputed claim
                          cannot be picked without seeing that it is disputed. */}
                      <span className="ls__rowsub">
                        {memory.mark} · {memory.subjectScope}
                      </span>
                    </span>
                    <span className={`ls__check ${on ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
                      {on ? '✓' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
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
            {props.capacity
              ? `${String(props.capacity.slotsTotal)} slots, ${String(props.capacity.slotsTotal - props.capacity.slotsFree)} in use`
              : 'capacity unavailable — the node will decide at commit'}
          </span>
        </span>
        <div className="ls__spacer" />
        <button type="button" className="ls__cancel" disabled={launching} onClick={props.onCancel}>
          Cancel
        </button>
        {/*
          * DISPATCH — D5, beside the manual flow rather than inside it.
          *
          * IT IGNORES EVERY CONTROL ABOVE IT, and that is the point rather than
          * an oversight. `ExecutionDispatchInput` carries no launch
          * configuration at all — the contract's own comment is that "the
          * moment a caller can name the teammate, it is spawning, not
          * dispatching" — so the dispatcher chooses the teammate AND the
          * memories itself. Forwarding the sheet's picks would be impossible
          * and pretending to would be a lie in the direction users most want to
          * believe.
          *
          * WHICH IS WHY THE TITLE SAYS SO. A control that silently discards a
          * form the viewer has just filled in is the worst class of surprise:
          * everything looks like it was honoured.
          *
          * DISABLED-WITH-REASON when no handler is wired, never hidden — a
          * missing button would claim this node cannot dispatch.
          */}
        <button
          type="button"
          className="ls__dispatch"
          data-testid="launch-dispatch"
          aria-disabled={props.onDispatch ? undefined : true}
          title={
            props.onDispatch
              ? 'Hand this subject to the space\u2019s dispatcher. It picks the teammate and the memories — the settings above are NOT used.'
              : 'Dispatch is not wired on this surface, so nothing would be routed.'
          }
          onClick={(event) => {
            if (!props.onDispatch) return event.preventDefault();
            props.onDispatch({ subjectId: props.subjectId });
          }}
        >
          Dispatch ⇥
        </button>
        <button
          type="button"
          className="ls__launch"
          disabled={!teammate || atCapacity || launching}
          aria-busy={launching || undefined}
          onClick={() => {
            if (!teammate || atCapacity || launching) return;
            const credentialSources: NonNullable<LaunchConfig['credentialSources']> = {};
            if (agentCredentialProvider && agentCredentialSource) {
              credentialSources[agentCredentialProvider] = agentCredentialSource;
            }
            if (githubCredentialSource) credentialSources.github = githubCredentialSource;
            props.onLaunch({
              subjectId: props.subjectId,
              teamMemberId: teammate.id,
              agentToolId: agentToolId || null,
              model: model || null,
              reasoningEffort,
              accessMode,
              ...(Object.keys(credentialSources).length > 0 ? { credentialSources } : {}),
              mode,
              target,
              ...(profileId ? { interactionProfileId: profileId } : {}),
              /* Omitted when nothing was picked: an absent field and an empty
                 array are not the same statement to the node. */
              ...(memoryIds.length > 0 ? { memoryIds } : {}),
            });
          }}
        >
          {launching ? 'Launching…' : 'Launch ▸'}
        </button>
      </footer>
    </div>
  );

  if (!oneSurface) return sheet;

  return (
    <MobileSheet
      title="Launch session"
      /*
       * EVERY DISMISSAL ROUTE GOES THROUGH ONE CALLBACK — the ✕, the backdrop
       * and Escape all arrive here — so the in-flight guard cannot be wired on
       * one of them and forgotten on the other two.
       *
       * AND IT MUST BE GUARDED. The desktop sheet disables its ✕ and its Cancel
       * while `launching`, because one spawn may be outstanding and the sheet
       * can neither submit nor dismiss it. A backdrop tap that dropped the
       * surface mid-spawn would leave a session starting with nothing on screen
       * saying so — the phone would be the one shell where the outstanding
       * transaction is dismissable.
       */
      onDismiss={() => {
        if (launching) return;
        props.onCancel();
      }}
    >
      {sheet}
    </MobileSheet>
  );
}

function describeProviderLaunchIdentity(input: {
  provider: CredentialProviderName;
  source: CredentialChoice;
  credentialStatus: CredentialsStatusView | null;
  credentialStatusState: 'idle' | 'loading' | 'ready' | 'error';
  identity: string | null;
  /** Missing personal agent auth refuses launch; missing GitHub only blocks fallback. */
  strictMissing: boolean;
}): string {
  const label = CREDENTIAL_PROVIDER_LABEL[input.provider];
  if (input.credentialStatusState === 'loading') return `Checking your ${label} identity…`;
  if (input.credentialStatusState === 'error') {
    return `${label} identity unavailable · the server will decide at launch`;
  }
  if (!input.credentialStatus) return `${label} identity is checked when this sheet is connected to a node`;

  if (input.source === 'node') {
    return input.identity
      ? `${label} for this session: node account · your ${input.identity} connection is not injected`
      : `${label} for this session: node account`;
  }
  if (input.provider === 'github' && input.credentialStatus.gitCredentialStore === 'absent') {
    return 'GitHub identity unknown · this node cannot measure the credential store';
  }
  if (input.source === 'member') {
    if (input.identity) {
      return `${label} for this session: ${input.identity} · isolated to your member account`;
    }
    return input.strictMissing
      ? `${label} for this session: none · launch will be refused`
      : `${label} for this session: none · node fallback is blocked`;
  }
  return input.identity
    ? `${label} for this session: ${input.identity} · your connection wins in Auto`
    : `${label} for this session: node fallback · no personal ${label} connection`;
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

function profileSurfaceDescription(profile: LaunchProfile): string {
  const surfaces = profile.contentSurfaces.map((surface) =>
    surface === 'terminal' ? 'Terminal' : 'Chat').join(' + ');
  const initial = profile.initialContentSurface === 'terminal' ? 'Terminal' : 'Chat';
  return `${surfaces} · starts in ${initial}`;
}
