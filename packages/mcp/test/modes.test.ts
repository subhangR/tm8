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
    expect(exposedToolNames('ask', MCP_TOOL_NAMES)).toEqual([
      'tm8_read', 'repo_read_file', 'repo_glob', 'repo_grep', 'session_transcript',
    ]);
    expect(toolPermission('ask', 'repo_read_file')).toBe('allow');
    expect(toolPermission('ask', 'tm8_read')).toBe('allow');
    expect(toolPermission('ask', 'session_transcript')).toBe('allow');
    expect(toolPermission('ask', 'tm8_overview')).toBe('deny');
    expect(toolPermission('ask', 'session_tail')).toBe('deny');
    expect(toolPermission('ask', 'web_search')).toBe('deny');
    expect(toolPermission('ask', 'git_diff')).toBe('deny');
    expect(toolPermission('ask', 'repo_write')).toBe('deny');
    expect(toolPermission('ask', 'tm8_messages', 'messages.post')).toBe('deny');
    expect(toolPermission('build', 'repo_write')).toBe('allow');
    expect(toolPermission('build', 'repo_bash')).toBe('ask');
    expect(exposedToolNames('build', MCP_TOOL_NAMES)).not.toContain('repo_bash');
  });

  it('keeps Explain focused on reads and explanatory artifacts', () => {
    expect(exposedToolNames('explain', MCP_TOOL_NAMES)).toEqual([
      'tm8_read', 'repo_read_file', 'repo_glob', 'repo_grep',
      'session_transcript',
      'explain_diagram', 'explain_graph', 'explain_code', 'explain_asset',
      'doc_create', 'doc_update', 'artifact_create',
    ]);
    expect(toolPermission('explain', 'tm8_read')).toBe('allow');
    expect(toolPermission('explain', 'repo_grep')).toBe('allow');
    expect(toolPermission('explain', 'session_transcript')).toBe('allow');
    expect(toolPermission('explain', 'explain_diagram')).toBe('allow');
    expect(toolPermission('explain', 'explain_graph')).toBe('allow');
    expect(toolPermission('explain', 'explain_code')).toBe('allow');
    expect(toolPermission('explain', 'explain_asset')).toBe('allow');
    expect(toolPermission('explain', 'doc_create')).toBe('allow');
    expect(toolPermission('explain', 'doc_update')).toBe('allow');
    expect(toolPermission('explain', 'artifact_create')).toBe('allow');
    expect(toolPermission('explain', 'repo_edit')).toBe('deny');
    expect(toolPermission('explain', 'web_search')).toBe('deny');
    expect(toolPermission('explain', 'tm8_messages', 'messages.post')).toBe('deny');
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

  it('omits provider-native replacements from registration and invocation', async () => {
    const router = new Tm8ToolRouter(transport, {
      mode: 'build', hiddenTools: ['repo_read_file', 'repo_edit', 'web_fetch'],
    });
    expect(router.listedTools().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['repo_read_file', 'repo_edit', 'web_fetch']),
    );
    await expect(router.call('repo_edit', {
      path: 'x', oldText: 'a', newText: 'b',
    })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'invalid_input' } },
    });
  });
});
