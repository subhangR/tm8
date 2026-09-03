/**
 * `tm8 chat start|list|show|send|turns` — the chat noun (spec §6, L2-cli).
 *
 * A chat became an ENTITY in migration 176. Before that it was a message
 * thread: a root `message` on the seeded default channel plus a `chat_threads`
 * binding row, which is why the CLI had no chat noun to offer — there was no
 * kind to list by, no id that meant "the conversation" rather than "the message
 * it started from", and no anchor a caller could address. All five of those
 * gaps close with one kind, so this file is small on purpose.
 *
 * ONE OPERATION IS NEW; FOUR COMMANDS ARE SUGAR. `chat start` projects
 * `chat.start`, the one door a chat is born from. `list`, `show`, `send` and
 * `turns` add ZERO catalog rows: they are `collections.query` with
 * `kinds: ['chat']`, `entities.context`, `messages.post`, and
 * `entities.get` + `messages.list` respectively — the same posture
 * `worktree list|status` took, and for the same reason. A `chats.list`
 * operation would have been a second way to ask a question the collection
 * query already answers, which is how a closed catalog stops being closed.
 *
 * WHY `chat send` EXISTS AT ALL, GIVEN `message send --to <chat-id>` WORKS.
 * It works because a chat anchors its own transcript, and that is exactly the
 * fact worth teaching. An agent that has learned `message send` for sessions
 * has to be told a chat is reachable the same way; a `chat send` that is
 * visibly one anchor's spelling of `message send` teaches it in the help
 * surface rather than in a note nobody reads. It forwards the caller's session
 * id like `message send` does, so a chat started FROM a work session records
 * `authored_from` and the chat's self-delivery guard stays keyed on the source.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no `chat stop`, no `chat mode`, no
 * `chat model`: every element of a chat's configuration is pinned for its life
 * (D3), and `runtime_state` is moved by the orchestrator, never by a caller.
 * There is also no `chat delete` — `tm8 entity delete` reaches the same door
 * with the Server's refusals intact, and a friendlier spelling that quietly
 * lost the version guard would be worse than none.
 */
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, contextQuery, requireArg, summaryLine } from './entity.js';
import {
  parseWait,
  postMessage,
  renderDelivery,
  renderMessagePage,
  resolveBody,
  uniqueInOrder,
} from './message.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * `ChatMode` and `ChatWorkdirMode`, spelled exactly as `StartChatInputSchema`
 * accepts them. Both are CLOSED, so a typo is caught here with the whole set
 * named — a caller who wrote `--mode coordinator` has the wrong vocabulary
 * (that is a SESSION mode), and telling them only that their value is wrong
 * leaves them guessing a second time.
 */
const CHAT_MODES = ['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'] as const;
type ChatModeOption = (typeof CHAT_MODES)[number];

const CHAT_WORKDIRS = ['project', 'scratch'] as const;
type ChatWorkdirOption = (typeof CHAT_WORKDIRS)[number];

function closed<T extends string>(
  flag: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    throw new CliError(
      `--${flag} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

/**
 * A flag the frozen input schema marks required has no CLI default.
 *
 * `StartChatInput` requires `teammateId`, `model`, `mode` and `workdirMode`,
 * and the Server applies no fallback for any of them. Inventing one here would
 * make `tm8 chat start` and the browser composer create differently-configured
 * chats from the same words, and the configuration is pinned for the chat's
 * life — an invented default is not a convenience, it is a chat nobody chose.
 */
function requireFlag(cmd: CommandContext, flag: string, placeholder: string, why: string): string {
  const value = cmd.options.value(flag);
  if (value === undefined || value === '') {
    throw new CliError(`\`tm8 chat start\` requires --${flag} ${placeholder}`, EXIT_USAGE, {
      hint: why,
    });
  }
  return value;
}

