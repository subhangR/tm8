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

describe('hierarchical tool curation', () => {
  it('publishes exactly the five ruled top-level tools', () => {
    expect(TM8_MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(MCP_TOOL_NAMES).toEqual([
      'tm8_overview',
      'tm8_read',
      'tm8_act',
      'tm8_delegate',
      'tm8_messages',
    ]);
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
    await new Tm8ToolRouter(transport).call('tm8_messages', {
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
    const result = await new Tm8ToolRouter(transport).call('tm8_act', {
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
    const result = await new Tm8ToolRouter(transport).call('tm8_overview', { query: 'delegate work' });
    const matches = result.structuredContent.matches as Array<{ operation: string }>;

    expect(matches.some((match) => match.operation === 'execution.dispatch')).toBe(true);
    expect(matches.some((match) => match.operation.startsWith('credentials.'))).toBe(false);
    expect(transport.calls).toEqual([]);
  });
});
