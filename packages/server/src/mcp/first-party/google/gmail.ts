import { z } from 'zod';
import { GMAIL_SEND_GATE } from '@tm8/contract';
import { segment, tool, type GoogleApi, type GoogleTool } from './api.js';

/**
 * Gmail, read + draft (§8.2). `send_message` exists only while the connector's
 * `gmailSend` gate is TRUE; the catalog ships it false and an absent gate is
 * closed too, because sending is the one irreversible thing these tools do.
 */

const BODY_CHARS = 100_000;
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'];

interface Part { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] }
interface Message { id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part }

function header(part: Part | undefined, name: string): string | undefined {
  return part?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function walk(part: Part | undefined, visit: (part: Part) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** The readable body: the first text/plain part, else the first text/html part with its tags stripped. */
function body(payload: Part | undefined): string {
  let plain: string | undefined; let html: string | undefined;
  walk(payload, part => {
    if (part.filename || !part.body?.data) return;
    if (part.mimeType === 'text/plain' && plain === undefined) plain = decode(part.body.data);
    if (part.mimeType === 'text/html' && html === undefined) html = decode(part.body.data);
  });
  const text = plain ?? (html === undefined ? '' : html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim());
  return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}\n[truncated]` : text;
}

function summary(message: Message) {
  return {
    id: message.id, threadId: message.threadId,
    from: header(message.payload, 'From'), to: header(message.payload, 'To'),
    subject: header(message.payload, 'Subject'), date: header(message.payload, 'Date'),
    snippet: message.snippet, labelIds: message.labelIds,
  };
}

function full(message: Message) {
  const attachments: { filename: string; mimeType?: string; size?: number; attachmentId?: string }[] = [];
  walk(message.payload, part => { if (part.filename) attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body?.size, attachmentId: part.body?.attachmentId }); });
  return {
    ...summary(message), cc: header(message.payload, 'Cc'),
    messageIdHeader: header(message.payload, 'Message-ID'),
    body: body(message.payload), attachments,
  };
}

/** No CR or LF: a header value from the model can never start a new header. */
const HeaderText = (max: number, min = 0) => z.string().min(min).max(max).refine(value => !/[\r\n\0]/.test(value), 'must be a single line');
const Address = HeaderText(320, 3);
const Addresses = z.array(Address).min(1).max(50);

const Compose = z.object({
  to: Addresses.describe('Recipient addresses.'),
  cc: z.array(Address).max(50).optional(),
  bcc: z.array(Address).max(50).optional(),
  subject: HeaderText(998).describe('Subject line.'),
  body: z.string().max(BODY_CHARS).describe('Plain-text body.'),
  threadId: z.string().min(1).max(200).optional().describe('Gmail thread to reply in.'),
  inReplyTo: HeaderText(998).optional().describe('Message-ID header of the message being answered.'),
}).strict();

/** RFC 2047 for a non-ASCII header value; ASCII passes as-is. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** An RFC 2822 message, base64url as Gmail's `raw` wants it. The body is base64 so no line of it can be a header. */
export function rfc2822(input: z.infer<typeof Compose>): string {
  const lines = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(input.body, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const MessageId = z.string().min(1).max(200);

/** Which granted scope lets each tool work. */
const READ = ['https://www.googleapis.com/auth/gmail.readonly'];
const COMPOSE = ['https://www.googleapis.com/auth/gmail.compose'];

export const GMAIL_TOOLS: readonly GoogleTool[] = [
  tool({
    name: 'search_messages',
    scopes: READ,
    description: 'Search the mailbox with Gmail search syntax (for example "from:alice is:unread newer_than:7d"). Returns sender, subject, date and snippet for each match.',
    input: z.object({
      query: z.string().max(1000).optional().describe('Gmail search query. Omit for the most recent messages.'),
      maxResults: z.number().int().min(1).max(25).optional().describe('At most this many messages (default 10).'),
      pageToken: z.string().max(500).optional(),
      labelIds: z.array(z.string().min(1).max(200)).max(10).optional().describe('Only messages carrying every one of these labels.'),
    }).strict(),
    async run(api, input) {
      const listed = await api.json<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>('GET', api.endpoints.gmail, '/users/me/messages', {
        query: { q: input.query, maxResults: input.maxResults ?? 10, pageToken: input.pageToken, labelIds: input.labelIds },
      });
      const messages = await Promise.all((listed.messages ?? []).map(item => api.json<Message>('GET', api.endpoints.gmail, `/users/me/messages/${segment(item.id)}`, {
        query: { format: 'metadata', metadataHeaders: HEADERS.slice(0, 5) },
      })));
      return { messages: messages.map(summary), ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}) };
    },
  }),
  tool({
    name: 'get_message',
    scopes: READ,
    description: 'Read one message: headers, plain-text body and attachment names.',
    input: z.object({ id: MessageId.describe('Message id from search_messages.') }).strict(),
    async run(api, input) {
      return full(await api.json<Message>('GET', api.endpoints.gmail, `/users/me/messages/${segment(input.id)}`, { query: { format: 'full' } }));
    },
  }),
  tool({
    name: 'get_thread',
    scopes: READ,
    description: 'Read a whole conversation, oldest message first.',
    input: z.object({ id: MessageId.describe('Thread id (threadId from search_messages).') }).strict(),
    async run(api, input) {
      const thread = await api.json<{ id: string; messages?: Message[] }>('GET', api.endpoints.gmail, `/users/me/threads/${segment(input.id)}`, { query: { format: 'full' } });
      return { id: thread.id, messages: (thread.messages ?? []).map(full) };
    },
  }),
  tool({
    name: 'list_labels',
    scopes: READ,
    description: 'List the mailbox labels (system and user labels) with their ids.',
    input: z.object({}).strict(),
    async run(api) {
      const listed = await api.json<{ labels?: { id: string; name: string; type?: string }[] }>('GET', api.endpoints.gmail, '/users/me/labels');
      return { labels: (listed.labels ?? []).map(label => ({ id: label.id, name: label.name, type: label.type })) };
    },
  }),
  tool({
    name: 'create_draft',
    scopes: COMPOSE,
    description: 'Create a draft in the mailbox. Nothing is sent; the person reviews and sends it from Gmail.',
    input: Compose,
    async run(api, input) {
      const draft = await api.json<{ id: string; message?: { id: string; threadId?: string } }>('POST', api.endpoints.gmail, '/users/me/drafts', {
        body: { message: { raw: rfc2822(input), ...(input.threadId ? { threadId: input.threadId } : {}) } },
      });
      return { draftId: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId };
    },
  }),
  tool({
    name: 'send_message',
    scopes: COMPOSE,
    description: 'Send an email now, as the connected account. Only available when a Space admin has allowed sending for this connector.',
    gate: GMAIL_SEND_GATE,
    input: Compose,
    async run(api, input) {
      const sent = await api.json<{ id: string; threadId?: string }>('POST', api.endpoints.gmail, '/users/me/messages/send', {
        body: { raw: rfc2822(input), ...(input.threadId ? { threadId: input.threadId } : {}) },
      });
      return { messageId: sent.id, threadId: sent.threadId };
    },
  }),
];