async function chatStart(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'teammate', 'model', 'mode', 'workdir', 'project', 'about', 'title',
    'body', 'attach', 'mutation-id',
  ]);

  const teammateId = requireFlag(
    cmd, 'teammate', '<team-member-id>',
    'a chat runs a Teammate persona; list them with `tm8 teammate` or `tm8 entity query --kind team_member`',
  );
  const model = requireFlag(
    cmd, 'model', '<model>',
    'chat v1 runs claude-code models only; the Server refuses any other agent tool at start rather than on turn one',
  );
  const mode = closed<ChatModeOption>('mode', requireFlag(
    cmd, 'mode', `${CHAT_MODES.join('|')}`,
    'the mode is pinned for the chat\'s life — it is not a per-turn choice',
  ), CHAT_MODES) as ChatModeOption;
  const workdirMode = closed<ChatWorkdirOption>('workdir', requireFlag(
    cmd, 'workdir', `${CHAT_WORKDIRS.join('|')}`,
    'where the chat works: `project` (a Space-linked ProjectResource) or `scratch` (a server-owned empty directory)',
  ), CHAT_WORKDIRS) as ChatWorkdirOption;

  // The pairing is refused HERE as well as in the schema and in SQL. A
  // mismatch that only the wire catches surfaces as a 400 with a zod message
  // in it, and the caller has to decode which of two flags was wrong.
  const projectId = cmd.options.value('project');
  if (workdirMode === 'project' && projectId === undefined) {
    throw new CliError('--workdir project requires --project <project-id>', EXIT_USAGE, {
      hint: 'the Server resolves the path from the project itself; a caller never names a directory',
    });
  }
  if (workdirMode === 'scratch' && projectId !== undefined) {
    throw new CliError('--project applies only to --workdir project', EXIT_USAGE, {
      hint: 'a scratch chat works in a server-owned empty directory that no caller chooses',
    });
  }

  const body = await resolveBody(cmd.args[0], cmd.options.value('body'), 'chat start');

  const request: Record<string, unknown> = {
    spaceId: requireSpace(cmd.ctx),
    teammateId,
    model,
    mode,
    workdirMode,
    body,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (projectId !== undefined) request.projectId = projectId;
  const title = cmd.options.value('title');
  if (title !== undefined) request.title = title;
  // `--about` writes the `about` edge. It replaces the anchor the composer used
  // to have to supply: a chat anchors its own transcript now, so the entity it
  // was opened ABOUT is a relation a human can see and correct.
  const aboutId = cmd.options.value('about');
  if (aboutId !== undefined) request.aboutId = aboutId;
  const attachmentIds = uniqueInOrder(cmd.options.values('attach'));
  if (attachmentIds.length > 0) request.attachmentIds = attachmentIds;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'chat.start', { body: request });
  cmd.out.data(data, renderStarted);
  return EXIT_OK;
}

function renderStarted(dto: unknown): string {
  const result = (dto ?? {}) as { chat?: Record<string, unknown>; messageId?: unknown };
  const line = summaryLine(result.chat as Parameters<typeof summaryLine>[0]);
  return [
    line === '' ? 'chat started' : line,
    // The opening message is named because it is already queued as turn one:
    // `tm8 message delivery <message-id>` is how a caller watches that turn,
    // and a result that printed only the chat id would hide the id that read
    // needs.
    `opening message: ${String(result.messageId ?? '(unknown)')}`,
  ].join('\n');
}

async function chatList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('chat list', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);

  const body: Record<string, unknown> = {
    spaceId: requireSpace(cmd.ctx),
    kinds: ['chat'],
  };
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) body.limit = limit;
  const cursor = cmd.options.value('cursor');
  if (cursor !== undefined) body.cursor = cursor;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.query', { body });
  cmd.out.data(data, renderChats);
  return EXIT_OK;
}

