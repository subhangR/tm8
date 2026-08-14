import { describe, expect, it } from 'vitest';
import type { CatalogTransport } from '../src/catalog-client.js';
import { exposedToolNames, parseChatMode, toolPermission } from '../src/modes.js';
import { MCP_TOOL_NAMES, Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = { invoke: async () => ({ ok: true }) };

describe('chat mode policy', () => {
  it('defaults invalid or absent values to Ask', () => {
    expect(parseChatMode(undefined)).toBe('ask');
    expect(parseChatMode('not-a-mode')).toBe('ask');
  });

  it('keeps Ask mutation-free and Build edits real but bash approval-gated', () => {
    expect(toolPermission('ask', 'repo_read_file')).toBe('allow');
    expect(toolPermission('ask', 'repo_write')).toBe('deny');
    expect(toolPermission('ask', 'tm8_messages', 'messages.post')).toBe('deny');
    expect(toolPermission('build', 'repo_write')).toBe('allow');
    expect(toolPermission('build', 'repo_bash')).toBe('ask');
    expect(exposedToolNames('build', MCP_TOOL_NAMES)).not.toContain('repo_bash');
  });

  it('narrows hierarchical operations in Orchestrate', () => {
    expect(toolPermission('orchestrate', 'tm8_act', 'entities.commands.work')).toBe('allow');
    expect(toolPermission('orchestrate', 'tm8_act', 'entities.delete')).toBe('deny');
    expect(toolPermission('orchestrate', 'repo_read_file')).toBe('deny');
  });

  it('enforces mode at invocation even if a denied tool is called by name', async () => {
    const result = await new Tm8ToolRouter(transport, { mode: 'ask' }).call('repo_write', {
      path: 'x.txt', content: 'no',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'mode_denied' } },
    });
  });
});
