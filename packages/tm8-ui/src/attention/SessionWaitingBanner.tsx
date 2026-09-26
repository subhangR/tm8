/**
 * "WAITING ON YOU" — the terminal / chat banner (chapter 4 "Session", mock
 * tab 4).
 *
 * It shows the REAL reason a session or chat raised, not the hard-coded
 * `QUIET_SESSION_DETAIL`: PTY silence alone no longer produces a banner (G1),
 * only an open request this session raised does — wherever that request is
 * pinned (F1). Two verbs:
 *   · Resolve, with an optional note, settles the root the request counts on
 *     (the task, for a session working on one) for everyone.
 *   · Reply messages the session and leaves the request open.
 * Jump to prompt is deferred with permission prompts (F2).
 *
 * `useAttentionOptional` returning null means no module is mounted: the banner
 * renders `legacy` instead, so a host that has not adopted v2 keeps today's.
 */
import { useState, type ReactNode } from 'react';
import type { AttentionRequest, EntityId } from '@tm8/contract';
import { AttentionChipView, useAttentionOptional, type AttentionQueueRow } from './index';
import { attentionAge } from './attention-subtitles';
import './attention-surfaces.css';

export interface SessionWaitingBannerProps {
  /** The work session or chat the banner sits on. */
  sessionId: EntityId | string;
  /** Rendered when no attention module is mounted (pre-v2 hosts, old tests). */
  legacy?: ReactNode;
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

export function SessionWaitingBanner({ sessionId, legacy = null, tone = 'light' }: SessionWaitingBannerProps) {
  const api = useAttentionOptional();
  const [mode, setMode] = useState<'idle' | 'resolve' | 'reply'>('idle');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!api) return <>{legacy}</>;

  const raised = raisedBy(api.queue('all'), String(sessionId));
  const chip = api.raisedChipFor(sessionId as EntityId);
  if (raised.length === 0 || !chip) return null;

  const latest = raised[0]!;
  const roots = [...new Set(raised.map((r) => r.row.rootId))];
  const onOther = latest.row.rootId !== sessionId;

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'reply') {
        if (text.trim()) await api.reply(sessionId as EntityId, text.trim());
      } else {
        const note = text.trim() || undefined;
        for (const root of roots) await api.resolve(root, note);
      }
      setText('');
      setMode('idle');
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
