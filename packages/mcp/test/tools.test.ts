import { describe, expect, it } from 'vitest';
import { getOperation, OPERATIONS, type OperationName } from '@tm8/contract';
import type { CatalogInvokeOptions, CatalogTransport } from '../src/catalog-client.js';
import {
  MCP_MAPPED_OPERATIONS,
  MCP_TOOL_NAMES,
  TM8_MCP_TOOLS,
  Tm8ToolRouter,
} from '../src/tools.js';

class RecordingTransport implements CatalogTransport {
  readonly calls: Array<{ operation: OperationName; options: CatalogInvokeOptions }> = [];
  result: unknown = { ok: true };

  async invoke(operation: OperationName, options: CatalogInvokeOptions = {}): Promise<unknown> {
    this.calls.push({ operation, options });
    return this.result;
  }
}

describe('tool curation', () => {
  it('publishes the five graph groups and the full direct surface', () => {
    expect(TM8_MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(MCP_TOOL_NAMES.slice(0, 5)).toEqual([
      'tm8_overview',
      'tm8_read',
      'tm8_act',
      'tm8_delegate',
      'tm8_messages',
    ]);
    expect(MCP_TOOL_NAMES).toContain('repo_read_file');
    expect(MCP_TOOL_NAMES).toContain('session_transcript');
    expect(MCP_TOOL_NAMES).toContain('doc_create');
    expect(MCP_TOOL_NAMES).toContain('web_search');
    expect(MCP_TOOL_NAMES).toContain('memory_search');
    expect(MCP_TOOL_NAMES).toContain('git_diff');
    expect(MCP_TOOL_NAMES).toContain('repo_multi_edit');
  });

  it('maps every next-level operation to the closed catalog without adding a row', () => {
    const catalogNames = new Set(OPERATIONS.map((operation) => operation.name));
    for (const operation of MCP_MAPPED_OPERATIONS) {
      expect(catalogNames.has(operation), operation).toBe(true);
      expect(getOperation(operation).name).toBe(operation);
    }
    expect(OPERATIONS.some((operation) => operation.name.startsWith('mcp.'))).toBe(false);
  });

  it('has no credential or authentication operation in any group', () => {
    expect(
      MCP_MAPPED_OPERATIONS.filter(
        (operation) => operation.startsWith('credentials.') || operation.startsWith('auth.'),
      ),
    ).toEqual([]);
  });

  it('opens one group directory without making a server call', async () => {
    const transport = new RecordingTransport();
    const result = await new Tm8ToolRouter(transport).call('tm8_read', {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.schemaVersion).toBe('tm8.mcp.directory.v1');
    expect(result.structuredContent.tool).toBe('tm8_read');
    expect(transport.calls).toEqual([]);
  });

  it('dispatches a selected read with catalog params and repeated queries', async () => {
    const transport = new RecordingTransport();
    const result = await new Tm8ToolRouter(transport).call('tm8_read', {
      operation: 'entities.context',
      params: { id: '019fa297-64e3-7000-8000-000000000001' },
      query: { sections: 'summary,actions', tag: ['one', 'two'] },
    });

    expect(result.isError).toBeUndefined();
    expect(transport.calls).toEqual([
      {
        operation: 'entities.context',
        options: {
          params: { id: '019fa297-64e3-7000-8000-000000000001' },
          query: { sections: 'summary,actions', tag: ['one', 'two'] },
        },
      },
    ]);
  });

  it('mints a mutation id for operations whose frozen body requires one', async () => {
    const transport = new RecordingTransport();
    await new Tm8ToolRouter(transport, { mode: 'build' }).call('tm8_messages', {
      operation: 'messages.post',
      body: {
        anchorIds: ['019fa297-64e3-7000-8000-000000000001'],
        body: 'hello',
      },
    });

    const body = transport.calls[0]?.options.body as Record<string, unknown>;
    expect(body.anchorIds).toEqual(['019fa297-64e3-7000-8000-000000000001']);
    expect(body.body).toBe('hello');
    expect(body.clientMutationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an operation outside the selected group before transport', async () => {
    const transport = new RecordingTransport();
    const result = await new Tm8ToolRouter(transport, { mode: 'build' }).call('tm8_act', {
      operation: 'credentials.status',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      schemaVersion: 'tm8.mcp.error.v1',
      error: {
        code: 'invalid_input',
        message: 'credentials.status is not available through tm8_act; call tm8_act with {} for its directory',
        retryable: false,
      },
    });
    expect(transport.calls).toEqual([]);
  });

  it('searches the local hierarchy without exposing credential operations', async () => {
    const transport = new RecordingTransport();
    const result = await new Tm8ToolRouter(transport, { mode: 'orchestrate' }).call('tm8_overview', { query: 'delegate work' });
    const matches = result.structuredContent.matches as Array<{ operation: string }>;

    expect(matches.some((match) => match.operation === 'execution.dispatch')).toBe(true);
    expect(matches.some((match) => match.operation.startsWith('credentials.'))).toBe(false);
    expect(transport.calls).toEqual([]);
  });
});

/**
 * 176/Wave 2 — the tool surface tells a chat its own address.
 *
 * A guide is the only thing a model reads before its first call, so a template
 * value is not decoration: whatever the guide shows is what gets sent. Two of
 * those values were actively wrong for a chat, in the same way — they described
 * a world where only work sessions had ids:
 *
 *   `mode: 'worker'`   — spawns a worker with NO coordinator, so its report is
 *                        lost when it exits. `resolveCoordinatorSessionId`
 *                        returns null for every mode but the coordinated pair.
 *   `<anchor-id>`      — reads as "some entity", and a model that reads it that
 *                        way posts its report onto a task, where nothing wakes.
 */
describe('chat addressing in the tool surface', () => {
  async function directory(tool: string): Promise<Array<{
    operation: string;
    summary: string;
    request: { params?: Record<string, string>; body?: Record<string, unknown> };
  }>> {
    const result = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call(tool, {});
    return result.structuredContent.operations as never;
  }

  it("spawns coordinated by default, so a worker's report comes back", async () => {
    const spawn = (await directory('tm8_delegate')).find((item) => item.operation === 'execution.spawn');
    // THE TEMPLATE VALUE, not merely a mention of the mode in prose.
    expect(spawn?.request.body?.mode).toBe('coordinated-worker');
    expect(spawn?.summary).toContain('reports back');
    // And it says to leave the parent alone, because the server fills it from
    // the bearer's own session row — an id the model does not have and must not
    // guess.
    expect(spawn?.summary).toContain('parentSessionId');
    expect(spawn?.request.body).not.toHaveProperty('parentSessionId');
  });

  it('shows a chat id as an anchor everywhere a session id is one', async () => {
    const messages = await directory('tm8_messages');
    const post = messages.find((item) => item.operation === 'messages.post');
    const list = messages.find((item) => item.operation === 'messages.list');
    for (const guide of [post, list]) {
      expect(guide).toBeDefined();
      const template = JSON.stringify(guide!.request);
      expect(template).toContain('work-session');
      expect(template).toContain('chat id');
    }
    expect(post?.summary).toContain("a chat's id to reach that chat");
    // The failure mode named, not just the success: anchoring on a task stores
    // and wakes nothing, which is the defect this whole wave exists to close.
    expect(post?.summary).toContain('anchoring on a task or a document only stores the message');
  });

  it('names the running chat in the overview, and omits it when unset', async () => {
    const CHAT = '019fa297-64e3-7000-8000-0000000000c1';
    const withChat = await new Tm8ToolRouter(new RecordingTransport(), {
      mode: 'build', chatId: CHAT,
    }).call('tm8_overview', {});
    const chat = withChat.structuredContent.chat as { id: string; address: string; delegation: string };
    expect(chat.id).toBe(CHAT);
    expect(chat.address).toContain('anchoring a message on this id');
    expect(chat.delegation).toContain("coordinated-worker'");
    // The credential's binding is stated as a fact about the TOKEN. Saying so
    // is honest — the server enforces it (B10) — and a page that claimed it
    // without the server enforcing it would be worse than silence.
    expect((withChat.structuredContent.security as { boundChatId?: string }).boundChatId).toBe(CHAT);

    // An older per-chat config file has no TM8_CHAT_ID. The surface must then
    // say NOTHING rather than invent a value from the cwd or the filename —
    // both of which carried a root message id before 176 and were wrong.
    const without = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call('tm8_overview', {});
    expect(without.structuredContent).not.toHaveProperty('chat');
    expect(without.structuredContent.security).not.toHaveProperty('boundChatId');
    // A blank or whitespace variable is the same as unset, not an empty id.
    const blank = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build', chatId: '  ' }).call('tm8_overview', {});
    expect(blank.structuredContent).not.toHaveProperty('chat');
  });

  it('tells the delegate and messages groups apart by what each reaches', async () => {
    const result = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call('tm8_overview', {});
    const groups = result.structuredContent.groups as Array<{ tool: string; purpose: string }>;
    const purpose = (tool: string) => groups.find((group) => group.tool === tool)?.purpose ?? '';
    expect(purpose('tm8_delegate')).toContain('coordinated-worker');
    expect(purpose('tm8_messages')).toContain('chat');
  });
});
