/**
 * CRAFT CHAT PICKER — the conversation selector, on the chat pane's own
 * header rather than in a column of its own.
 *
 * WHY A POPOVER AND NOT A `<select>`. The rows carry four facts each —
 * title, preview, mode and teammate/model — plus a day grouping and a find
 * box, because `listThreads` is space-wide and the list is long. A native
 * select can hold one string per row, so the honest choice was to relocate
 * the column's contents, not to shrink them to titles and drop the search.
 *
 * SCOPE, AND THE ESCAPE HATCH. The picker lists CRAFT threads anchored to
 * the selected blueprint (`anchorId`), which is what makes the two pane
 * headers one hierarchy: the graph names the object, this names the
 * conversations about it. But anchoring is a property of how a thread was
 * STARTED, and threads predating the Craft studio were not started that way
 * — so a scoped list can be legitimately empty while the space is full of
 * conversations. "Show every conversation" is therefore not a nicety: it is
 * the difference between an empty state and a dead end, and the empty state
 * says so in as many words.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ChatThreadSummary } from '../chat-home/types';
import { composeThreadColumn } from '../chat-home/thread-column';
import { Timestamp } from '../kit';

export interface CraftChatPickerProps {
  threads: readonly ChatThreadSummary[];
  /** The blueprint the studio is on — the anchor the scoped list filters to. */
  anchorId: EntityId | null;
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
  /** ＋ — back to the new-conversation composer, pinned to craft by the host. */
  onNewChat(): void;
}

export function CraftChatPicker({
  threads,
  anchorId,
  selectedId,
  onSelect,
  onNewChat,
}: CraftChatPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const scoped = useMemo(
    () => threads.filter((thread) => thread.config.mode === 'craft' && thread.anchorId === anchorId),
    [threads, anchorId],
  );
  /* The scoped list is the default; the toggle only WIDENS it. Falling back
     automatically when the scope is empty was the tempting alternative and
     the wrong one — the picker would silently show a different population
     than its own label claims, and nobody could tell which they were
     looking at. */
  const listed = showAll ? threads : scoped;
  const groups = useMemo(() => composeThreadColumn(listed, query), [listed, query]);
  const current = useMemo(
    () => threads.find((thread) => thread.rootId === selectedId) ?? null,
    [threads, selectedId],
  );

  /* Dismissal: a click outside, or Escape. Both, because a popover you can
     only close by making a selection is a modal wearing a menu's clothes. */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    /* CONSUMING ESCAPE MEANS SAYING SO — and saying it FIRST.
       `CraftScreen`'s region-C rung skips on `defaultPrevented` so the
       innermost thing open can win. Marking the event was half the answer:
       both rungs sit on `document`, so among bubble listeners the queue is
       REGISTRATION order, and region C's is attached the moment the column
       opens — long before this popover exists. The outer rung would answer
       first and preventDefault US. Capture runs ahead of every bubble
       listener whenever it was added, which is the only ordering that tracks
       nesting rather than history. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  /* Opening puts the caret in the find box: the list is long, and the
     gesture that follows an open is almost always typing. */
  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  return (
    <div className="crf-pane-head" ref={wrapRef}>
      <button
        type="button"
        className="crf-pick"
        data-testid="crf-chat-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={current ? current.title : 'Choose a craft conversation'}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="crf-pick__caret" aria-hidden>
          ▾
        </span>
        <span className="crf-pick__title">{current ? current.title : 'New craft conversation'}</span>
        {current ? <span className="crf-pick__meta">{current.config.teammateLabel}</span> : null}
      </button>
      <button
        type="button"
        className="crf-pane-head__plus"
        data-testid="crf-new-chat"
        aria-label="New craft chat"
        title="Start a new craft conversation on this blueprint"
        onClick={() => {
          setOpen(false);
          onNewChat();
        }}
      >
        <span aria-hidden>+</span>
      </button>

      {open ? (
        <div className="crf-pop" role="dialog" aria-label="Craft conversations" data-testid="crf-chat-pop">
          <input
            ref={searchRef}
            type="search"
            className="crf-pop__find"
            placeholder="Find a conversation…"
            aria-label="Find a conversation — filters what is already loaded"
            title="Filters the conversations already loaded here; this is not a server search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="crf-pop__list">
            {groups.length === 0 ? (
              <p className="crf-pop__hollow" data-testid="crf-chat-empty">
                {query.trim()
                  ? 'Nothing loaded here matches.'
                  : showAll
                    ? 'No conversations in this space yet. Start one with +.'
                    : 'No craft conversations on this blueprint yet. Start one with +, or show every conversation below.'}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label} className="crf-pop__group" role="group" aria-label={group.label}>
                <span className="crf-pop__group-label">{group.label}</span>
                {group.rows.map((thread) => (
                  <button
                    type="button"
                    key={thread.rootId}
                    className="crf-pop__row"
                    data-active={thread.rootId === selectedId || undefined}
                    onClick={() => {
                      setOpen(false);
                      onSelect(thread.rootId);
                    }}
                  >
                    <span className="crf-pop__row-title">
                      {thread.state === 'streaming' ? (
                        <span className="crf-pop__live" title="Agent is working" aria-label="Agent is working" />
                      ) : null}
                      {thread.title}
                    </span>
                    <span className="crf-pop__row-meta">
                      <span className="crf-pop__mode">{thread.config.mode}</span>
                      <span>{thread.config.teammateLabel}</span>
                      <span aria-hidden>·</span>
                      <span>{thread.config.modelLabel}</span>
                      <Timestamp at={thread.updatedAt} />
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {/* Says what it is showing AND what it is hiding — a filter that
              does not report its own exclusions reads as an empty space. */}
          <button
            type="button"
            className="crf-pop__scope"
            data-testid="crf-chat-scope"
            onClick={() => setShowAll((was) => !was)}
          >
            {showAll
              ? `Showing all ${threads.length} conversations — show only this blueprint's`
              : `Showing ${scoped.length} on this blueprint — show all ${threads.length} conversations`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
