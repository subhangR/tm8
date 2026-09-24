import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LaunchModelEffort } from '@tm8/contract';

import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../rich-input';
import type { FileUploadTask } from '../files/upload';
import {
  accessModeLabel,
  describeAccessMode,
  effortLabel,
  LAUNCH_MODES,
  WORKDIR_MODE_OPTIONS,
  type LaunchAccessMode,
  type LaunchCredentialSource,
  type LaunchMode,
  type LaunchTeammate,
  type WorkdirMode,
} from '../domain/launch';
import { Avatar } from '../kit';
import { useDismissable } from '../panels/useDismissable';
import { TITLE_MAX } from './prompt-title';

/**
 * THE NEW SESSION COMPOSER — type a prompt, press Enter, get a running agent.
 *
 * THE SHAPE IS THE "Launch Session Composer" CANVAS (design import,
 * 2026-09-06): one card, three bands. A HEADER names where the work will land
 * (the working-directory picker), carries the overflow menu for the rarely-
 * touched knobs (credential, session mode, working copy), and takes an
 * optional title. The PROMPT is the middle and the point. A FOOTER holds the
 * per-launch knobs — model, reasoning effort, permission posture, teammate —
 * and the Launch button.
 *
 * WHY THE CONFIG IS CONTROLS NOW, NOT A CAPTION. The previous revision drew a
 * read-only "→ teammate · model · workdir · access" line under the card,
 * because a one-keystroke spawn demands the config be visible at the moment it
 * commits. The canvas satisfies the same ruling more directly: every fact that
 * line stated is now a live control that STILL states its current value the
 * entire time you type. Nothing became less visible; it became editable.
 *
 * WHY THIS IS NOT THE CHAT HOME COMPOSER, since it deliberately looks like
 * one: that composer is inline JSX inside `ChatHomeScreen`, welded to screen
 * state. What IS shared is the part that matters — `useRichInput`,
 * `TriggerPopover` and `AttachmentChips` — so skills, paste, drag-drop, upload
 * staging and IME-safe Enter are one implementation, and only the markup is
 * this file's.
 *
 * PROPS-ONLY, NO STORE. Everything arrives as a prop and every decision leaves
 * as a callback, so it renders in a test and a gallery without a node behind
 * it. The screen owns the create/spawn AND the config state; this owns the box
 * and its menus' open/closed-ness, which is honest local UI state.
 */

/** One row of the working-directory menu: scratch, or a linked project. */
export interface ComposerWorkdir {
  /** `'scratch'`, or the project id. */
  id: string;
  name: string;
  /** The sub-line: the project's detail (trust · path) or the scratch description. */
  detail: string;
  /** Present ⇒ not selectable, rendered disabled WITH this reason (L6). */
  disabledReason?: string;
}

export interface NewSessionComposerProps {
  draft: string;
  onDraftChange(next: string): void;
  /** Enter, or the Launch button. The screen decides what that means. */
  onSubmit(): void;
  /** True while the create/spawn is in flight — withdraws Enter and the button. */
  busy: boolean;
  /**
   * Whether an empty prompt withholds Launch. The canvas's own prop, default
   * true: the create screen mints a task FROM the prompt, so empty is not
   * ready. The Run popup launches an EXISTING task, where the prompt is
   * optional extra context — it passes false.
   */
  requirePrompt?: boolean;
  /** The prompt's placeholder — the canvas's own prop, with its default. */
  promptPlaceholder?: string;
  /**
   * Escape with NO menu open, when this card is hosted as a popup. Layered
   * exactly as the canvas rules it: a menu up consumes Escape to close itself;
   * only the next Escape reaches this. Absent (the full-screen host) means
   * Escape past the menus is nobody's — it falls through untouched.
   */
  onDismissRequest?: () => void;
  /**
   * Why this cannot be sent right now, in words. Present means Launch is
   * refused WITH A REASON rather than greyed out silently — the same honesty
   * rule the other composers follow.
   */
  refusal?: string | null;
  /**
   * A previous attempt's reason, shown under the card WITHOUT withholding
   * Launch. The popup uses this for a node/save refusal: the tile stays up
   * to be corrected, and retrying is the point of keeping it.
   */
  notice?: string | null;
  /**
   * The name the task gets if the title field stays empty — derived live from
   * the prompt's first sentence. Shown as the title input's placeholder, so
   * the user watches their sentence become the task's name and can overrule it
   * in place instead of discovering it afterwards.
   */
  derivedTitle: string;
  /** The explicit title override. Empty means "use the derived one". */
  title: string;
  onTitleChange(next: string): void;

