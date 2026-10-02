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
import type { StoryBlockProps, StoryNodePick } from '../props';
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

/**
 * A title with an EXPLICIT rename affordance (a small ✎ beside it, drawn only
 * when `rename` exists). The title text itself is left to the caller's press —
 * pressing an entity opens its details; renaming is its own act.
 */
export function RenamableTitle({
  title,
  className,
  rename,
  children,
  menu,
}: {
  title: string;
  className?: string;
  rename?: (title: string) => Promise<void>;
  /** What draws the title (a press button, usually). Defaults to the plain text. */
  children?: ReactNode;
  /** The entity's "…", drawn beside the ✎ in one actions slot. */
  menu?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (rename && editing)
    return <InlineEntry initial={title} onSubmit={rename} onClose={() => setEditing(false)} className="stc-entry--rename" />;
  return (
    <>
      {children ?? <span className={className}>{title}</span>}
      {rename || menu ? (
        <span className="stc-acts">
          {rename ? (
            <button type="button" className="stc-rename" title="rename" aria-label={`Rename ${title}`} onClick={() => setEditing(true)}>
              ✎
            </button>
          ) : null}
          {menu}
        </span>
      ) : null}
    </>
  );
}

/** The flash class for an id the live feed just landed. */
export function flashOf(landed: ReadonlySet<string> | undefined, ...ids: string[]): string {
  return landed && ids.some((id) => landed.has(id)) ? ' stc-flash' : '';
}

/**
 * PRESS, SELECT, MENU — how every entity on the cards answers the pointer.
 *
 * Primary press opens the entity's details beside the story (`onPick`), or
 * navigates (`actions.open`) on a host that has no side panel, or is inert.
 * The secondary affordance — a "…" on hover/focus and right-click — opens the
 * action popover (`onMenu`) and is not drawn without it. `selectedId` marks
 * the entity whose details are open. The anchor is the nearest element
 * carrying `data-entity`, so a popover points at the item, not at its "…".
 */
export interface Press {
  pick: ((entityId: string) => (e: MouseEvent<HTMLElement>) => void) | null;
  menu: ((entityId: string) => (e: MouseEvent<HTMLElement>) => void) | null;
  /** ' stc-sel' when the entity is the selected one. */
  sel: (entityId: string) => string;
}

function anchorOf(e: MouseEvent<HTMLElement>): StoryNodePick['anchor'] {
  const el = (e.currentTarget.closest('[data-entity]') as HTMLElement | null) ?? e.currentTarget;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function pressOf({
  onPick,
  onMenu,
  selectedId,
  actions,
}: Pick<StoryBlockProps, 'onPick' | 'onMenu' | 'selectedId' | 'actions'>): Press {
  const open = actions.open;
  return {
    pick: onPick
      ? (entityId) => (e) => onPick({ entityId, anchor: anchorOf(e) })
      : open
        ? (entityId) => () => open(entityId)
        : null,
    menu: onMenu
      ? (entityId) => (e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu({ entityId, anchor: anchorOf(e) });
        }
      : null,
    sel: (entityId) => (selectedId && selectedId === entityId ? ' stc-sel' : ''),
  };
}

/** The "…" — drawn only when the host can open the action popover. */
export function MenuDot({ id, label, press }: { id: string; label: string; press: Press }) {
  if (!press.menu) return null;
  return (
    <button type="button" className="stc-dot" title="actions" aria-label={`Actions for ${label}`} onClick={press.menu(id)}>
      …
    </button>
  );
}

/**
 * A row's whole surface as a mouse target for the same press its keyboard
 * button carries. Ignores presses that land on a control inside the row and
 * presses that end a text selection.
 */
export function rowPress(press: Press, entityId: string): ((e: MouseEvent<HTMLElement>) => void) | undefined {
  const pick = press.pick;
  if (!pick) return undefined;
  return (e) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, label')) return;
    if (window.getSelection()?.toString()) return;
    pick(entityId)(e);
  };
}

/** A pressable entity title: a button when it can be pressed, plain text otherwise. */
export function PressTitle({ id, title, press, className }: { id: string; title: ReactNode; press: Press; className?: string }) {
  return press.pick ? (
    <button type="button" className={`stc-press ${className ?? ''}`} onClick={press.pick(id)}>
      {title}
    </button>
  ) : (
    <span className={className}>{title}</span>
  );
}
