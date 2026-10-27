/**
 * §10.4 — CONNECTORS FOR THIS CHAT: the ＋ sheet's body, the chip beside it,
 * and the one hook that owns a thread's selection.
 *
 * ---------------------------------------------------------------------------
 * G4, which is the defect this closes
 * ---------------------------------------------------------------------------
 *
 * The composer's connector picker only ever appeared for a NEW thread
 * (`newThread && <McpPicker …>`), and a chat's selection was written once at
 * creation by `save_chat_mcp_selections` with `on conflict do nothing`. So the
 * first message's list won for the life of the thread: there was no way to turn
 * Gmail on in a conversation that had already said hello. `chat.setMcpSelections`
 * (#1318) made the row changeable and #1331 made a change actually reach the
 * next turn; this is the surface that lets a person make one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HOOK HOLDS, and why it is not just a piece of state
 * ---------------------------------------------------------------------------
 *
 * A new thread's selection lives in the browser until Send, because there is
 * no chat to address yet — it rides `chat.start`. An existing thread's
 * selection lives in Postgres, and the hook's job is to keep the two apart
 * while giving the sheet ONE value to draw:
 *
 *  - NEW THREAD: a local value, sent with `chat.start` (and omitted when the
 *    human changed nothing, §5.3).
 *  - EXISTING THREAD: read once per thread through `chat.getMcpSelections`,
 *    written through `chat.setMcpSelections`, and REPAINTED FROM WHAT THE
 *    SERVER STORED rather than from what we sent. A write that is refused
 *    leaves the switch where the server says it is, which is the only
 *    non-lying way to draw a failed toggle.
 *
 * `undefined` is "no human has chosen", `null` on the wire is the same fact,
 * and `[]` is "every connector off". The three are kept distinct end to end;
 * see `port.ts` for why collapsing any pair is a silent widening or narrowing
 * of somebody's choice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectorToggleList } from '../../mcp/ConnectorToggleList';
import { connectorRows, needsAttention, readyCount } from '../../mcp/row-model';
import { useMcpCatalog } from '../../mcp/context';
import type { McpSelection } from '../../mcp/port';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';

/** G13. Codex lanes get no tm8 connectors yet, and the menu says so. */
export const CODEX_CONNECTORS_REASON = 'Connectors aren’t available for Codex chats yet.';
/** The §10.4 state for a thread opened through a Space link. */
export const LINK_CONNECTORS_REASON = 'Chats opened through a Space link don’t get connectors.';

export interface ChatConnectorsState {
  /** What the sheet draws. `undefined` = on the Space's defaults. */
  value: McpSelection[] | undefined;
  /** For `chat.start`: the value to send, or nothing when the human chose nothing. */
  change(next: McpSelection[] | undefined): void;
  /** A read or write in flight. */
  busy: boolean;
  /** The last write's failure, for the sheet's "Couldn't update connectors". */
  error: string | null;
  /** The stored row could not be read, so the sheet must not pretend to know. */
  unreadable: boolean;
  /** This build's seam has no connector port at all. */
  available: boolean;
}

/**
 * ONE thread's selection.
 *
 * `chatId === null` is the new-thread case and stays entirely local. A thread
 * id turns the hook into a reader/writer, and switching threads re-reads: the
 * previous thread's list must never be shown as this one's, which is the kind
 * of bug that silently lends an account to the wrong conversation.
 */
