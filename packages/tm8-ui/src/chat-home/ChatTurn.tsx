/**
 * ONE CHAT TURN — byline, body, attachments and parts — as Chat Home draws it.
 *
 * Lifted out of `ChatHomeScreen` unchanged so every surface that shows a
 * conversation draws its turns with THIS component rather than a copy of its
 * geometry: Chat Home's thread, the work-session Transcript surface
 * (`transcript/TranscriptTurns.tsx`, which maps transcript entries onto
 * `ChatTurn`), and any other host that holds `ChatTurn`-shaped data. A copy
 * drifts; the transcript's old lifted `.tr-turn` block had already drifted in
 * type size, column width and byline before this existed.
 *
 * The styles are `chat-home.css` (`.tch-turn`, `.tch-user-body`, `.tch-parts`
 * and the part sheets `TurnParts` brings). Every rule a turn needs is scoped to
 * its own `.tch-*` classes, not to the Chat Home grid, so importing the sheet
 * here is what lets a host outside Chat Home render a turn correctly.
 */
import type { ChatMode, EntityId } from '@tm8/contract';
import { actorName } from '../domain';
import { Avatar, Markdown, Timestamp } from '../kit';
import { chatMarkdownSource } from '../channel-screen/feed-model';
import { MessageAttachments } from '../files/MessageAttachments';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import type { ChatLedger } from './ledger';
import { TurnParts, type TurnPartsProps } from './TurnParts';
import { projectTurnParts } from './turn-model';
import type { ChatTurn as ChatTurnModel } from './types';
import './chat-home.css';

