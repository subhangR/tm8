/**
 * THE TURN RECEIPT, DRAWN — one quiet tinted block per run, one ~32px row per
 * entity (`turn-receipt.ts` folds the rows; proposal 01a14a8d direction B,
 * mockups 01a14a8c). Replaces the created / spawned cards, the transition
 * pill line, the edit lines and the write errlines.
 *
 *   [mark] [kind or thumbnail] title ……… [meta] [worker pills] [state now]
 *
 * - The MARK says what happened (`+` made, `→` moved, `✎` edited, `⇢` linked,
 *   `✕` refused). "Created" is true of every row, so it is never a pill.
 * - The trailing slot is the entity's state NOW: a task's status in the
 *   registry's words (re-read while its worker is live), a session's verdict
 *   from the seam (the liveness law: `live` only from a `live` verdict).
 * - A doc, artifact or drawing made here shows a 44×32 thumbnail and one line
 *   of what is inside; the row opens it.
 * - On a phone the meta and state wrap under the title (a container query, so
 *   a narrow side panel gets the same treatment as a narrow screen).
 *
 * Rows are buttons only where the host can open entities; otherwise inert
 * text, as the cards were. Never a tool name, never a payload (R8).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import { kindWord, type ChatLedger, type LedgerCreate, type LedgerPreview } from './ledger';
import {
  kindLabel,
  statusWord,
  useEnterOnce,
  useLedgerLabel,
  useModelLabel,
  useSessionVerdict,
  useStatusNow,
  type SessionVerdict,
} from './ledger-host';
import { flattenReceipt, type ReceiptMark, type ReceiptRow, type TurnReceipt as Receipt } from './turn-receipt';
import './turn-receipt.css';

/** Past this many rows the receipt shows `RECEIPT_HEAD` and a "+N more". */
export const RECEIPT_CAP = 6;
export const RECEIPT_HEAD = 5;

const MARK: Record<ReceiptMark, { glyph: string; word: string }> = {
  made: { glyph: '+', word: 'Made' },
  moved: { glyph: '→', word: 'Moved' },
  edited: { glyph: '✎', word: 'Edited' },
  linked: { glyph: '⇢', word: 'Linked' },
  pending: { glyph: '·', word: 'Working on' },
  failed: { glyph: '✕', word: 'Failed' },
};

export function TurnReceipt({
  receipt,
  ledger,
  onOpenEntity,
}: {
  receipt: Receipt;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const flat = useMemo(() => flattenReceipt(receipt.rows), [receipt]);
  if (flat.length === 0) return null;
  const capped = !showAll && flat.length > RECEIPT_CAP;
  const visible = capped ? flat.slice(0, RECEIPT_HEAD) : flat;
  const hidden = capped ? flat.slice(RECEIPT_HEAD) : [];
  return (
    <div className="tch-receipt" data-testid="chat-receipt">
      <ul className="tch-receipt__rows">
        {visible.map(({ row, depth }) => (
          <ReceiptRowView key={row.key} row={row} depth={depth} ledger={ledger} onOpenEntity={onOpenEntity} />
        ))}
      </ul>
      {hidden.length > 0 ? (
        <button
          type="button"
          className="tch-receipt__more"
          data-testid="chat-receipt-more"
          aria-expanded={false}
          onClick={() => setShowAll(true)}
        >
          {`+${hidden.length} more: ${moreSentence(hidden.map(({ row }) => row))}`}
          <span aria-hidden> ▸</span>
        </button>
      ) : null}
    </div>
  );
}

/** `1 task, 1 doc, 1 link` — what the "+N more" button is hiding. */
function moreSentence(rows: readonly ReceiptRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const word = row.mark === 'linked' ? 'link' : row.kind ?? 'entity';
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([word, count]) => `${count} ${word === 'link' ? (count === 1 ? 'link' : 'links') : kindWord(word, count)}`)
    .join(', ');
}

