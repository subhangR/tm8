/**
 * THE CRAFTS HOME'S 2ND PANEL (pinned rail). Without it the home drew no
 * panel at all — no `PanelTop`, no space switcher — and read as the old shell
 * (Subhang, prod 2026-10-18: "Hitting Craft on the icon rail still opens the
 * old shell"). It is the open craft's conversation shell with nothing selected:
 *
 *   [chat icon] [Craft chats ▾]                                  [＋]
 *   ───────────────────────────────────────────────────────────────
 *                      (the Craft mark) Craft
 *
 *  · ▾ lists the crafts that have chats, most recent first; a row opens that
 *    craft, whose panel is its own chats. It is not the crafts list again: a
 *    craft with no chat is only on the card grid.
 *  · ＋ starts a craft chat: it makes a new craft and opens it on the chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain';
import { Timestamp } from '../kit';
import { CraftChatIntro } from './CraftChatPane';
import type { CraftCard, CraftsSource } from './crafts-source';
import './craft-side-panel.css';

export interface CraftsHomePanelProps {
  source: CraftsSource;
  onOpenCraft(id: EntityId): void;
  onNotice?: ((text: string) => void) | undefined;
}

export function CraftsHomePanel({ source, onOpenCraft, onNotice }: CraftsHomePanelProps) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<readonly CraftCard[] | null>(null);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    source
      .list()
      .then((all) =>
        setCards(
          all
            .filter((card) => card.chatCount > 0)
            .sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0)),
        ),
      )
      .catch(() => setCards([]));
  }, [source]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
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

  const newChat = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      onOpenCraft(await source.create('Untitled craft'));
    } catch {
      onNotice?.('Could not start a craft. Try again.');
    } finally {
      setCreating(false);
    }
  }, [creating, source, onOpenCraft, onNotice]);

  return (
    <section className="crf-side" aria-label="Craft chats" data-testid="crf-home-panel">
      <header className="crf-side__head" data-pinned>
        <div className="crf-side__bar">
          <span className="crf-side__icon" title="Craft chats" aria-hidden>
            <KindIcon kind="chat" size={16} />
          </span>
          <div className="crf-side__picker" ref={wrapRef}>
            <button
              type="button"
              className="crf-pick"
              data-testid="crf-home-picker"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => {
                if (!open) refresh();
                setOpen((was) => !was);
              }}
            >
              <span className="crf-pick__title">Craft chats</span>
              <span className="crf-pick__caret" aria-hidden>
                ▾
              </span>
            </button>
            {open ? (
              <div className="crf-pop" role="menu" aria-label="Craft chats" data-testid="crf-home-pop">
                <div className="crf-pop__list">
                  {cards === null || cards.length === 0 ? (
                    <p className="crf-pop__hollow" role={cards === null ? 'status' : undefined}>
                      {cards === null ? 'Loading…' : 'No craft chats yet. Start one with ＋.'}
                    </p>
                  ) : (
                    cards.map((card) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={card.id}
                        className="crf-pop__row"
                        data-testid="crf-home-item"
                        onClick={() => {
                          setOpen(false);
                          onOpenCraft(card.id);
                        }}
                      >
                        <span className="crf-pop__row-title">
                          <KindIcon kind="craft" size={14} />
                          {card.running ? (
                            <span className="crf-pop__live" title="Agent is working" aria-label="Agent is working" />
                          ) : null}
                          {card.title || 'Untitled craft'}
                        </span>
                        <span className="crf-pop__row-meta">
                          <span>{card.chatCount === 1 ? '1 chat' : `${card.chatCount} chats`}</span>
                          <Timestamp at={card.activityAt} />
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="crf-side__plus"
            aria-label="New craft chat"
            title="New craft chat"
            data-testid="crf-home-new"
            disabled={creating}
            onClick={() => void newChat()}
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </header>
      <div className="crf-side__body crf-side__body--home">
        <CraftChatIntro compact onPrompt={() => undefined} />
      </div>
    </section>
  );
}
