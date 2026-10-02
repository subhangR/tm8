/**
 * Small pieces every story card draws with: the four-tone meter, the status
 * pill, a person's avatar, a card head, an inline one-line composer.
 *
 * Display only. Every figure comes off the server's `StoryProgress`; nothing
 * here counts rows. No kind literal appears below — kinds reach a picture
 * through `KindIcon` and a view through `VIEW_OF_KIND` (§15.2).
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { Avatar, Eyebrow, Pill, type PillTone } from '../../kit';
import { segments, TONE_WORD, type StoryPerson, type StoryProgress, type StoryTone } from '../model';
import type { StoryNodePick } from '../props';
import './story-cards.css';

/** Tone → the kit pill tone that draws it. */
export const PILL_OF_TONE: Readonly<Record<StoryTone, PillTone>> = {
  done: 'run',
  working: 'info',
  blocked: 'block',
  todo: 'idle',
};

/** The meter draws done, working and blocked; to-do is the track showing through. */
const METER_ORDER: readonly StoryTone[] = ['done', 'working', 'blocked'];

export function Meter({ progress, thin = false }: { progress: StoryProgress; thin?: boolean }) {
  const s = segments(progress);
  return (
    <span className={thin ? 'stc-meter stc-meter--thin' : 'stc-meter'} aria-hidden>
      {s.total > 0
        ? METER_ORDER.map((tone) =>
            s[tone] > 0 ? (
              <b key={tone} className={`stc-meter__seg stc-tone--${tone}`} style={{ width: `${(100 * s[tone]) / s.total}%` }} />
            ) : null,
          )
        : null}
    </span>
  );
}

export function TonePill({ tone, label }: { tone: StoryTone | null; label?: string }) {
  if (!tone) return <Pill tone="idle">{label ?? 'cancelled'}</Pill>;
  return (
    <Pill tone={PILL_OF_TONE[tone]} dot="solid">
      {label ?? TONE_WORD[tone]}
    </Pill>
  );
}

/** A person's avatar; `live` draws the run ring. Unknown ids draw "someone". */
export function PersonAvatar({
  id,
  person,
  fallbackName,
  agent,
  size = 20,
  live = false,
}: {
  id: string | null;
  person: StoryPerson | null;
  fallbackName?: string;
  agent?: boolean;
  size?: 15 | 20 | 22 | 32;
  live?: boolean;
}) {
  const name = person?.name ?? fallbackName ?? 'someone';
  return (
    <span className={live ? 'stc-av stc-av--live' : 'stc-av'}>
      <Avatar
        actorId={id ?? name}
        provenance={(person?.agent ?? agent) ? 'agent' : 'human'}
        label={name}
        initials={person?.initials}
        size={size}
      />
    </span>
  );
}

export function CardHead({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <div className="stc-head">
      <Eyebrow>{title}</Eyebrow>
      {count ? <span className="stc-count">{count}</span> : null}
      <span className="stc-grow" />
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="stc-empty">{children}</div>;
}

/**
 * One line of text that does something on Enter: add a task, rename, spawn.
 * Resolves → closes; rejects → the error's message stays under the field.
 */
export function InlineEntry({
  initial = '',
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
  className,
}: {
  initial?: string;
  placeholder?: string;
  /** Draws a button beside the field when given; Enter always submits. */
  submitLabel?: string;
  onSubmit: (text: string) => Promise<unknown>;
  onClose: () => void;
  className?: string;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    if (t === initial.trim()) return onClose();
    setBusy(true);
    setError(null);
    onSubmit(t).then(
      () => onClose(),
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') onClose();
  };
  return (
    <span className={`stc-entry ${className ?? ''}`}>
      <span className="stc-entry__row">
        <input
          autoFocus
          className="stc-entry__input"
          value={text}
          placeholder={placeholder}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={submitLabel ? undefined : () => (text.trim() && text.trim() !== initial.trim() ? submit() : onClose())}
        />
        {submitLabel ? (
          <>
            <button type="button" className="stc-btn stc-btn--primary" disabled={busy || !text.trim()} onClick={submit}>
              {submitLabel}
            </button>
            <button type="button" className="stc-btn stc-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          </>
        ) : null}
      </span>
      {error ? <span className="stc-entry__error">{error}</span> : null}
    </span>
  );
}

/** A title that becomes an input on click when `rename` exists; plain text otherwise. */
export function RenamableTitle({
  title,
  className,
  rename,
}: {
  title: string;
  className?: string;
  rename?: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  if (!rename) return <span className={className}>{title}</span>;
  if (editing) return <InlineEntry initial={title} onSubmit={rename} onClose={() => setEditing(false)} className="stc-entry--rename" />;
  return (
    <span
      className={`${className ?? ''} stc-renamable`}
      title="click to rename"
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setEditing(true);
      }}
    >
      {title}
    </span>
  );
}

/** The flash class for an id the live feed just landed. */
export function flashOf(landed: ReadonlySet<string> | undefined, ...ids: string[]): string {
  return landed && ids.some((id) => landed.has(id)) ? ' stc-flash' : '';
}

/**
 * Click-an-item: the node popover when the host gave one, else plain
 * navigation, else null (draw the item inert).
 */
export function picker(
  onPick: ((pick: StoryNodePick) => void) | undefined,
  open: ((entityId: string) => void) | undefined,
): ((entityId: string) => (e: MouseEvent<HTMLElement>) => void) | null {
  if (onPick)
    return (entityId) => (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      onPick({ entityId, anchor: { x: r.x, y: r.y, width: r.width, height: r.height } });
    };
  if (open) return (entityId) => () => open(entityId);
  return null;
}
