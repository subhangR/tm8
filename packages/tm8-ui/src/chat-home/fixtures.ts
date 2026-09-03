import type { ActorSummary, EntityId } from '@tm8/contract';
import { mergeChatTurnFrame } from './turn-model';
import type {
  ChatHomePort,
  ChatPostInput,
  ChatCreateInput,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnFrame,
} from './types';

const HUMAN: ActorSummary = {
  id: '019f0000-0000-7000-8000-000000000001',
  kind: 'member',
  displayName: 'You',
  avatar: null,
  isAgent: false,
};

const AGENT: ActorSummary = {
  id: '019f0000-0000-7000-8000-000000000002',
  kind: 'team_member',
  displayName: 'Forge',
  avatar: null,
  isAgent: true,
};

const ROOT_ID = '019f0000-0000-7000-8000-000000000010' as EntityId;
/** The fixture channel every fixture thread hangs off — bare Home's anchor. */
const ANCHOR_ID = '019f0000-0000-7000-8000-000000000001' as EntityId;

export const CHAT_HOME_FIXTURE_THREAD: ChatThreadDetail = {
  summary: {
    rootId: ROOT_ID,
    anchorId: ANCHOR_ID,
    title: 'Plan the launch sequence',
    preview: 'I mapped the work into three dependency-safe lanes.',
    updatedAt: '2026-08-13T08:20:00.000Z',
    replyCount: 3,
    config: {
      teammateId: AGENT.id as EntityId,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'Sonnet 4.5',
      mode: 'plan',
    },
    state: 'idle',
  },
  turns: [
    {
      messageId: '019f0000-0000-7000-8000-000000000011' as EntityId,
      role: 'user',
      author: HUMAN,
      createdAt: '2026-08-13T08:19:00.000Z',
      body: 'Plan the launch sequence and check what is already blocked.',
      parts: [],
      /* The reporter's own gesture, in the fixture: a human turn that is a
         pasted screenshot plus a line of text, and a second file that is not
         an image. A fixture with no attached file could not have caught the
         transcript dropping them — it rendered "correctly" precisely because
         there was nothing to drop. */
      attachments: [
        {
          fileEntityId: '019f0000-0000-7000-8000-000000000041' as EntityId,
          name: 'launch-board.png',
          mime: 'image/png',
        },
        {
          fileEntityId: '019f0000-0000-7000-8000-000000000042' as EntityId,
          name: 'launch-plan.pdf',
          mime: 'application/pdf',
        },
      ],
    },
    {
      messageId: '019f0000-0000-7000-8000-000000000012' as EntityId,
      role: 'assistant',
      author: AGENT,
      createdAt: '2026-08-13T08:20:00.000Z',
      // What the server actually stores once the turn completes: the answer
      // text, written onto the message body as the durable projection of the
      // parts below. Modelling this as `''` hid the fact that the transcript
      // was rendering both.
      body: 'I mapped the work into three dependency-safe lanes. The storage lane is the only current blocker.',
      parts: [
        { seq: 0, kind: 'thinking', text: 'I need the task tree and current blockers.' },
        {
          seq: 1,
          kind: 'tool_call',
          toolCallId: 'tool-1',
          name: 'tm8_read',
          args: { view: 'task_tree' },
          state: 'running',
        },
        {
          seq: 2,
          kind: 'tool_result',
          toolCallId: 'tool-1',
          content: {
            tasks: 7,
            blocked: 1,
            // A tm8_* tool result carrying real graph entities: one with the
            // full id/kind/title shape and one bare id a chip resolves lazily.
            items: [
              {
                id: '019f0000-0000-7000-8000-000000000021',
                kind: 'task',
                title: 'Unblock the storage lane',
              },
            ],
            blockerId: '019f0000-0000-7000-8000-000000000022',
          },
        },
        {
          seq: 3,
          kind: 'tool_call',
          toolCallId: 'tool-1',
          name: 'tm8_read',
          args: { view: 'task_tree' },
          state: 'completed',
        },
        /* A delegation — the most consequential write a chat performs, and
           what makes the ledger's sticky panel (sessions scope) and the
           `Session Created` line real on the demo thread. The session id is
           the entity fixtures' live session, so a host-level test can follow
           the row all the way into the terminal. */
        {
          seq: 4,
          kind: 'tool_call',
          toolCallId: 'tool-2',
          name: 'mcp__tm8__tm8_delegate',
          args: { operation: 'execution.spawn', body: {} },
          state: 'completed',
        },
        {
          seq: 5,
          kind: 'tool_result',
          toolCallId: 'tool-2',
          content: { entity: { id: '019f0000-0000-7000-8000-000000000031', kind: 'work_session', title: 'forge · tm8-ui kit' } },
        },
        {
          seq: 6,
          kind: 'text',
          text: 'I mapped the work into three dependency-safe lanes. The storage lane is the only current blocker.',
        },
        {
          seq: 7,
          kind: 'usage',
          usage: {
            input_tokens: 842,
            output_tokens: 176,
            total_cost_usd: 0.0073,
            model: 'claude-sonnet-4-5',
            provider: 'Anthropic',
          },
        },
        { seq: 8, kind: 'done' },
      ],
    },
  ],
};

export interface ChatHomeFixtureControls {
  /** Every `chat.start` this fixture served, in order. */
  roots: ChatCreateInput[];
  posts: ChatPostInput[];
  interrupts: EntityId[];
  emit(frame: ChatTurnFrame): void;
}

