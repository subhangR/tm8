import { describe, expect, it } from 'vitest';
import type { CatalogTransport } from '../src/catalog-client.js';
import { CHAT_MODES, exposedToolNames, parseChatMode, toolPermission } from '../src/modes.js';
import { MCP_TOOL_NAMES, Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = { invoke: async () => ({ ok: true }) };

describe('chat mode policy', () => {
  it('defaults invalid or absent values to Ask', () => {
    expect(parseChatMode(undefined)).toBe('ask');
    expect(parseChatMode('not-a-mode')).toBe('ask');
  });

  it('gives every mode the WHOLE surface — the two carve-outs are gone', () => {
    // The defect this replaces: the mode label WAS the permission gate, so Ask
    // could not web-search, Explain could not reach tm8_overview and
    // Orchestrate could not read a repository file. Now unified all the way: no
    // tool is denied to any mode, including the `explain_*` presentation tools
    // that were once Explain's alone. Sweep every mode against every tool.
    for (const mode of CHAT_MODES) {
      for (const tool of MCP_TOOL_NAMES) {
        expect([mode, tool, toolPermission(mode, tool)]).toEqual([mode, tool, 'allow']);
      }
      // Hierarchical tools are not narrowed per mode either.
      expect(toolPermission(mode, 'tm8_act', 'entities.delete')).toBe('allow');
      expect(toolPermission(mode, 'tm8_messages', 'messages.post')).toBe('allow');
      // exposedToolNames is now the identity filter: every mode exposes all.
      expect(exposedToolNames(mode, MCP_TOOL_NAMES)).toEqual([...MCP_TOOL_NAMES]);
    }
  });

  it('removed repo_bash entirely — native Bash covers shell', () => {
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain('repo_bash');
    // Calling the retired name is an unknown tool, not a mode denial.
    return new Tm8ToolRouter(transport, { mode: 'build' })
      .call('repo_bash', { command: 'echo no' })
      .then((result) => {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'invalid_input' } },
        });
      });
  });

  it('exposes the inline presentation tools in EVERY mode now', () => {
    const presentation = ['explain_diagram', 'explain_graph', 'explain_code', 'explain_asset'];
    for (const tool of presentation) {
      for (const mode of CHAT_MODES) {
        expect([mode, tool, toolPermission(mode, tool)]).toEqual([mode, tool, 'allow']);
      }
    }
    for (const mode of CHAT_MODES) {
      expect(exposedToolNames(mode, MCP_TOOL_NAMES)).toEqual(
        expect.arrayContaining(presentation),
      );
    }
    // The durable equivalents remain available in every mode too.
    expect(toolPermission('ask', 'doc_create')).toBe('allow');
    expect(toolPermission('orchestrate', 'artifact_create')).toBe('allow');
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