  /** Scratch first, then the linked projects — the launch target menu. */
  workdirs: readonly ComposerWorkdir[];
  workdirId: string;
  onPickWorkdir(id: string): void;

  /** Worktree vs the shared checkout, inside a project target. */
  workdirMode: WorkdirMode;
  onWorkdirModeChange(next: WorkdirMode): void;
  /** Absent/false disables the choice — a scratch target has no checkout to branch. */
  workdirChoosable?: boolean;

  /** The roster, already recency-ordered by the screen's data layer. */
  teammates: readonly LaunchTeammate[];
  /** `null` is AUTO: the screen resolves the first (most recently launched) row. */
  teammateId: string | null;
  onPickTeammate(id: string | null): void;

  /** The models the resolved teammate's tool truthfully offers on this node. */
  models: readonly { id: string; label: string; note?: string }[];
  model: string | null;
  onPickModel(id: string): void;

  /** Stops the RESOLVED model accepts, ascending. Empty = effort not tunable. */
  effortStops: readonly LaunchModelEffort[];
  effort: LaunchModelEffort | null;
  onEffortChange(next: LaunchModelEffort | null): void;

  accessMode: LaunchAccessMode | null;
  onAccessModeChange(next: LaunchAccessMode): void;

  /**
   * The vendor whose credential the ··· menu chooses ("Anthropic", "OpenAI").
   * `null` means the resolved tool has no per-session personal credential, and
   * the row renders disabled with that reason rather than vanishing.
   */
  credentialProviderLabel: string | null;
  /** `null` is Auto: mine if connected, else the space default, else the node's (D4). */
  credential: LaunchCredentialSource | null;
  onCredentialChange(next: LaunchCredentialSource | null): void;

  mode: LaunchMode;
  onModeChange(next: LaunchMode): void;

  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
  autoFocus?: boolean;
  /** A host's line above the footer controls — the Run popup's ✦ Jev strip. */
  aboveControls?: ReactNode;
  /** A host's control just before Launch — the Run popup's ✦ Ask Jev. */
  beforeLaunch?: ReactNode;
}

type MenuName = 'workdir' | 'dots' | 'model' | 'perm' | 'team';
type SubName = 'cred' | 'mode';

/**
 * The postures this surface offers, of the domain's five. The canvas draws
 * exactly three — the safe default, the everything-asks posture, and the
 * nothing-asks one — and leaves the full spectrum to the launch sheet. The
 * words for each come from `accessModeLabel`/`describeAccessMode`, never from
 * this file: the chip vocabulary lives in the domain so no screen respells it.
 */
const ACCESS_OPTIONS: readonly LaunchAccessMode[] = ['auto', 'safe', 'fullAccess'];

/**
 * The session modes this surface offers: a fresh session either works the task
 * alone or coordinates its own workers. The contract's remaining modes
 * describe attachment to a coordinator that already exists, which this
 * composer has no picker for — the crew surfaces own that arrangement.
 */
const MODE_OPTIONS = LAUNCH_MODES.filter((m) => m.id === 'worker' || m.id === 'coordinator');

const NO_CREDENTIAL_PROVIDER_REASON =
  'This agent tool has no personal credential provider, so there is nothing to choose.';

const EFFORT_NOT_TUNABLE_REASON =
  'This model takes no reasoning-effort setting, so there is no stop to pick.';