export function ChatTurn({
  turn,
  mode,
  pending,
  live,
  testId,
  viewerId,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
  ledger,
  toolNote,
}: {
  turn: ChatTurnModel;
  /** The thread's mode, drawn as the byline chip. Absent — a work-session
   *  transcript has no chat mode — draws no chip rather than inventing one. */
  mode?: ChatMode | undefined;
  /** This turn is the one the pulse is already announcing. */
  pending?: boolean;
  /** This is the agent turn in progress — the shell, or the real message
   *  while it streams. */
  live?: boolean;
  testId?: string;
  viewerId?: string | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
  /** The whole thread's ledger fold, for cross-turn memory in the lines. */
  ledger?: ChatLedger | undefined;
  toolNote?: TurnPartsProps['toolNote'];
}) {
  const label = (turn.author ? actorName(turn.author) : null) ?? (turn.role === 'assistant' ? 'Agent' : 'You');
  const actorId = turn.author?.id ?? `chat-${turn.role}`;
  const agent = turn.author?.isAgent ?? turn.role === 'assistant';
  /**
   * Sidedness is decided by AUTHOR IDENTITY, not role — in a shared thread
   * another human's turn is also `role: 'user'` and must land right. A null
   * author on a user turn is your own message rendered optimistically before
   * the server echo; treating it as self prevents a visible left→right flip
   * on send. No `viewerId` degrades to the role heuristic — never crash,
   * never guess.
   */
  /**
   * THIRD PARTY — this turn was written from SOMEWHERE ELSE.
   *
   * A chat is a routing target since 176, so a message here may have been
   * posted by a work session reporting back, or by another chat. Neither is
   * the person this conversation is with, and neither is its agent — but the
   * AUTHOR cannot tell them apart: a session's persona resolves to the same
   * `team_member` summary the chat's own agent carries. The port reads the
   * `authored_from` edge instead and drops the chat's own id (its agent turns
   * carry provenance too, pointing at the chat), so presence here means
   * exactly "not from this conversation".
   *
   * IT OVERRIDES SIDEDNESS. A third-party turn is `role: 'user'` and, with no
   * `viewerId` supplied, the role heuristic would land it on the viewer's own
   * side — a worker's report drawn as something you said. Neither side is
   * right for it, so it renders in the middle lane and says who sent it.
   */
  const thirdParty = turn.sourceEntityId != null;
  const isSelf = thirdParty
    ? false
    : viewerId
      ? turn.author
        ? turn.author.id === viewerId
        : turn.role === 'user'
      : turn.role === 'user';
  /**
   * AN ANSWER IS ITS RENDERED PARTS. The server writes the assistant message
   * body twice — 'Agent turn in progress.' when the turn is claimed, the
   * finished text when it completes — because feeds, previews and
   * notifications have no parts to read. Here they do, so printing the body
   * alongside them said the same thing twice: the answer duplicated on every
   * re-read, and a redundant placeholder bubble under the thinking pulse.
   *
   * The test is what the transcript actually DRAWS, not how many rows were
   * stored. `projectTurnParts` folds a call and its result into one card and
   * drops `done` entirely, so a turn that terminated without producing output
   * holds one part and renders nothing — suppressing its body on `length` left
   * an empty bubble where the durable 'Agent turn completed.' should be.
   *
   * A turn that draws nothing is not an answer: either an ordinary message
   * posted into this thread by a teammate, whose body is all it has to say, or
   * the claimed-but-silent turn the pulse is already covering.
   *
   * `turnInFlight` is the server's wire marker for that claim (133 projects
   * `chat_turns.agent_message_id` onto `messages.list`): while it is set the
   * body IS the placeholder, on any read — a reload or thread switch mid-turn
   * included, where the heuristics below have no snapshot to lean on.
   */
  const bodyIsContent =
    (turn.role !== 'assistant' || (projectTurnParts(turn.parts).length === 0 && !pending))
    && !turn.turnInFlight;
  return (
    <article
      className="tch-turn"
      data-role={turn.role}
      data-mode={mode}
      data-self={isSelf ? 'true' : 'false'}
      data-third-party={thirdParty ? 'true' : undefined}
      data-live={live ? 'true' : undefined}
      aria-busy={live || undefined}
      data-testid={testId}
    >
      <header className="tch-turn__byline">
        <Avatar
          actorId={actorId}
          provenance={agent ? 'agent' : 'human'}
          label={label}
          size={20}
          src={turn.author?.avatar}
        />
        <strong>{label}</strong>
        {/* THE SOURCE, AS A CHIP — the same `EntityChip` a tool call's entity
            reference gets, resolving kind mark and title through the same
            cached reader. A bare id would say "this came from elsewhere"
            without saying from where, which is the half of the fact that
            matters when a worker reports into a chat you are watching. */}
        {turn.sourceEntityId ? (
          <span className="tch-turn__source" data-testid="chat-turn-source">
            <span className="tch-turn__source-word">via</span>
            <EntityChip
              refInfo={{ id: turn.sourceEntityId }}
              resolve={resolveEntity}
              onOpen={onOpenEntity}
            />
          </span>
        ) : null}
        {mode ? (
          <span className="tch-mode-chip" title={`This answer ran in ${mode} mode`}>{mode}</span>
        ) : null}
        <Timestamp at={turn.createdAt} />
      </header>
      {bodyIsContent && turn.body ? (
        /* A typed message is MARKDOWN, exactly as the channel feed already
           treats every author — `**bold**` must not print its asterisks here
           while rendering bold one surface over. Same preparation the feed
           uses (empty mention list): a lone newline stays a line break, a
           fenced block keeps its bytes. */
        <Markdown
          source={chatMarkdownSource(turn.body, []).source}
          className="tch-user-body"
          testId="chat-user-body"
        />
      ) : null}
      {/*
        THE FILES THE MESSAGE CARRIES, under the body it was sent with. They
        belong to the durable message, not to the streamed parts, so they sit
        outside `TurnParts` and render on a turn that has no parts at all —
        which is exactly the reporter's case: a human turn that is an image and
        one line of text. `assetHref` is already the transcript's bytes
        resolver (`ChatHomeSurface` hands it `seam.files.downloadHref`); no
        second prop, and no URL built here.
      */}
      <MessageAttachments
        attachments={turn.attachments ?? []}
        downloadHref={assetHref}
        onOpenEntity={onOpenEntity}
        className="tch-turn__attachments"
        testId="chat-turn-attachments"
      />
      <TurnParts
        parts={turn.parts}
        onOpenEntity={onOpenEntity}
        resolveEntity={resolveEntity}
        suppressEntityIds={suppressEntityIds}
        assetHref={assetHref}
        ledger={ledger}
        turnMessageId={turn.messageId}
        toolNote={toolNote}
        /* One source of truth for which turn is live (L1's turn-in-progress,
           which also drives `aria-busy`): every other turn is over, and a call
           it left `running` reads as stopped — a runtime that died never
           closes the calls it abandoned. */
        settled={!live}
      />
    </article>
  );
}
