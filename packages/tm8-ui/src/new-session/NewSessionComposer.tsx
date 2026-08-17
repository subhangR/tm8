import { useRef } from 'react';

import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../rich-input';
import type { FileUploadTask } from '../files/upload';
import { WORKDIR_MODE_OPTIONS, type WorkdirMode } from '../domain/launch';

/**
 * THE NEW SESSION COMPOSER — type a prompt, press Enter, get a running agent.
 *
 * WHY THIS IS NOT THE CHAT HOME COMPOSER, since it deliberately looks like it:
 * that one is inline JSX inside `ChatHomeScreen`, welded to about ten pieces
 * of screen state and to CSS that only centres inside `.tch-conversation`.
 * Lifting it out is a real refactor of a live screen and was ruled out of this
 * lane. What IS shared is the part that matters — `useRichInput`,
 * `TriggerPopover` and `AttachmentChips` — so the behaviour (skills, paste,
 * drag-drop, upload staging, IME-safe Enter) is one implementation, and only
 * the markup is new.
 *
 * PROPS-ONLY, NO STORE. Everything it needs arrives as a prop and every
 * decision leaves as a callback, so it renders in a test and in a gallery
 * without a node behind it. The screen owns the create/spawn; this owns the
 * box.
 *
 * THE CONFIG LINE IS NOT DECORATION. `LaunchQuickConfig` rules "two clicks to
 * launch, never one", because a spawn is irreversible and the config you are
 * about to use must be visible when you commit it. This screen was ruled to
 * commit on Enter — one keystroke — so the config line satisfies that rule the
 * other way: it is visible the ENTIRE time you type, not revealed by a first
 * click. Removing it would leave the one-keystroke spawn with no justification.
 */
export interface NewSessionComposerProps {
  draft: string;
  onDraftChange(next: string): void;
  /** Enter, or the send button. The screen decides what that means. */
  onSubmit(): void;
  /** True while the create/spawn is in flight — withdraws Enter and the button. */
  busy: boolean;
  /**
   * Why this cannot be sent right now, in words. Present means Send is
   * refused WITH A REASON rather than greyed out silently — the same honesty
   * rule the other composers follow.
   */
  refusal?: string | null;
  /**
   * The title this prompt would create, live. Shown so the user watches their
   * sentence become the task's name instead of discovering it afterwards.
   * Empty renders nothing rather than an empty label.
   */
  derivedTitle: string;
  /** Who and what the spawn will use. Rendered verbatim; this does not resolve it. */
  teammateLabel: string;
  modelLabel: string;
  accessModeLabel: string;
  workdirMode: WorkdirMode;
  onWorkdirModeChange(next: WorkdirMode): void;
  /** Absent disables the workdir choice — a scratch target has no worktree to offer. */
  workdirChoosable?: boolean;
  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
  autoFocus?: boolean;
}

export function NewSessionComposer({
  draft,
  onDraftChange,
  onSubmit,
  busy,
  refusal,
  derivedTitle,
  teammateLabel,
  modelLabel,
  accessModeLabel,
  workdirMode,
  onWorkdirModeChange,
  workdirChoosable = true,
  skillOptions,
  attach,
  autoFocus,
}: NewSessionComposerProps) {
  const area = useRef<HTMLTextAreaElement | null>(null);

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
        if (!busy && !refusal) onSubmit();
      }
    },
  });
  const attachments = rich.attachments!;
  const blocked = busy || Boolean(refusal) || attachments.blocked;

  return (
    <div className="nsx-composer-wrap">
      <div className="nsx-composer" data-busy={busy || undefined}>
        <AttachmentChips attachments={attachments} testId="nsx-attachments" />

        <div className="ri-host">
          <textarea
            ref={area}
            value={draft}
            aria-label="Describe what this session should do"
            aria-describedby={refusal ? 'nsx-refusal' : undefined}
            disabled={busy}
            autoFocus={autoFocus}
            placeholder="Describe what you want done…"
            rows={3}
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

        {/* The title, live. `aria-live="polite"` because it changes as you
            type and a screen reader should not be interrupted per keystroke. */}
        {derivedTitle ? (
          <p className="nsx-title-preview" aria-live="polite" data-testid="nsx-title-preview">
            <span className="nsx-title-preview__label">Task</span>
            <span className="nsx-title-preview__value">{derivedTitle}</span>
          </p>
        ) : null}

        <div className="nsx-composer__foot">
          <div className="nsx-workdir" role="radiogroup" aria-label="Where the work lands">
            {WORKDIR_MODE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={workdirMode === option.id}
                className={`nsx-chip ${workdirMode === option.id ? 'nsx-chip--active' : ''}`}
                title={option.description}
                disabled={busy || !workdirChoosable}
                onClick={() => onWorkdirModeChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="nsx-send"
            /* `aria-disabled`, not `disabled`: a refused Send must stay
               focusable so its reason is reachable, and the handler re-guards.
               Same posture as the chat composer's send. */
            aria-disabled={blocked}
            onClick={() => { if (!blocked) onSubmit(); }}
          >
            {busy ? '…' : 'Start session'}
          </button>
        </div>
      </div>

      {/* THE CONFIG LINE — see the docblock. This is what buys the single
          keystroke, so it sits under the box at all times, never in a popover. */}
      <p className="nsx-resolved" data-testid="nsx-resolved">
        <span className="nsx-resolved__arrow" aria-hidden="true">→</span>
        <span className="nsx-resolved__item">{teammateLabel}</span>
        <span className="nsx-resolved__dot" aria-hidden="true">·</span>
        <span className="nsx-resolved__item">{modelLabel}</span>
        <span className="nsx-resolved__dot" aria-hidden="true">·</span>
        <span className="nsx-resolved__item">
          {WORKDIR_MODE_OPTIONS.find((option) => option.id === workdirMode)?.label}
        </span>
        <span className="nsx-resolved__dot" aria-hidden="true">·</span>
        <span className="nsx-resolved__item">{accessModeLabel}</span>
      </p>

      {refusal ? (
        <p className="nsx-refusal" id="nsx-refusal" role="alert">{refusal}</p>
      ) : null}
    </div>
  );
}
