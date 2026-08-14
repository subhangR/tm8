import { useEffect, useRef, useState } from 'react';
import type { EntityId, MessageView } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { Avatar } from '../kit';
import { DisabledAction, DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { skillReference, useRichInput, type TriggerOption } from '../rich-input';
import type { ChannelPostInput } from './feed-model';
import type { ComposerMentionOption } from './channel-tags';
import type { ChatAttachmentUploadTask } from './chat-attachments';

export type { ComposerMentionOption } from './channel-tags';

/**
 * THE T10 COMPOSER — §7's four send layers, as controls.
 *
 * The oracle's own footer states this component's contract in copy: "Enter
 * sends · Shift+Enter newline" and "draft keyed member+session · survives
 * switches & reconnects". A build that wires only the button has DRAWN a
 * promise it does not keep, so the keyboard path is tested beside the click.
 *
 * SINCE THE RICH-INPUT LIFT: the trigger grammar (`@` mentions, `/` skills),
 * the popover keyboard contract, paste extraction and the staged-upload
 * machine live in `rich-input/useRichInput` — this file keeps what is
 * genuinely the CHAT's: the send layers, reply/thread restrictions, the
 * workspace-attach picker (a searchable listbox, not a sigil trigger), and
 * its own `chs-*` markup over the hook's state. Behaviour is unchanged;
 * paste now takes the agent-readable set (R2) rather than images only, and
 * `/` references a skill (R1 — a reference, never an invocation).
 *
 * THE ONE THING THIS COMPONENT WILL NOT DO: pretend. Every refusal below names
 * which fact is missing, because the three ways Send can be unavailable are
 * three different situations for the person typing —
 *
 *   · no dispatcher wired   → the build cannot send (our gap, not theirs);
 *   · offline               → the network cannot carry it, and there is no
 *                             contracted offline queue, so a cheerful "queued"
 *                             would be a fabricated promise (S11);
 *   · session exited        → Send WORKS and stores; nothing is delivered and
 *                             nothing wakes (S21). This one is a warning, NOT
 *                             a disable — refusing here would destroy a
 *                             legitimate, permitted write.
 *
 * Draft state is deliberately local and deliberately sticky: a cancelled reply
 * keeps the text (the oracle says so in a tooltip), and a REJECTED send keeps
 * it too — when the mutation failed, the draft is the only copy that exists
 * anywhere (S17).
 */

export interface ComposerProps {
  anchorId: EntityId;
  anchorNoun: string;
  /** Absent ⇒ Send is disabled-with-reason, never enabled-inert. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** T4 honesty. `offline`/`polling` withdraw Send; nothing is queued. */
  connection?: ConnectionState;
  /** S21 — store-only composing. A warning, never a disable. */
  sessionExited?: boolean;
  replyTo: MessageView | null;
  onCancelReply: () => void;
  /**
   * THE THREAD COMPOSER'S ONE EXTRA FACT: everything it stores is a reply in
   * this branch. With no explicit `replyTo` the parent is the root itself;
   * arming `replyTo` on a message inside the branch targets that message
   * instead. Every reply-only restriction (no session/team @tags, no
   * workspace-entity anchors — a reply has exactly ONE anchor, its parent's)
   * applies to the whole branch, not only to armed replies. The CHANNEL
   * composer never sets this: it posts roots only, `parentMessageId` null.
   */
  threadRoot?: MessageView | null;
  /** Production hosts control this from the member+session draft store. */
  draft?: string;
  onDraftChange?: (body: string) => void;
  uncertainSubmission?: {
    message: string;
    reconciling: boolean;
    onReconcile: () => void;
  } | null;
  /** Present only when immutable action discovery found the full file lifecycle. */
  onStartAttachmentUpload?: (file: File) => ChatAttachmentUploadTask;
  /** `undefined` means mentions are unavailable; an empty list is a measured zero. */
  mentionOptions?: readonly ComposerMentionOption[];
  /**
   * Workspace entities the attach picker offers (tasks, docs, people).
   * `undefined` means the host has no attach seam; an empty list is a
   * measured zero and keeps the control visible so it can say so.
   */
  attachEntityOptions?: readonly ComposerMentionOption[];
  /**
   * Skills the `/` trigger can reference (R1: a committed skill is a
   * `tm8://skill/<id>` link in the body — the agent reads it and chooses).
   * `undefined` means the host has no skill seam; `/` then types plain text.
   */
  skillOptions?: readonly TriggerOption[];
}

const NO_UPLOAD_SEAM = {
  cause: 'Attachments aren’t available for this Interaction Profile',
  remedy: 'the pinned composer policy must bind messages.post and the complete canonical file upload lifecycle',
};

export function Composer({
  anchorId,
  anchorNoun,
  onPost,
  connection,
  sessionExited = false,
  replyTo,
  onCancelReply,
  threadRoot = null,
  draft,
  onDraftChange,
  uncertainSubmission = null,
  onStartAttachmentUpload,
  mentionOptions,
  attachEntityOptions,
  skillOptions,
}: ComposerProps) {
  const [localText, setLocalText] = useState('');
  const text = draft ?? localText;
  const setText = (next: string) => {
    if (draft === undefined) setLocalText(next);
    onDraftChange?.(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachedEntities, setAttachedEntities] = useState<ComposerMentionOption[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState('');
  const [attachActive, setAttachActive] = useState(0);
  const attachListbox = useRef<HTMLDivElement>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMentionOption[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const disconnected = connection?.phase === 'offline' || connection?.phase === 'polling';
  const composingReply = Boolean(replyTo || threadRoot);
  const replyAuthor = replyTo ? (replyTo.state.author ?? replyTo.createdBy) : null;

  /**
   * The hook owns the trigger grammar and the staged-upload machine; this
   * component declares what each capability MEANS here. Mentions available in
   * a reply exclude routed targets (a reply cannot re-route a session), which
   * is why the option list is filtered before it reaches the trigger.
   */
  const availableMentionOptions = mentionOptions === undefined
    ? undefined
    : mentionOptions.filter((option) => !composingReply || !option.route);

  const rich = useRichInput({
    value: text,
    onChange: setText,
    areaRef: textarea,
    triggers: [
      {
        sigil: '@',
        options: availableMentionOptions,
        onSelect: (option) => {
          const mention = option as ComposerMentionOption;
          setSelectedMentions((current) => current.some((item) => item.id === mention.id)
            ? current
            : [...current, mention]);
          return { insert: `@${mention.display} ` };
        },
      },
      {
        sigil: '/',
        options: skillOptions,
        onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
      },
    ],
    attachments: {
      start: onStartAttachmentUpload,
      placement: { mode: 'chip' },
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        if (replyTo) onCancelReply();
        return;
      }
      // Shift+Enter is the newline and must fall through to the textarea
      // untouched; anything else here would swallow a keystroke the
      // footer copy promises works.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
  });
  const attachments = rich.attachments!;
  const popover = rich.popover;

  /**
   * The workspace-attach picker. Same PREFIX filter as the `@` list, same
   * one-column listbox — a different trigger for a different fact: attaching
   * references an entity on the message (tasks/docs also receive the message
   * on their own feed); it never inserts text into the draft and never routes
   * a session, which stays the `@` picker's contract.
   */
  const attachQuery = attachSearch.trim().toLowerCase();
  const availableAttachOptions = (attachEntityOptions ?? [])
    .filter((option) => !attachedEntities.some((item) => item.id === option.id)
      && !selectedMentions.some((item) => item.id === option.id))
    .filter((option) => {
      if (!attachQuery) return true;
      const display = option.display.toLowerCase();
      return display.startsWith(attachQuery)
        || display.split(/\s+/).some((word) => word.startsWith(attachQuery));
    });
  const attachActiveIndex = availableAttachOptions.length
    ? Math.min(attachActive, availableAttachOptions.length - 1)
    : 0;
  const activeAttachOption = availableAttachOptions[attachActiveIndex];

  const closeAttachPicker = (): void => {
    setAttachOpen(false);
    setAttachSearch('');
    setAttachActive(0);
  };

  const selectAttachOption = (option: ComposerMentionOption): void => {
    if (option.attach === 'anchor') {
      setAttachedEntities((current) => current.some((item) => item.id === option.id)
        ? current
        : [...current, option]);
    } else {
      // A person, attached: a canonical mention reference without touching
      // the draft text — the server echoes it into content.mentions.
      setSelectedMentions((current) => current.some((item) => item.id === option.id)
        ? current
        : [...current, option]);
    }
    closeAttachPicker();
    textarea.current?.focus();
  };

  useEffect(() => {
    if (!uncertainSubmission) setError(null);
  }, [uncertainSubmission]);

  /**
   * Keep the highlighted row inside the scroll port. `scrollIntoView` is
   * optional-called because jsdom does not implement it — the guard keeps the
   * keyboard tests honest instead of stubbing the DOM.
   */
  useEffect(() => {
    if (!attachOpen) return;
    const active = attachListbox.current?.querySelector('[data-active="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [attachOpen, attachActiveIndex]);

  const mentionListbox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!popover) return;
    const active = mentionListbox.current?.querySelector('[data-active="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [popover, popover?.activeIndex]);

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy || !onPost || disconnected || uncertainSubmission) return;
    setBusy(true);
    setError(null);
    try {
      const attachmentIds = attachments.uploadedIds() as EntityId[];
      const mentionIds = selectedMentions.flatMap((mention) =>
        mention.kind === 'member' || mention.kind === 'team_member' ? [mention.id] : []);
      const tagTargetIds = selectedMentions.flatMap((mention) => mention.route ? [mention.id] : []);
      /* Lane C's poke-on-reply proposal (pokeSessionIds) lands HERE when its
         server half and ruling arrive; until then the refusal below is the
         truth of the wire for every reply, thread-composed or armed. */
      if (composingReply && tagTargetIds.length) {
        throw new Error('Team and session @Tags are available only on top-level channel messages');
      }
      /* A reply has exactly ONE anchor — its parent's. The server enforces
         this; refusing here keeps the draft beside a reason instead of a
         round-trip rejection. */
      if (composingReply && attachedEntities.length) {
        throw new Error('Attached workspace entities are available only on top-level messages — a reply stays on its parent’s anchor');
      }
      await onPost({
        anchorIds: [...new Set([anchorId, ...attachedEntities.map((item) => item.id)])],
        body,
        parentMessageId: replyTo?.id ?? threadRoot?.id ?? null,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(mentionIds.length ? { mentionIds: [...new Set(mentionIds)] } : {}),
        ...(tagTargetIds.length ? { tagTargetIds: [...new Set(tagTargetIds)] } : {}),
      });
      // Cleared ONLY on success. The reply target clears with it: the next
      // message is a new thought unless the user says otherwise.
      setText('');
      attachments.clear();
      setAttachedEntities([]);
      setSelectedMentions([]);
      onCancelReply();
    } catch (e) {
      /*
       * The refusal is held HERE, beside the text that failed (T5-5's
       * anti-toast law: a refusal never leaves the surface that asked). And
       * the draft survives — S17's "Draft and attachments kept" is not a
       * courtesy, it is the only remaining copy of an unstored message.
       */
      setError(e instanceof Error ? e.message : 'The message was not stored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chs-composer">
      {sessionExited ? (
        <p className="chs-composer__warn" data-testid="chs-exited">
          Session exited — Send stores the message; nothing is delivered, nothing wakes.
        </p>
      ) : null}

      {error ? (
        <p className="chs-composer__error" role="alert">
          {error}
        </p>
      ) : null}

      {attachments.refusal ? (
        <p className="chs-composer__error" role="alert" data-testid="chs-paste-refusal">
          {attachments.refusal}
          <button type="button" onClick={attachments.clearRefusal} aria-label="Dismiss">✕</button>
        </p>
      ) : null}

      {uncertainSubmission ? (
        <div className="chs-composer__uncertain" role="alert" data-testid="chs-uncertain">
          <span>{uncertainSubmission.message}</span>
          <button
            type="button"
            disabled={uncertainSubmission.reconciling}
            onClick={uncertainSubmission.onReconcile}
          >
            {uncertainSubmission.reconciling ? 'Reconciling…' : 'Reconcile send'}
          </button>
        </div>
      ) : null}

      {replyTo ? (
        <div className="chs-replying" data-testid="chs-replying">
          {replyAuthor ? (
            <Avatar
              actorId={replyAuthor.id}
              provenance={replyAuthor.isAgent ? 'agent' : 'human'}
              label={replyAuthor.displayName}
              size={20}
              src={replyAuthor.avatar ?? null}
            />
          ) : null}
          <span className="chs-replying__label">
            {`REPLYING TO ${replyTo.state.author?.displayName ?? replyTo.createdBy?.displayName ?? 'message'}`}
          </span>
          <span className="chs-replying__excerpt">{replyTo.content.body}</span>
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Cancel reply"
            title="cancel reply — draft text is kept"
            onClick={onCancelReply}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      ) : null}

      {attachments.staged.length ? (
        <ul className="chs-upload-list" aria-label="Attachments" aria-live="polite">
          {attachments.staged.map((item) => (
            <li key={item.id} className="chs-upload" data-phase={item.phase}>
              <span className="chs-upload__name">{item.file.name}</span>
              {item.phase === 'uploading' ? <span role="status">uploading…</span> : null}
              {item.phase === 'uploaded' ? <span>✓ uploaded</span> : null}
              {item.phase === 'failed' ? (
                <span role="alert" className="chs-upload__error">{item.reason}</span>
              ) : null}
              {item.phase === 'failed' ? (
                <button type="button" onClick={() => attachments.retry(item.id)} aria-label={`Try ${item.file.name} again`}>
                  Try again
                </button>
              ) : null}
              <button type="button" onClick={() => attachments.remove(item.id)} aria-label={`Remove ${item.file.name}`}>
                {item.phase === 'uploading' ? 'Cancel' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachedEntities.length ? (
        <ul className="chs-mention-list" aria-label="Attached workspace entities">
          {attachedEntities.map((entity) => (
            <li key={entity.id}>
              <span>{entity.display}</span>
              <span className="chs-attach-kind">{entity.kind === 'task' ? 'task' : 'doc'}</span>
              <button
                type="button"
                aria-label={`Remove attached ${entity.display}`}
                onClick={() => setAttachedEntities((current) => current.filter((item) => item.id !== entity.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selectedMentions.length ? (
        <ul className="chs-mention-list" aria-label="Mentioned people and session targets">
          {selectedMentions.map((mention) => (
            <li key={mention.id}>
              <MentionFace option={mention} />
              <span>{`@${mention.display}`}</span>
              <button
                type="button"
                aria-label={`Remove tag ${mention.display}`}
                onClick={() => setSelectedMentions((current) => current.filter((item) => item.id !== mention.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachOpen && attachEntityOptions ? (
        <div className="chs-mention-picker" data-testid="chs-attach-picker">
          <input
            className="chs-attach-search"
            type="text"
            aria-label="Search workspace entities to attach"
            placeholder="Search tasks, docs, people…"
            autoFocus
            value={attachSearch}
            onChange={(event) => {
              setAttachSearch(event.target.value);
              setAttachActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeAttachPicker();
                textarea.current?.focus();
                return;
              }
              if (!availableAttachOptions.length) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setAttachActive((current) => (current + 1) % availableAttachOptions.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setAttachActive((current) => (
                  current - 1 + availableAttachOptions.length) % availableAttachOptions.length);
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                if (activeAttachOption) {
                  event.preventDefault();
                  selectAttachOption(activeAttachOption);
                }
              }
            }}
          />
          <div
            ref={attachListbox}
            role="listbox"
            aria-label="Attachable workspace entities"
          >
            {availableAttachOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                data-active={index === attachActiveIndex}
                aria-selected={false}
                onMouseEnter={() => setAttachActive(index)}
                onClick={() => selectAttachOption(option)}
              >
                <span className="chs-mention-picker__identity">
                  <MentionFace option={option} />
                  <span className="chs-mention-picker__name">{option.display}</span>
                </span>
                <span className="chs-mention-picker__meta">{option.meta ?? option.group ?? option.kind}</span>
              </button>
            ))}
          </div>
          {availableAttachOptions.length ? null : (
            <p className="chs-mention-picker__empty" role="status">
              No attachable workspace entities match
            </p>
          )}
        </div>
      ) : null}

      {popover ? (
        <div
          className="chs-mention-picker"
          data-testid={popover.sigil === '/' ? 'chs-skill-picker' : 'chs-mention-picker'}
        >
          {popover.query ? (
            <p className="chs-mention-picker__query">
              {`Matching “${popover.query.toLowerCase()}”`}
            </p>
          ) : null}
          <div
            id={popover.listboxId}
            ref={mentionListbox}
            role="listbox"
            aria-label={popover.sigil === '/' ? 'Available skills' : 'Available @Tag options'}
          >
            {popover.options.map((option, index) => (
              <button
                key={option.id}
                id={popover.optionDomId(option)}
                type="button"
                role="option"
                data-active={index === popover.activeIndex}
                aria-selected={popover.sigil === '@'
                  && selectedMentions.some((item) => item.id === option.id)}
                /* Pointer hover moves the highlight so the mouse and the arrow
                   keys never disagree about which row Enter would take. */
                onMouseEnter={() => popover.setActive(index)}
                onClick={() => popover.select(option)}
              >
                <span className="chs-mention-picker__identity">
                  {popover.sigil === '@' ? <MentionFace option={option as ComposerMentionOption} /> : null}
                  <span className="chs-mention-picker__name">
                    {popover.sigil === '/' ? `/${option.display}` : option.display}
                  </span>
                </span>
                <span className="chs-mention-picker__meta">
                  {option.meta ?? option.group
                    ?? ((option as ComposerMentionOption).kind === 'team_member' ? 'agent'
                      : (option as ComposerMentionOption).kind === 'member' ? 'member'
                        : 'skill')}
                </span>
              </button>
            ))}
          </div>
          {popover.options.length ? null : (
            <p className="chs-mention-picker__empty" role="status">
              {popover.sigil === '/' ? 'No matching skills' : 'No matching @Tag options'}
            </p>
          )}
        </div>
      ) : null}

      <div
        className="chs-composer__row"
        onDragOver={(event) => {
          if (onStartAttachmentUpload && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          // A drop on the textarea itself was already taken by the hook and
          // bubbles up here — without this guard the same files would stage twice.
          if (event.defaultPrevented) return;
          if (!onStartAttachmentUpload || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          attachments.addFiles(event.dataTransfer.files);
        }}
      >
        {onStartAttachmentUpload ? (
          <>
            <button type="button" className="chs-iconbtn" aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
              <span aria-hidden>＋</span>
            </button>
            <input
              ref={fileInput}
              className="chs-visually-hidden"
              type="file"
              multiple
              aria-label="Choose files to attach"
              onChange={(event) => {
                if (event.target.files) attachments.addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </>
        ) : (
          <DisabledIconControl label="Attach a file" glyph="＋" reason={NO_UPLOAD_SEAM} />
        )}
        {attachEntityOptions ? (
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Attach from workspace"
            title="attach a task, doc, or person — tasks and docs also receive this message on their Discussion"
            aria-haspopup="listbox"
            aria-expanded={attachOpen}
            onClick={() => {
              if (attachOpen) closeAttachPicker();
              else {
                popover?.close();
                setAttachOpen(true);
              }
            }}
          >
            <span aria-hidden>⌗</span>
          </button>
        ) : null}
        {mentionOptions ? (
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Mention someone"
            aria-haspopup="listbox"
            aria-expanded={popover?.sigil === '@'}
            onClick={() => {
              /**
               * The toolbar `@` and typing `@` must land in the SAME state, or
               * the picker has two behaviours and only one of them filters —
               * so the button types the character on the user's behalf
               * (`openTrigger`) and hands focus straight back to the textarea.
               */
              if (popover?.sigil === '@') popover.close();
              else rich.openTrigger('@');
            }}
          >
            <span aria-hidden>@</span>
          </button>
        ) : null}
        {skillOptions ? (
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Reference a skill"
            title="reference a skill — the agent reads it and decides; nothing runs by itself"
            aria-haspopup="listbox"
            aria-expanded={popover?.sigil === '/'}
            onClick={() => {
              if (popover?.sigil === '/') popover.close();
              else rich.openTrigger('/');
            }}
          >
            <span aria-hidden>/</span>
          </button>
        ) : null}
        <textarea
          ref={textarea}
          className="chs-composer__input"
          aria-label={`Message ${anchorNoun}`}
          placeholder={`Message ${anchorNoun}…`}
          /* The textarea IS the picker's text input, so it carries the
             active-row pointer. `aria-expanded` is deliberately absent: it is
             not an allowed attribute on role=textbox, and promoting this to
             role=combobox would change how every existing query finds it. */
          value={text}
          disabled={busy}
          {...rich.areaProps}
        />
        <SendControl
          disconnected={disconnected}
          wired={Boolean(onPost)}
          busy={busy}
          empty={text.trim().length === 0}
          blocked={uncertainSubmission !== null}
          attachmentBlocked={attachments.blocked}
          onClick={() => void submit()}
        />
      </div>

      <p className="chs-composer__hint">
        <span>Enter sends · Shift+Enter newline</span>
      </p>
    </div>
  );
}

/** Task/doc/session options are entities; only member rows carry actor faces. */
function MentionFace({ option }: { option: ComposerMentionOption }) {
  if (option.kind !== 'member' && option.kind !== 'team_member') return null;
  return (
    <Avatar
      actorId={option.id}
      provenance={option.kind === 'team_member' ? 'agent' : 'human'}
      label={option.display}
      size={20}
    />
  );
}

function SendControl({
  disconnected,
  wired,
  busy,
  empty,
  blocked,
  attachmentBlocked,
  onClick,
}: {
  disconnected: boolean;
  wired: boolean;
  busy: boolean;
  empty: boolean;
  blocked: boolean;
  attachmentBlocked: boolean;
  onClick: () => void;
}) {
  if (!wired) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'Sending isn’t connected in this surface yet',
            remedy: 'the composer is real; its dispatcher is not wired at this mount point',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (disconnected) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'You’re offline — nothing is reaching the node',
            remedy: 'there is no offline queue, so your draft is kept here and sends when the connection returns',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (blocked) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'A previous send has an unknown storage outcome',
            remedy: 'reconcile that same submission before creating another message identity',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (attachmentBlocked) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'One or more attachments are not ready',
            remedy: 'wait for uploads to finish, retry failures, or remove them before sending',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  return (
    <button type="button" className="chs-composer__send" disabled={busy || empty} onClick={onClick}>
      {busy ? '…' : 'Send'}
    </button>
  );
}