/** The git-branch glyph for the working-copy toggle, drawn with currentColor. */
function BranchIcon() {
  return (
    <svg width="13" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="nsx-tool__icon">
      <circle cx="3.5" cy="2.9" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="11.1" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.5" cy="4.4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 4.6 V9.4 M10.5 6.1 C10.5 8.6 6.2 7.6 4.1 9.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** The permission-posture glyphs the canvas draws: shield / ? / bolt. */
function AccessIcon({ mode }: { mode: LaunchAccessMode | null }) {
  if (mode === 'fullAccess') {
    return (
      <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true" className="nsx-tool__icon">
        <path d="M7 1 L2 8 H5.5 L5 13 L10 6 H6.5 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (mode === 'safe') {
    return <span className="nsx-tool__ask" aria-hidden="true">?</span>;
  }
  /* `auto` and the unpinned default both draw the shield: both mean "the safe
     thing happens unless someone says otherwise", and the LABEL beside the
     icon is what distinguishes them — the icon is never the only carrier. */
  return (
    <svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true" className="nsx-tool__icon">
      <path d="M6.5 1 L12 3 V7 C12 10.2 9.8 12.3 6.5 13.2 C3.2 12.3 1 10.2 1 7 V3 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function NewSessionComposer({
  draft,
  onDraftChange,
  onSubmit,
  busy,
  requirePrompt = true,
  promptPlaceholder = 'What do you want to work on?',
  onDismissRequest,
  refusal,
  notice,
  derivedTitle,
  title,
  onTitleChange,
  workdirs,
  workdirId,
  onPickWorkdir,
  workdirMode,
  onWorkdirModeChange,
  workdirChoosable = true,
  teammates,
  teammateId,
  onPickTeammate,
  models,
  model,
  onPickModel,
  effortStops,
  effort,
  onEffortChange,
  accessMode,
  onAccessModeChange,
  credentialProviderLabel,
  credential,
  onCredentialChange,
  mode,
  onModeChange,
  skillOptions,
  attach,
  autoFocus,
  aboveControls,
  beforeLaunch,
}: NewSessionComposerProps) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);

  /* WHICH MENU IS OPEN is the one piece of state this component owns: it is
     presentation, not configuration, and hoisting it would make the screen
     re-render per hover for nothing. One menu at a time, exactly the canvas
     behaviour — opening another closes the first, and the ··· submenus reset
     with their parent. */
  const [open, setOpen] = useState<MenuName | null>(null);
  const [sub, setSub] = useState<SubName | null>(null);
  const close = () => { setOpen(null); setSub(null); };
  const toggle = (name: MenuName) => {
    setOpen((current) => (current === name ? null : name));
    setSub(null);
  };

  /* Escape and outside-pointer dismissal, shared with every other popover in
     the package. Scoped to `open !== null` so Escape is only CONSUMED while a
     menu is actually up — with none open it still reaches whatever surface
     owns it. Clicks INSIDE the card but outside a menu close via the card's
     own onClick below; menu triggers and items stop propagation, mirroring
     the canvas's document-click logic. */
  useDismissable(open !== null, card, close);

  /* THE SECOND ESCAPE LAYER — active only while NO menu is open, so the two
     listeners are mutually exclusive and cannot race: menu up ⇒ Escape closes
     the menu (above); menus closed ⇒ Escape asks the host to dismiss the card.
     Registered only when a host actually passes the request. */
  useEffect(() => {
    if (open !== null || !onDismissRequest) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onDismissRequest();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onDismissRequest]);

  const rich = useRichInput({
    value: draft,
    onChange: onDraftChange,
    areaRef: area,
    triggers: [{
      sigil: '/',
      options: skillOptions,
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    }],
    attachments: { start: attach, placement: { mode: 'chip' } },
    onKeyDown: (event) => {
      /* `isComposing` guards an IME candidate window: Enter there commits the
         candidate, and spawning on it would launch a half-typed thought.
         Copied deliberately from the chat composers — a create flow that
         misfires mid-word is worse here, because the result is a process. */
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (!busy && !refusal && !(requirePrompt && draft.trim() === '')) onSubmit();
      }
    },
  });
  const attachments = rich.attachments!;
  const blocked = busy || Boolean(refusal) || attachments.blocked
    || (requirePrompt && draft.trim() === '');

  const selectedWorkdir = workdirs.find((w) => w.id === workdirId) ?? null;
  const autoTeammate = teammates[0] ?? null;
  const teammate = (teammateId ? teammates.find((t) => t.id === teammateId) : null) ?? null;
  const modelLabel = models.find((m) => m.id === model)?.label ?? model ?? 'Model';
  const modeDef = MODE_OPTIONS.find((m) => m.id === mode) ?? MODE_OPTIONS[0];
  const copyDef = WORKDIR_MODE_OPTIONS.find((option) => option.id === workdirMode);

  const credShort = credential === null ? 'Auto' : credential === 'member' ? 'Mine' : 'Node’s';
  /* The stops cycle: the model's own list, ascending, wrapping. No unpinned
     step — the OWNER'S RULING (2026-09-07): the dial always names a real stop,
     seeded at High by the state hook. An effort the list no longer contains
     restarts at the first stop rather than sticking. */
  const cycleEffort = () => {
    if (effortStops.length === 0) return;
    close(); // a click on this control is also a click away from any open menu
    const at = effort === null ? -1 : effortStops.indexOf(effort);
    onEffortChange(effortStops[(at + 1) % effortStops.length] ?? null);
  };

  const stopThen = (act: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    act();
  };

  return (
    <div className="nsx-composer-wrap">
      {/* The card-level click closes menus (blank card space, the textarea);
          every trigger and menu item stops propagation before this sees it.
          Not a keyboard surface: Escape does the same job via useDismissable. */}
      <div className="nsx-composer" data-busy={busy || undefined} ref={card} onClick={close}>
        <div className="nsx-head">
          <div className="nsx-anchor">
            <button
              type="button"
              className="nsx-head__workdir"
              data-testid="nsx-workdir"
              aria-haspopup="menu"
              aria-expanded={open === 'workdir'}
              aria-label={`Working directory: ${selectedWorkdir?.name ?? 'not chosen'}`}
              onClick={stopThen(() => toggle('workdir'))}
            >
              <span className="nsx-head__badge" aria-hidden="true">
                {(selectedWorkdir?.name ?? '?').charAt(0).toUpperCase()}
              </span>
              <span className="nsx-head__name">{selectedWorkdir?.name ?? 'Working directory'}</span>
              <span className="nsx-head__caret" aria-hidden="true">▼</span>
            </button>
            {open === 'workdir' ? (
              <div className="nsx-menu nsx-menu--down" role="menu" data-testid="nsx-workdir-menu">
                <div className="nsx-menu__head">Working directory</div>
                {workdirs.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={w.id === workdirId}
                    className="nsx-menu__item"
                    /* Untrusted projects render IN the list, refused with their
                       reason — hiding them would make this menu silently
                       disagree with the projects the space actually links. */
                    aria-disabled={w.disabledReason ? true : undefined}
                    title={w.disabledReason}
                    onClick={stopThen(() => {
                      if (w.disabledReason) return;
                      onPickWorkdir(w.id);
                      close();
                    })}
                  >
                    <span className="nsx-menu__body">
                      <span className="nsx-menu__name">{w.name}</span>
                      {/* No sub-line rather than an empty one: a host that has
                          no path fact for a row must not render a blank claim. */}
                      {(w.disabledReason ?? w.detail) ? (
                        <span className={w.disabledReason ? 'nsx-menu__sub' : 'nsx-menu__sub nsx-menu__sub--mono'}>
                          {w.disabledReason ?? w.detail}
                        </span>
                      ) : null}
                    </span>
                    <span className="nsx-menu__check" aria-hidden="true">{w.id === workdirId ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* THE WORKING COPY, beside the directory it applies to (owner's ask
              2026-09-07: out of the ··· menu, next to the project name, with a
              git-branch glyph). One click toggles worktree ⇄ current branch;
              the label always names the current choice — the icon is never the
              only carrier. */}
          <button
            type="button"
            className="nsx-head__copy"
            data-testid="nsx-copy"
            aria-disabled={!workdirChoosable || undefined}
            title={workdirChoosable
              ? `${copyDef?.description ?? ''} Click to switch.`
              : 'A scratch session has no project checkout, so there is no working copy to choose.'}
            aria-label={`Working copy: ${copyDef?.label ?? workdirMode}. Click to switch.`}
            onClick={stopThen(() => {
              if (!workdirChoosable) return;
              close();
              onWorkdirModeChange(workdirMode === 'worktree' ? 'project' : 'worktree');
            })}
          >
            <BranchIcon />
            <span>{copyDef?.label ?? workdirMode}</span>
          </button>

          <div className="nsx-anchor">
            <button
              type="button"
              className="nsx-head__dots"
              data-testid="nsx-dots"
              aria-haspopup="menu"
              aria-expanded={open === 'dots'}
              aria-label="More launch options"
              onClick={stopThen(() => toggle('dots'))}
            >
              ···
            </button>
            {open === 'dots' ? (
              <div className="nsx-menu nsx-menu--down" role="menu" data-testid="nsx-dots-menu">
                <button
                  type="button"
                  className="nsx-menu__row"
                  aria-expanded={sub === 'cred'}
                  aria-disabled={credentialProviderLabel === null ? true : undefined}
                  title={credentialProviderLabel === null ? NO_CREDENTIAL_PROVIDER_REASON : undefined}
                  data-testid="nsx-credential-row"
                  onClick={stopThen(() => {
                    if (credentialProviderLabel === null) return;
                    setSub((current) => (current === 'cred' ? null : 'cred'));
                  })}
                >
                  <span>{credentialProviderLabel ? `${credentialProviderLabel} credential` : 'Agent credential'}</span>
                  <span className="nsx-menu__val">{`${credShort} ▸`}</span>
                </button>
                {sub === 'cred' ? (
                  <div className="nsx-menu__subsec">
                    {([
                      { value: null, label: 'Auto · mine if connected, else the space’s, else the node’s' },
                      { value: 'member', label: 'Mine', hint: 'My credential · refuse if this provider is not connected' },
                      { value: 'node', label: 'Node’s', hint: 'Node credential · this server’s agent account' },
                    ] as const).map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        role="menuitemradio"
                        aria-checked={credential === option.value}
                        className="nsx-menu__item"
                        title={'hint' in option ? option.hint : undefined}
                        onClick={stopThen(() => onCredentialChange(option.value))}
                      >
                        <span className="nsx-menu__body">
                          <span className="nsx-menu__name nsx-menu__name--plain">{option.label}</span>
                        </span>
                        <span className="nsx-menu__check" aria-hidden="true">{credential === option.value ? '✓' : ''}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="nsx-menu__row"
                  aria-expanded={sub === 'mode'}
                  data-testid="nsx-mode-row"
                  onClick={stopThen(() => setSub((current) => (current === 'mode' ? null : 'mode')))}
                >
                  <span>Session mode</span>
                  <span className="nsx-menu__val">{`${modeDef?.label ?? mode} ▸`}</span>
                </button>
                {sub === 'mode' ? (
                  <div className="nsx-menu__subsec">
                    {MODE_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={mode === option.id}
                        className="nsx-menu__item"
                        onClick={stopThen(() => onModeChange(option.id))}
                      >
                        <span className="nsx-menu__body">
                          <span className="nsx-menu__name nsx-menu__name--plain">{option.label}</span>
                          <span className="nsx-menu__sub">{option.description}</span>
                        </span>
                        <span className="nsx-menu__check" aria-hidden="true">{mode === option.id ? '✓' : ''}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

              </div>
            ) : null}
          </div>

          <input
            className="nsx-head__title"
            data-testid="nsx-title"
            value={title}
            maxLength={TITLE_MAX}
            disabled={busy}
            /* Safari's AutoFill CONTACT button (a person glyph on focus): a
               contact card has a (job) "title" field, so Safari's heuristic
               matches this field's hints and overrides `autocomplete="off"`.
               These attributes reduce the match; the reliable switch-off is
               the `::-webkit-contacts-auto-fill-button` rule in the CSS
               (user report 2026-09-07). */
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            name="tm8-hdr-input"
            aria-label="Task title — leave empty to use the first sentence of the prompt"
            /* The DERIVED name is the placeholder: the field always shows what
               the task will be called, and typing here is how you overrule it. */
            placeholder={derivedTitle || 'Task title…'}
            onChange={(event) => onTitleChange(event.target.value)}
          />
        </div>

        <AttachmentChips attachments={attachments} testId="nsx-attachments" />

        <div className="ri-host">
          <textarea
            ref={area}
            value={draft}
            aria-label="Describe what this session should do"
            aria-describedby={refusal || notice ? 'nsx-refusal' : undefined}
            disabled={busy}
            autoFocus={autoFocus}
            placeholder={promptPlaceholder}
            rows={5}
            {...rich.areaProps}
          />
          <TriggerPopover
            popover={rich.popover}
            label="Available skills"
            renderOption={(option) => (
              <>
                <span className="ri-popover__name">{`/${option.display}`}</span>
                {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
              </>
            )}
            emptyText="No matching skills"
            testId="nsx-skill-picker"
          />
        </div>

        {aboveControls}

        <div className="nsx-composer__foot">
          <div className="nsx-anchor">
            <button
              type="button"
              className="nsx-tool"
              data-testid="nsx-model"
              aria-haspopup="menu"
              aria-expanded={open === 'model'}
              aria-label={`Model: ${modelLabel}`}
              onClick={stopThen(() => toggle('model'))}
            >
              <span className="nsx-tool__glyph" aria-hidden="true">✳</span>
              <span>{modelLabel}</span>
            </button>
            {open === 'model' ? (
              <div className="nsx-menu nsx-menu--up nsx-menu--model" role="menu" data-testid="nsx-model-menu">
                <div className="nsx-menu__head">Model</div>
                {/* An empty list means this UI does not know the tool. Offering
                    a model it may reject would turn a guess into a spawn-time
                    refusal, so the absence is stated instead. */}
                {models.length === 0 ? (
                  <div className="nsx-menu__empty">no known models for this agent tool</div>
                ) : null}
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={model === m.id}
                    className="nsx-menu__item"
                    title={m.note}
                    onClick={stopThen(() => { onPickModel(m.id); close(); })}
                  >
                    <span className="nsx-menu__body">
                      <span className="nsx-menu__name nsx-menu__name--plain">{m.label}</span>
                    </span>
                    <span className="nsx-menu__check" aria-hidden="true">{model === m.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="nsx-tool"
            data-testid="nsx-effort"
            aria-disabled={effortStops.length === 0 || undefined}
            title={effortStops.length === 0
              ? EFFORT_NOT_TUNABLE_REASON
              : `Reasoning effort: ${effort ? effortLabel(effort) : 'the model default'} — click to cycle`}
            onClick={stopThen(cycleEffort)}
          >
            <span className="nsx-bars" aria-hidden="true">
              {(effortStops.length > 0 ? effortStops : ['low', 'medium', 'high', 'max'] as const).map((stop, index, all) => (
                <span
                  key={stop}
                  className="nsx-bars__bar"
                  data-on={effort !== null && effortStops.indexOf(effort) >= index ? '' : undefined}
                  /* Height is geometry, not colour: the ramp the canvas draws,
                     spread over however many stops this model actually has. */
                  style={{ height: `${4 + Math.round((8 * index) / Math.max(all.length - 1, 1))}px` }}
                />
              ))}
            </span>
            <span>{effortLabel(effort)}</span>
          </button>

          <div className="nsx-anchor">
            <button
              type="button"
              className="nsx-tool"
              data-testid="nsx-perm"
              aria-haspopup="menu"
              aria-expanded={open === 'perm'}
              title={describeAccessMode(accessMode)}
              aria-label={`Permission mode: ${describeAccessMode(accessMode)}`}
              onClick={stopThen(() => toggle('perm'))}
            >
              <AccessIcon mode={accessMode} />
              <span>{accessModeLabel(accessMode)}</span>
            </button>
            {open === 'perm' ? (
              <div className="nsx-menu nsx-menu--up" role="menu" data-testid="nsx-perm-menu">
                <div className="nsx-menu__head">Permission mode</div>
                {ACCESS_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="menuitemradio"
                    aria-checked={accessMode === option}
                    className="nsx-menu__item"
                    onClick={stopThen(() => { onAccessModeChange(option); close(); })}
                  >
                    <span className="nsx-menu__lead" aria-hidden="true"><AccessIcon mode={option} /></span>
                    <span className="nsx-menu__body">
                      <span className="nsx-menu__name nsx-menu__name--plain">{accessModeLabel(option)}</span>
                      {/* The sentence after the `·` — the label is already the chip word. */}
                      <span className="nsx-menu__sub">{describeAccessMode(option).split(' · ')[1] ?? ''}</span>
                    </span>
                    <span className="nsx-menu__check" aria-hidden="true">{accessMode === option ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="nsx-anchor">
            <button
              type="button"
              className="nsx-tool"
              data-testid="nsx-team"
              aria-haspopup="menu"
              aria-expanded={open === 'team'}
              aria-label={teammate ? `Teammate: ${teammate.name}` : 'Teammate: chosen automatically'}
              onClick={stopThen(() => toggle('team'))}
            >
              <span className="nsx-tool__person" aria-hidden="true">
                <span className="nsx-tool__person-head" />
                <span className="nsx-tool__person-body" />
              </span>
              <span>{teammate?.name ?? 'Teammate'}</span>
            </button>
            {open === 'team' ? (
              <div className="nsx-menu nsx-menu--up nsx-menu--team" role="menu" data-testid="nsx-team-menu">
                <div className="nsx-menu__head">Teammate · optional</div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={teammateId === null}
                  className="nsx-menu__item"
                  onClick={stopThen(() => { onPickTeammate(null); close(); })}
                >
                  <span className="nsx-menu__auto" aria-hidden="true">A</span>
                  <span className="nsx-menu__body">
                    <span className="nsx-menu__name">Auto</span>
                    {/* Auto is not "no teammate" — a session always runs as a
                        persona. It is "the roster's front row", named so the
                        pick is inspectable before it commits. */}
                    <span className="nsx-menu__sub">
                      {autoTeammate ? `pick for me · currently ${autoTeammate.name}` : 'pick for me — no teammates on this node yet'}
                    </span>
                  </span>
                  <span className="nsx-menu__check" aria-hidden="true">{teammateId === null ? '✓' : ''}</span>
                </button>
                {teammates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={teammateId === t.id}
                    className="nsx-menu__item"
                    onClick={stopThen(() => { onPickTeammate(t.id); close(); })}
                  >
                    <Avatar actorId={t.id} provenance="agent" label={t.name} initials={t.initial} size={22} />
                    <span className="nsx-menu__body">
                      <span className="nsx-menu__name">{t.name}</span>
                      {/* Only the facts the host actually has — a popup host
                          without an owner fact must not print "owned by ". */}
                      <span className="nsx-menu__sub">
                        {[t.model, t.agentTool, t.owner ? `owned by ${t.owner}` : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="nsx-menu__check" aria-hidden="true">{teammateId === t.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <span className="nsx-foot__spacer" />

          {beforeLaunch}

          <button
            type="button"
            className="nsx-launch"
            data-testid="nsx-send"
            /* `aria-disabled`, not `disabled`: a refused Launch must stay
               focusable so its reason is reachable, and the handler re-guards.
               Same posture as the chat composer's send. */
            aria-disabled={blocked}
            onClick={stopThen(() => { if (!blocked) onSubmit(); })}
          >
            <span>{busy ? 'Launching…' : 'Launch'}</span>
            <span className="nsx-launch__key" aria-hidden="true">⏎</span>
          </button>
        </div>
      </div>

      {(refusal ?? notice) ? (
        <p className="nsx-refusal" id="nsx-refusal" role="alert">{refusal ?? notice}</p>
      ) : null}
    </div>
  );
}