export function useChatConnectors(chatId: string | null): ChatConnectorsState {
  const { port } = useMcpCatalog();
  const [local, setLocal] = useState<McpSelection[] | undefined>();
  const [stored, setStored] = useState<McpSelection[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  // A write in flight owns the value. Without this the read that follows a
  // thread switch could land after a toggle and undo it on screen.
  const writing = useRef(false);

  const canRead = Boolean(port?.chatSelections);
  useEffect(() => {
    setError(null);
    setUnreadable(false);
    if (chatId === null || !port?.chatSelections) { setStored(undefined); return; }
    let live = true;
    setBusy(true);
    port.chatSelections(chatId).then(
      selections => { if (live) { setStored(selections ?? undefined); setUnreadable(false); } },
      () => {
        // The read failing is NOT "this thread is on defaults": that would show
        // "Using: Space defaults" for a thread that may well have an explicit
        // list, and a toggle from there would overwrite it.
        if (live) setUnreadable(true);
      },
    ).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [chatId, port, canRead]);

  const change = useCallback((next: McpSelection[] | undefined) => {
    if (chatId === null) { setLocal(next); return; }
    const write = port?.setChatSelections;
    if (!write) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    write(chatId, next ?? null).then(
      landed => { setStored(landed ?? undefined); setUnreadable(false); },
      (cause: unknown) => {
        // The switch REVERTS, because `stored` never moved: the sheet is drawn
        // from the server's answer and an unanswered write changed nothing.
        setError(cause instanceof Error ? cause.message : 'Couldn’t update connectors');
      },
    ).finally(() => { writing.current = false; setBusy(false); });
  }, [chatId, port]);

  return {
    value: chatId === null ? local : stored,
    change,
    busy,
    error,
    unreadable,
    available: Boolean(port) && (chatId === null || canRead),
  };
}

export interface ChatConnectorsSheetProps {
  state: ChatConnectorsState;
  /** The chat's subject, so defaults resolve for the right target. */
  targetId?: string;
  teamMemberId?: string;
  /** A turn is streaming: the change lands on the message after it. */
  streaming?: boolean;
  disabled?: boolean;
  testId?: string;
}

/**
 * The sheet's body — the same `ConnectorToggleList` the launch dialogs draw.
 *
 * Every empty here NAMES ITS CAUSE, because they are four different facts and
 * the remedy differs: a catalog still loading, a catalog that failed (which
 * must NOT block Send — the server resolves defaults itself), a Space with no
 * connectors, and a thread whose stored row could not be read.
 */
export function ChatConnectorsSheet({
  state,
  targetId,
  teamMemberId,
  streaming = false,
  disabled = false,
  testId = 'tch-connectors',
}: ChatConnectorsSheetProps) {
  const { catalog, error, loading, port, refresh } = useMcpCatalog(targetId, teamMemberId);
  if (!port || !state.available) {
    return <p className="tch-pickmenu__note" data-testid={`${testId}-unavailable`}>
      This node exposes no connectors to chat.
    </p>;
  }
  if (state.unreadable) {
    return <p className="tch-pickmenu__note" role="alert" data-testid={`${testId}-unreadable`}>
      This chat’s connectors couldn’t be read, so they aren’t shown. Reopen the chat to try again.
    </p>;
  }
  if (!catalog) {
    return error
      ? <p className="mcp-error" role="alert" data-testid={`${testId}-error`}>
          Couldn’t load connectors. <button type="button" className="tch-addmenu__row" onClick={refresh}>Retry</button>
          {/* Said out loud: this failure does not stop the message. */}
          <small>Sending still works — the server applies this Space’s defaults.</small>
        </p>
      : <p className="tch-pickmenu__note" role="status" data-testid={`${testId}-loading`}>
          {loading ? 'Loading connectors…' : 'No connectors on this surface.'}
        </p>;
  }
  return (
    <div className="tch-connectors" data-testid={testId}>
      <ConnectorToggleList
        catalog={catalog}
        value={state.value}
        onChange={state.change}
        disabled={disabled || state.busy}
        filterable
        resetLabel="Reset to Space defaults"
        testId={`${testId}-toggles`}
        {...(streaming
          ? { notice: 'Applies to your next message — the turn now running keeps the connectors it started with.' }
          : {})}
      />
      {state.error ? (
        <p className="mcp-error" role="alert" data-testid={`${testId}-save-error`}>
          Couldn’t update connectors. {state.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * §10.4's chip: `🔌 N`, where N is switched on AND ready.
 *
 * HIDDEN when nothing is on and the thread is on defaults, so a Space with no
 * connectors adds no furniture to the composer for a user who has never heard
 * of them. It is NOT hidden at zero when the human chose zero: `[]` is a
 * decision, and the struck-through `0` is how the composer admits to it.
 *
 * It opens the same body as the ＋ sheet. Two triggers, one component — the
 * alternative was reaching into `AddToTurnMenu`'s popover state from outside,
 * which makes the menu's open/closed a shared variable between two files.
 */
export function ConnectorsChip({
  state,
  targetId,
  teamMemberId,
  streaming = false,
  disabled = false,
  testId = 'tch-connectors-chip',
}: ChatConnectorsSheetProps) {
  const { catalog } = useMcpCatalog(targetId, teamMemberId);
  const explicit = state.value !== undefined;
  const rows = catalog ? connectorRows(catalog, state.value ?? catalog.defaults, explicit) : [];
  const count = readyCount(rows);
  const attention = needsAttention(rows);
  if (!state.available || (!explicit && count === 0)) return null;
  const allOff = explicit && state.value?.length === 0;
  return (
    <ComposerPopover
      label={`Connectors — ${count} on`}
      testId={testId}
      title="connectors for this chat"
      menuWidth={340}
      menuHeight={420}
      fitViewport
      disabled={disabled}
      className="tch-connectors-chip"
      trigger={
        <span className="tch-connectors-chip__face" data-attention={attention || undefined} data-off={allOff || undefined}>
          <ComposerIcon name="plug" />
          <span className="tch-connectors-chip__n">{count}</span>
          {attention ? <span className="tch-connectors-chip__dot" aria-label="a connector needs reconnecting" /> : null}
        </span>
      }
    >
      {() => (
        <ChatConnectorsSheet
          state={state}
          {...(targetId ? { targetId } : {})}
          {...(teamMemberId ? { teamMemberId } : {})}
          streaming={streaming}
          disabled={disabled}
          testId={`${testId}-sheet`}
        />
      )}
    </ComposerPopover>
  );
}