/**
 * `collections.query` projects a chat's `state`, which carries both runtime
 * axes. They are DIFFERENT facts and both are printed: `runtimeState` is
 * whether a process is up, `turnState` is whether work is outstanding. A cold
 * chat with a queued turn is exactly "the node restarted, your message is still
 * coming", and folding either into the other would erase that.
 */
interface ChatFacts {
  runtimeState?: unknown;
  turnState?: unknown;
  turnCount?: unknown;
  lastTurnAt?: unknown;
  mode?: unknown;
  model?: unknown;
  workdirMode?: unknown;
  teammateId?: unknown;
}

function factsOf(row: Record<string, unknown>): ChatFacts {
  return { ...((row.state ?? {}) as ChatFacts), ...((row.content ?? {}) as ChatFacts) };
}

function chatLine(row: Record<string, unknown>): string {
  const f = factsOf(row);
  const turns = f.turnCount === undefined ? '' : `  ${String(f.turnCount)} turns`;
  return [
    summaryLine(row as Parameters<typeof summaryLine>[0]),
    `  ${String(f.runtimeState ?? '?')}/${String(f.turnState ?? '?')}${turns}`,
  ].join('');
}

function renderChats(dto: unknown): string {
  const result = (dto ?? {}) as { page?: { items?: Array<Record<string, unknown>> } };
  const items = result.page?.items ?? [];
  if (items.length === 0) return 'no chats';
  return items.map(chatLine).join('\n');
}

async function chatShow(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('chat show', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['sections', 'total-bytes', 'section-bytes']);
  const id = requireArg(cmd, 0, '<chat-id>');

  // `entities.context`, not `entities.get`: a chat's whole point is its
  // transcript, and context is the bounded read that carries recent messages
  // and the `about` relation beside the configuration. The unbounded read is
  // still `tm8 entity get <chat-id>` for a caller who wants every field.
  //
  // The query is built by `entity context`'s OWN builder, so the two spellings
  // of this read validate `--sections` and the byte budgets identically.
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.context', {
    params: { id },
    query: contextQuery(cmd),
  });
  cmd.out.data(data, renderContext);
  return EXIT_OK;
}

function renderContext(dto: unknown): string {
  const ctx = (dto ?? {}) as { root?: Record<string, unknown> };
  const root = ctx.root ?? {};
  const f = factsOf(root);
  return [
    summaryLine(root as Parameters<typeof summaryLine>[0]),
    `runtime: ${String(f.runtimeState ?? '?')}   turn: ${String(f.turnState ?? '?')}`,
    `mode: ${String(f.mode ?? '?')}   model: ${String(f.model ?? '?')}   workdir: ${String(f.workdirMode ?? '?')}`,
  ].join('\n');
}

async function chatSend(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['body', 'reply-to', 'mention', 'attach', 'wait', 'mutation-id']);
  const chatId = requireArg(cmd, 0, '<chat-id>');
  const wait = parseWait(cmd.options.value('wait'));
  const body = await resolveBody(cmd.args[1], cmd.options.value('body'), 'chat send');

  const request: Record<string, unknown> = {
    anchorIds: [chatId],
    body,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const mentionIds = uniqueInOrder(cmd.options.values('mention'));
  const attachmentIds = uniqueInOrder(cmd.options.values('attach'));
  if (mentionIds.length > 0) request.mentionIds = mentionIds;
  if (attachmentIds.length > 0) request.attachmentIds = attachmentIds;
  const replyTo = cmd.options.value('reply-to');
  if (replyTo) request.parentMessageId = replyTo;
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;
  // Forwarded exactly as `message send` forwards it. It is what makes the
  // message `authored_from` this session, and it is what the chat's
  // self-delivery guard is keyed on — a chat is never handed its own message.
  if (cmd.ctx.sessionId) request.workSessionId = cmd.ctx.sessionId;

  return postMessage(cmd, request, wait);
}