function ReceiptRowView({
  row,
  depth,
  ledger,
  onOpenEntity,
}: {
  row: ReceiptRow;
  depth: number;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const self = useLedgerLabel(row.entityId, ledger);
  const enter = useEnterOnce(row.key + (row.entityId ?? ''));
  const kind = row.session ? 'work_session' : (self.kind ?? row.kind ?? undefined);
  const [verdicts, setVerdicts] = useState<Readonly<Record<string, SessionVerdict | null>>>({});
  const reportVerdict = useMemo(
    () => (id: string, verdict: SessionVerdict | null) =>
      setVerdicts((prev) => (prev[id] === verdict ? prev : { ...prev, [id]: verdict })),
    [],
  );
  const workerLive = Object.values(verdicts).some((v) => v === 'live' || v === 'waiting');
  const nudge = row.sessions.length > 0 ? row.sessions.map((s) => verdicts[s.id] ?? '-').join(',') : null;
  const foldStatus = row.entityId ? (ledger.statusNow.get(row.entityId) ?? null) : null;
  const statusful = kind !== undefined && getKind(kind).panel.statusPill?.source === 'status';
  const status = useStatusNow(statusful && row.mark !== 'failed' ? row.entityId : null, foldStatus, {
    watch: workerLive,
    nudge,
  });

  const preview = row.create?.preview;
  const thumb = preview && kind ? <Thumbnail kind={kind} preview={preview} /> : null;
  const failedOrPending = row.mark === 'failed' || row.mark === 'pending';
  const title = failedOrPending ? row.text ?? MARK[row.mark].word : row.session ? null : (self.title ?? row.title ?? kindLabel(kind));
  const line = failedOrPending ? row.reason : (preview?.line ?? null);

  const face = (
    <>
      <span className="tch-rrow__mark" aria-label={MARK[row.mark].word} data-mark={row.mark}>
        {MARK[row.mark].glyph}
      </span>
      <span className="tch-rrow__icon" aria-hidden data-thumb={thumb ? '' : undefined}>
        {thumb ?? (kind ? <KindIcon kind={kind} size={13} /> : '◇')}
      </span>
      <span className="tch-rrow__text">
        <span
          className="tch-rrow__title"
          data-placeholder={!failedOrPending && !row.session && self.title === undefined && !row.title ? '' : undefined}
        >
          {row.session ? <SessionRowTitle session={row.session} ledger={ledger} /> : title}
        </span>
        {line ? <span className="tch-rrow__line">{line}</span> : null}
      </span>
    </>
  );

  const meta = metaOf(row, kind, preview, depth);
  return (
    <li
      className="tch-rrow"
      data-testid={row.create ? 'chat-ledger-create' : 'chat-receipt-row'}
      data-mark={row.mark}
      data-kind={kind}
      data-depth={depth > 0 ? depth : undefined}
      data-enter={enter ? '' : undefined}
      style={depth > 0 ? ({ '--tch-rrow-depth': depth } as CSSProperties) : undefined}
      title={row.move ? moveTitle(kind, row.move) : undefined}
    >
      {row.entityId && onOpenEntity ? (
        <button type="button" className="tch-rrow__main" onClick={() => onOpenEntity(row.entityId as EntityId)}>
          {face}
        </button>
      ) : (
        <span className="tch-rrow__main">{face}</span>
      )}
      <span className="tch-rrow__end">
        {meta.length > 0 ? (
          <span className="tch-rrow__meta" data-testid="chat-receipt-meta">
            {meta.map((part, i) => (
              <span key={i} className="tch-rrow__fact">
                {part.relId ? <RelName id={part.relId} ledger={ledger} lead={part.text} /> : part.text}
              </span>
            ))}
          </span>
        ) : null}
        {row.sessions.map((session) => (
          <SessionPill key={session.id} session={session} onOpenEntity={onOpenEntity} onVerdict={reportVerdict} />
        ))}
        {row.session ? <SessionState id={row.session.id} /> : null}
        {statusful && status && !row.session ? (
          <span className="tch-rstate" data-testid="chat-receipt-state" data-tone={statusTone(kind, status)} data-status={status}>
            <span className="tch-rstate__dot" aria-hidden />
            {taskWord(kind, status)}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** One fact of a row's meta; `relId` renders as the named entity after `text`. */
interface Fact {
  text: string;
  relId?: string;
}

/**
 * The row's one or two short facts: what an edit changed, how big a content
 * create is, where a create landed when its parent is not a row here (a
 * nested row's indentation already says it; the root is never said), or what
 * a link joined it to.
 */
function metaOf(row: ReceiptRow, kind: string | undefined, preview: LedgerPreview | undefined, depth: number): Fact[] {
  const facts: Fact[] = row.edits.map((what) => ({ text: editFact(what) }));
  if (row.create && depth === 0) {
    if (row.create.parentId) facts.push({ text: 'under ', relId: row.create.parentId });
    else if (row.create.subjectId) facts.push({ text: 'on ', relId: row.create.subjectId });
  }
  if (row.create && kind) {
    const size = sizeFact(kind, preview);
    if (size) facts.push({ text: size });
    else if (!statusPilled(kind)) facts.push({ text: kindWord(kind, 1) });
  }
  if (row.link?.otherId) facts.push({ text: `${linkWord(row.link.type)} `, relId: row.link.otherId });
  else if (row.link && row.mark === 'linked') facts.push({ text: 'linked' });
  return facts;
}

function statusPilled(kind: string): boolean {
  return getKind(kind).panel.statusPill?.source === 'status';
}

function sizeFact(kind: string, preview: LedgerPreview | undefined): string | null {
  if (!preview) return null;
  if (kind === 'doc' && preview.words !== undefined) return `doc · ${preview.words.toLocaleString('en-US')} ${preview.words === 1 ? 'word' : 'words'}`;
  if (kind === 'artifact') {
    if (preview.files !== undefined) return `artifact · ${preview.files} ${preview.files === 1 ? 'file' : 'files'}`;
    return 'artifact';
  }
  if (kind === 'drawing') {
    const parts = [
      preview.shapes ? `${preview.shapes} ${preview.shapes === 1 ? 'shape' : 'shapes'}` : null,
      preview.connectors ? `${preview.connectors} ${preview.connectors === 1 ? 'connector' : 'connectors'}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `drawing · ${parts.join(' · ')}` : 'drawing';
  }
  return null;
}

/** `acceptance criteria` → `criteria ticked`, `pull request` → `PR linked`. */
function editFact(what: string): string {
  if (what === 'acceptance criteria') return 'criteria ticked';
  if (what === 'pull request') return 'PR linked';
  if (what === 'commit') return 'commit linked';
  return what;
}

function linkWord(type: string): string {
  return type.replace(/_/g, ' ');
}

function moveTitle(kind: string | undefined, move: { from: string | null; to: string }): string {
  const to = taskWord(kind, move.to);
  return move.from !== null ? `${taskWord(kind, move.from)} → ${to}` : `→ ${to}`;
}

/** The registry's word for a status, with `open` said the way the board
 *  says it: `to do`. */
function taskWord(kind: string | undefined, status: string): string {
  if (status === 'open' && kind === 'task') return 'to do';
  return statusWord(kind, status);
}

/** The registry's tone, except that finished work reads as finished. */
function statusTone(kind: string | undefined, status: string): string {
  if (status === 'done') return 'done';
  return (kind ? getKind(kind).panel.statusPill?.tones?.[status] : undefined) ?? 'idle';
}

function RelName({ id, ledger, lead }: { id: string; ledger: ChatLedger; lead: string }) {
  const rel = useLedgerLabel(id, ledger);
  return (
    <>
      {lead}
      <span className="tch-rrow__rel">
        {rel.kind ? (
          <span className="tch-rrow__relmark" aria-hidden>
            <KindIcon kind={rel.kind} size={11} />
          </span>
        ) : null}
        {rel.title ?? kindLabel(rel.kind)}
      </span>
    </>
  );
}

/* ── sessions ────────────────────────────────────────────────────────────── */

/** `Worker on ◆ Graph seeds` — a session row whose task has no row here. */
function SessionRowTitle({ session, ledger }: { session: LedgerCreate; ledger: ChatLedger }) {
  const model = useModelLabel(session.model);
  const lead = model ? `Worker · ${model}` : 'Worker';
  if (!session.subjectId) return <>{lead}</>;
  return <RelName id={session.subjectId} ledger={ledger} lead={`${lead} on `} />;
}

const VERDICT_WORD: Record<SessionVerdict, string> = {
  live: 'live',
  waiting: 'waiting',
  completed: 'done',
  stopped: 'stopped',
  crashed: 'crashed',
  ended: 'ended',
};

function SessionState({ id }: { id: string }) {
  const verdict = useSessionVerdict(id);
  if (!verdict) return null;
  return (
    <span className="tch-rstate" data-testid="chat-ledger-session-status" data-tone={verdict}>
      <span className="tch-rstate__dot" aria-hidden />
      {VERDICT_WORD[verdict]}
    </span>
  );
}

/**
 * `⌁ Worker · Opus 5.5 ● live` — a session spawned onto the row's task. Its
 * own control: it opens the session, where the row opens the task. It reports
 * its verdict up so the task's state slot knows to keep re-reading while the
 * worker is live.
 */
function SessionPill({
  session,
  onOpenEntity,
  onVerdict,
}: {
  session: LedgerCreate;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  onVerdict: (id: string, verdict: SessionVerdict | null) => void;
}) {
  const verdict = useSessionVerdict(session.id);
  useEffect(() => onVerdict(session.id, verdict), [onVerdict, session.id, verdict]);
  const model = useModelLabel(session.model);
  const body = (
    <>
      <span className="tch-rpill__icon" aria-hidden>
        <KindIcon kind="work_session" size={11} />
      </span>
      <span className="tch-rpill__name">{model ? `Worker · ${model}` : 'Worker'}</span>
      {verdict ? (
        <span className="tch-rstate" data-testid="chat-ledger-session-status" data-tone={verdict}>
          <span className="tch-rstate__dot" aria-hidden />
          {VERDICT_WORD[verdict]}
        </span>
      ) : null}
    </>
  );
  const label = session.title ?? 'Worker session';
  return onOpenEntity ? (
    <button
      type="button"
      className="tch-rpill"
      data-testid="chat-receipt-session"
      data-tone={verdict ?? undefined}
      title={label}
      onClick={() => onOpenEntity(session.id as EntityId)}
    >
      {body}
    </button>
  ) : (
    <span className="tch-rpill" data-testid="chat-receipt-session" data-tone={verdict ?? undefined} title={label}>
      {body}
    </span>
  );
}

/* ── thumbnails ──────────────────────────────────────────────────────────── */

/**
 * 44×32 and drawn from the create's own args, so it is there on first paint
 * and costs no read: a doc's first lines as text bars, a drawing's shapes,
 * an artifact's frame. A kind with nothing to draw keeps its glyph.
 */
function Thumbnail({ kind, preview }: { kind: string; preview: LedgerPreview }) {
  if (kind === 'doc' && preview.outline && preview.outline.length > 0) {
    return (
      <span className="tch-rthumb" data-kind="doc" data-testid="chat-receipt-thumb">
        {preview.outline.map((line, i) => (
          <span
            key={i}
            className="tch-rthumb__bar"
            data-heading={line.heading ? '' : undefined}
            style={{ width: `${Math.round(line.width * 100)}%` }}
          />
        ))}
      </span>
    );
  }
  if (kind === 'drawing' && preview.boxes && preview.boxes.length > 0) {
    return (
      <span className="tch-rthumb" data-kind="drawing" data-testid="chat-receipt-thumb">
        <DrawingSvg boxes={preview.boxes} />
      </span>
    );
  }
  if (kind === 'artifact') {
    return (
      <span className="tch-rthumb" data-kind="artifact" data-testid="chat-receipt-thumb">
        <span className="tch-rthumb__chrome" />
        <span className="tch-rthumb__block" />
        <span className="tch-rthumb__block" data-wide="" />
      </span>
    );
  }
  return null;
}

function DrawingSvg({ boxes }: { boxes: NonNullable<LedgerPreview['boxes']> }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x, b.x + b.w);
    minY = Math.min(minY, b.y, b.y + b.h);
    maxX = Math.max(maxX, b.x, b.x + b.w);
    maxY = Math.max(maxY, b.y, b.y + b.h);
  }
  const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.08;
  const view = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2 || 1} ${maxY - minY + pad * 2 || 1}`;
  return (
    <svg viewBox={view} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" aria-hidden>
      {boxes.map((b, i) =>
        b.type === 'arrow' || b.type === 'line' ? (
          <line key={i} x1={b.x} y1={b.y} x2={b.x + b.w} y2={b.y + b.h} className="tch-rthumb__line" vectorEffect="non-scaling-stroke" />
        ) : b.type === 'ellipse' ? (
          <ellipse key={i} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={Math.abs(b.w) / 2} ry={Math.abs(b.h) / 2} className="tch-rthumb__shape" vectorEffect="non-scaling-stroke" />
        ) : (
          <rect key={i} x={Math.min(b.x, b.x + b.w)} y={Math.min(b.y, b.y + b.h)} width={Math.abs(b.w)} height={Math.abs(b.h)} rx={Math.abs(b.w) * 0.08} className="tch-rthumb__shape" vectorEffect="non-scaling-stroke" />
        ),
      )}
    </svg>
  );
}