export function createChatHomeFixturePort(
  initial: readonly ChatThreadDetail[] = [CHAT_HOME_FIXTURE_THREAD],
): { port: ChatHomePort; controls: ChatHomeFixtureControls } {
  const details = new Map(initial.map((thread) => [thread.summary.rootId, structuredClone(thread)]));
  const listeners = new Set<(frame: ChatTurnFrame) => void>();
  const roots: ChatCreateInput[] = [];
  const posts: ChatPostInput[] = [];
  const interrupts: EntityId[] = [];
  let serial = 100;

  const summaries = (): ChatThreadSummary[] =>
    [...details.values()]
      .map((thread) => thread.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const port: ChatHomePort = {
    async listThreads() {
      return summaries();
    },
    async readThread(rootId) {
      const detail = details.get(rootId);
      if (!detail) throw new Error(`Fixture thread ${rootId} does not exist.`);
      return structuredClone(detail);
    },
    async listTeammates() {
      return [
        { id: AGENT.id as EntityId, label: 'Forge', avatar: null },
        {
          id: '019f0000-0000-7000-8000-000000000003' as EntityId,
          label: 'Researcher',
          avatar: null,
        },
      ];
    },
    startThread: {
      unavailableReason: null,
      // ONE CALL (176): the chat and its opening turn are created together, so
      // the fixture no longer models a message that is not yet a chat.
      async create(input) {
        roots.push(input);
        serial += 1;
        const chatId = `019f0000-0000-7000-8000-${String(serial).padStart(12, '0')}` as EntityId;
        details.set(chatId, {
          summary: {
            rootId: chatId,
            anchorId: (input.aboutId ?? chatId) as EntityId,
            title: input.body,
            preview: input.body,
            updatedAt: new Date().toISOString(),
            replyCount: 1,
            config: {
              teammateId: input.teammateId,
              teammateLabel: input.teammateId === AGENT.id ? 'Forge' : 'Researcher',
              model: input.model,
              modelLabel: input.model,
              mode: input.mode,
            },
            state: 'streaming',
          },
          turns: [
            {
              messageId: chatId,
              role: 'user',
              author: HUMAN,
              createdAt: new Date().toISOString(),
              body: input.body,
              parts: [],
            },
          ],
        });
        return {
          chatId,
          teammateId: input.teammateId,
          model: input.model,
          mode: input.mode,
        };
      },
    },
    async postTurn(input) {
      posts.push(input);
      const detail = details.get(input.chatId);
      if (!detail) throw new Error(`Fixture chat ${input.chatId} does not exist.`);
      serial += 1;
      const messageId = `019f0000-0000-7000-8001-${String(serial).padStart(12, '0')}` as EntityId;
      detail.turns.push({
        messageId,
        role: 'user',
        author: HUMAN,
        createdAt: new Date().toISOString(),
        body: input.body,
        parts: [],
      });
      detail.summary = {
        ...detail.summary,
        title: detail.summary.replyCount === 0 ? input.body : detail.summary.title,
        preview: input.body,
        replyCount: detail.summary.replyCount + 1,
        updatedAt: new Date().toISOString(),
        state: 'streaming',
      };
      return { messageId };
    },
    async interrupt(chatId) {
      interrupts.push(chatId);
      const detail = details.get(chatId);
      if (!detail) throw new Error(`Fixture chat ${chatId} does not exist.`);
      serial += 1;
      const messageId = `019f0000-0000-7000-8002-${String(serial).padStart(12, '0')}` as EntityId;
      detail.turns.push({
        messageId,
        role: 'assistant',
        author: AGENT,
        createdAt: new Date().toISOString(),
        body: '',
        parts: [
          {
            seq: 0,
            kind: 'tool_call',
            toolCallId: 'tool-interrupted',
            name: 'tm8_read',
            args: { view: 'current_context' },
            state: 'running',
          },
          { seq: 1, kind: 'text', text: 'I found the current context before the turn was stopped.' },
          {
            seq: 2,
            kind: 'tool_call',
            toolCallId: 'tool-interrupted',
            name: 'tm8_read',
            args: { view: 'current_context' },
            state: 'error',
          },
          {
            seq: 3,
            kind: 'usage',
            usage: {
              input_tokens: 214,
              output_tokens: 31,
              total_cost_usd: 0.0012,
              model: detail.summary.config.model,
            },
          },
          {
            seq: 4,
            kind: 'tool_result',
            toolCallId: 'tool-interrupted',
            content: { error: 'Interrupted by user' },
            isError: true,
          },
          { seq: 5, kind: 'done' },
        ],
      });
      detail.summary = {
        ...detail.summary,
        preview: 'Turn stopped. This thread can continue.',
        updatedAt: new Date().toISOString(),
        state: 'stopped-continuable',
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    port,
    controls: {
      roots,
      posts,
      interrupts,
      emit(frame) {
        // Server truth: every part is appended durably BEFORE its frame
        // publishes, so a snapshot read always contains what earlier frames
        // carried. The fixture must model that or replay-pruning cannot be
        // exercised honestly.
        const stored = details.get(frame.chatId);
        if (stored) details.set(frame.chatId, mergeChatTurnFrame(stored, frame));
        for (const listener of listeners) listener(frame);
      },
    },
  };
}
