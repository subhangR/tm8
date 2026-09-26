/**
 * "WAITING ON YOU" — the terminal / chat banner (chapter 4 "Session", mock
 * tab 4).
 *
 * It shows the REAL reason a session or chat raised: PTY silence alone no
 * longer produces a banner (G1), only an open request this session raised
 * does — wherever that request is pinned (F1). Two verbs:
 *   · Resolve, with an optional note, settles the root the request counts on
 *     (the task, for a session working on one) for everyone.
 *   · Reply messages the session and leaves the request open.
 * Jump to prompt is deferred with permission prompts (F2).
 *
 * Outside an `AttentionProvider` it renders nothing.
 */
import { useRef, useState } from 'react';
import type { AttentionRequest, EntityId } from '@tm8/contract';
import { AttentionChipView, useAttentionOptional, type AttentionQueueRow } from './index';
import { attentionAge } from './attention-subtitles';
import './attention-surfaces.css';

export interface SessionWaitingBannerProps {
  /** The work session or chat the banner sits on. */
  sessionId: EntityId | string;
  /** `dark` inside the always-dark terminal chrome. */
  tone?: 'dark' | 'light';
}

/** The open requests THIS session raised, with the root row each counts on. */
export function raisedBy(
  queue: readonly AttentionQueueRow[],
  sessionId: string,
): { row: AttentionQueueRow; request: AttentionRequest }[] {
  const out: { row: AttentionQueueRow; request: AttentionRequest }[] = [];
  for (const row of queue) {
    for (const request of row.requests) {
      if (request.sourceWorkSessionId === sessionId) out.push({ row, request });
    }
  }
  return out.sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt));
}

export function SessionWaitingBanner({ sessionId, tone = 'light' }: SessionWaitingBannerProps) {
  const api = useAttentionOptional();
  const [mode, setMode] = useState<'idle' | 'resolve' | 'reply'>('idle');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // What is open NOW, read after the command settles (the closure's is stale).
  const modeNow = useRef(mode);
  modeNow.current = mode;
  if (!api) return null;

  const raised = raisedBy(api.queue('all'), String(sessionId));
  const chip = api.raisedChipFor(sessionId as EntityId);
  if (raised.length === 0 || !chip) return null;

  const latest = raised[0]!;
  const root = latest.row.rootId;
  const onOther = root !== sessionId;
  /* RESOLVE IS ROOT-SCOPED (chapter 3: it closes everything on that task, for
     everyone), so the banner settles ONE root — the one its latest request
     counts on — and says up front what else that settles. One root per press
     also keeps the 8s Undo covering everything the press did. */
  const siblings = api.requestsFor(root).filter((r) => r.sourceWorkSessionId !== sessionId).length;
  const elsewhere = new Set(raised.map((r) => r.row.rootId)).size - 1;
  const where = onOther && latest.row.title ? `${latest.row.kind ?? 'entity'} ${latest.row.title}` : 'this session';

  const submit = async () => {
    const typed = text;
    const submitted = mode === 'reply' ? 'reply' : 'resolve';
    setText('');
    setMode('idle');
    setBusy(true);
    try {
      const landed = submitted === 'reply'
        ? await api.reply(sessionId as EntityId, typed.trim())
        : await api.resolve(root, typed.trim() || undefined);
      // A command that did not land gives the text back IN ITS MODE: a failed
      // Reply must come back as a Reply, never as a Resolve note one Enter away
      // from settling the task. Not over anything opened meanwhile.
      if (!landed && modeNow.current === 'idle') {
        setText(typed);
        setMode(submitted);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`att-banner att-banner--${tone}`}
      role="status"
      aria-live="polite"
      data-testid="session-waiting-banner"
    >
      <div className="att-banner__line">
        <AttentionChipView chip={chip} compact />
        <span className="att-banner__label">
          Waiting on you · {latest.request.actionType ?? 'decide'}
        </span>
        <span className="att-banner__reason" data-testid="session-waiting-reason">
          {latest.request.reason}
        </span>
        <span className="att-banner__meta">
          · {attentionAge(latest.request.createdAt)}
          {onOther && latest.row.title ? ` · on ${latest.row.kind ?? 'entity'} ${latest.row.title}` : ''}
          {elsewhere > 0 ? ` · +${elsewhere} more elsewhere` : ''}
        </span>
        <span className="att-banner__actions">
          <button
            type="button"
            className="att-btn att-btn--primary"
            aria-pressed={mode === 'resolve'}
            onClick={() => setMode(mode === 'resolve' ? 'idle' : 'resolve')}
            data-testid="session-waiting-resolve"
          >
            Resolve
          </button>
          <button
            type="button"
            className="att-btn"
            aria-pressed={mode === 'reply'}
            onClick={() => setMode(mode === 'reply' ? 'idle' : 'reply')}
            data-testid="session-waiting-reply"
          >
            Reply
          </button>
        </span>
      </div>
      {mode === 'resolve' ? (
        <p className="att-banner__scope" data-testid="session-waiting-scope">
          Resolves every open request on {where}
          {siblings > 0 ? `, including ${siblings} ${siblings === 1 ? 'other' : 'others'}` : ''}.
        </p>
      ) : null}
      {mode === 'idle' ? null : (
        <form
          className="att-banner__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void submit();
          }}
        >
          <input
            type="text"
            autoFocus
            value={text}
            placeholder={mode === 'reply' ? 'Message the session (the request stays open)' : 'Optional note — sent to the session'}
            onChange={(event) => setText(event.target.value)}
            data-testid="session-waiting-input"
          />
          <button type="submit" className="att-btn att-btn--primary" disabled={busy || (mode === 'reply' && !text.trim())}>
            {mode === 'reply' ? 'Send' : 'Resolve'}
          </button>
        </form>
      )}
    </div>
  );
}