/**
 * `tm8 chat turns <chat-id>` — what this chat is doing, and the turns it has.
 *
 * TWO READS, BECAUSE THE ANSWER LIVES IN TWO PLACES AND NEITHER IS THE OTHER.
 * The chat entity's own state carries the FOLDED verdict (`turnState` is
 * idle/queued/running, plus a count and a stamp); the per-turn rows are
 * reachable only through the message that queued them, as
 * `messages.delivery.get`'s `chatTurns` arm. So the default is the folded
 * verdict beside the recent turn messages, and `--message <message-id>`
 * narrows to the exact `chat_turns` row a given message created, with its own
 * state — queued, running, completed or error.
 *
 * WHY THE PER-TURN STATE IS NOT LISTED FOR EVERY MESSAGE. That would be one
 * `messages.delivery.get` per message: an N+1 this command would perform
 * silently on every invocation, to answer a question most callers are not
 * asking. The drilldown is a flag so the cost is the caller's choice.
 */
async function chatTurns(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('chat turns', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['message', 'limit', 'cursor']);

  const messageId = cmd.options.value('message');
  if (messageId !== undefined) {
    if (cmd.args[0] !== undefined) {
      throw new CliError(
        '`tm8 chat turns --message <message-id>` takes no <chat-id>',
        EXIT_USAGE,
        { hint: 'a message names the chat it queued a turn on; supplying both could disagree' },
      );
    }
    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.delivery.get', {
      params: { messageId },
    });
    cmd.out.data(data, renderTurnRows);
    return EXIT_OK;
  }

  const chatId = requireArg(cmd, 0, '<chat-id>');
  const chat = await observedInvoke<Record<string, unknown>>(
    clientFor(cmd.ctx), 'entities.get', { params: { id: chatId } },
  );
  const limit = cmd.options.integer('limit');
  const page = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.list', {
    params: { anchorId: chatId },
    query: {
      order: 'newest',
      ...(limit === undefined ? {} : { limit: String(limit) }),
      ...(cmd.options.value('cursor') === undefined
        ? {}
        : { cursor: cmd.options.value('cursor') as string }),
    },
  });

  cmd.out.data({ chat, messages: page }, (dto) => {
    const both = (dto ?? {}) as { chat?: Record<string, unknown>; messages?: unknown };
    const f = factsOf(both.chat ?? {});
    return [
      `turn state: ${String(f.turnState ?? '?')}   runtime: ${String(f.runtimeState ?? '?')}`,
      `${String(f.turnCount ?? 0)} turns, last ${String(f.lastTurnAt ?? '(never)')}`,
      '',
      renderMessagePage(both.messages),
    ].join('\n');
  });
  return EXIT_OK;
}

/**
 * The `chatTurns` arm is OPTIONAL on the wire, and its absence means "this node
 * cannot tell you", never "this message woke no chat" — a node that predates
 * 176 omits the key entirely. Saying which of the two it is, is the whole
 * reason this renderer exists rather than printing an empty list.
 */
function renderTurnRows(dto: unknown): string {
  const view = (dto ?? {}) as {
    chatTurns?: Array<{ chatId?: unknown; turnId?: unknown; state?: unknown }>;
  };
  const head = renderDelivery(dto);
  if (view.chatTurns === undefined) {
    return `${head}\nchat turns: this node did not report them (it predates the chat entity)`;
  }
  if (view.chatTurns.length === 0) return `${head}\nchat turns: none — this message queued no turn`;
  return [
    head,
    ...view.chatTurns.map(
      (t) => `chat turn ${String(t.turnId)}  ${String(t.state)}  on ${String(t.chatId)}`,
    ),
  ].join('\n');
}

export const CHAT_COMMANDS: CommandModule[] = [
  { path: ['chat', 'start'], run: chatStart },
  { path: ['chat', 'list'], run: chatList },
  { path: ['chat', 'show'], run: chatShow },
  { path: ['chat', 'send'], run: chatSend },
  { path: ['chat', 'turns'], run: chatTurns },
];
