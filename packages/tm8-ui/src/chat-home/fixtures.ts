import type { ActorSummary, EntityId } from '@tm8/contract';
import type {
  ChatHomePort,
  ChatConfigureInput,
  ChatPostInput,
  ChatRootInput,
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

export const CHAT_HOME_FIXTURE_THREAD: ChatThreadDetail = {
  summary: {
    rootId: ROOT_ID,
    title: 'Plan the launch sequence',
    preview: 'I mapped the work into three dependency-safe lanes.',
    updatedAt: '2026-08-13T08:20:00.000Z',
    replyCount: 3,
    config: {
      teammateId: AGENT.id as EntityId,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'Sonnet 4.5',
      provider: 'Anthropic',
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
    },
    {
      messageId: '019f0000-0000-7000-8000-000000000012' as EntityId,
      role: 'assistant',
      author: AGENT,
      createdAt: '2026-08-13T08:20:00.000Z',
      body: '',
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
          content: { tasks: 7, blocked: 1 },
        },
        {
          seq: 3,
          kind: 'tool_call',
          toolCallId: 'tool-1',
          name: 'tm8_read',
          args: { view: 'task_tree' },
          state: 'completed',
        },
        {
          seq: 4,
          kind: 'text',
          text: 'I mapped the work into three dependency-safe lanes. The storage lane is the only current blocker.',
        },
        {
          seq: 5,
          kind: 'usage',
          usage: {
            input_tokens: 842,
            output_tokens: 176,
            total_cost_usd: 0.0073,
            model: 'claude-sonnet-4-5',
            provider: 'Anthropic',
          },
        },
        { seq: 6, kind: 'done' },
      ],
    },
  ],
};

export interface ChatHomeFixtureControls {
  roots: ChatRootInput[];
  configs: ChatConfigureInput[];
  posts: ChatPostInput[];
  emit(frame: ChatTurnFrame): void;
}

export function createChatHomeFixturePort(
  initial: readonly ChatThreadDetail[] = [CHAT_HOME_FIXTURE_THREAD],
): { port: ChatHomePort; controls: ChatHomeFixtureControls } {
  const details = new Map(initial.map((thread) => [thread.summary.rootId, structuredClone(thread)]));
  const listeners = new Set<(frame: ChatTurnFrame) => void>();
  const roots: ChatRootInput[] = [];
  const configs: ChatConfigureInput[] = [];
  const posts: ChatPostInput[] = [];
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
      async createRoot(input) {
        roots.push(input);
        serial += 1;
        const rootId = `019f0000-0000-7000-8000-${String(serial).padStart(12, '0')}` as EntityId;
        details.set(rootId, {
          summary: {
            rootId,
            title: input.body,
            preview: input.body,
            updatedAt: new Date().toISOString(),
            replyCount: 1,
            config: {
              teammateId: AGENT.id as EntityId,
              teammateLabel: 'Pending configuration',
              model: '',
              modelLabel: 'Pending configuration',
              provider: '',
            },
            state: 'idle',
          },
          turns: [
            {
              messageId: rootId,
              role: 'user',
              author: HUMAN,
              createdAt: new Date().toISOString(),
              body: input.body,
              parts: [],
            },
          ],
        });
        return { threadRootId: rootId };
      },
      async configure(input) {
        configs.push(input);
        const detail = details.get(input.rootMessageId);
        if (!detail) throw new Error(`Fixture thread ${input.rootMessageId} does not exist.`);
        detail.summary = {
          ...detail.summary,
          config: {
            teammateId: input.teammateId,
            teammateLabel: input.teammateId === AGENT.id ? 'Forge' : 'Researcher',
            model: input.model,
            modelLabel: input.model,
            provider: input.model.startsWith('claude') ? 'Anthropic' : 'OpenAI',
          },
          state: 'streaming',
        };
        return {
          threadRootId: input.rootMessageId,
          teammateId: input.teammateId,
          model: input.model,
        };
      },
    },
    async postTurn(input) {
      posts.push(input);
      const detail = details.get(input.threadRootId);
      if (!detail) throw new Error(`Fixture thread ${input.threadRootId} does not exist.`);
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
    async interrupt() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    port,
    controls: {
      roots,
      configs,
      posts,
      emit(frame) {
        for (const listener of listeners) listener(frame);
      },
    },
  };
}
