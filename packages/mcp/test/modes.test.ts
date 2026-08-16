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

  it('gives every mode the whole core surface, not just Build', () => {
    // The defect this replaces: the mode label WAS the permission gate, so Ask
    // could not web-search, Explain could not reach tm8_overview and
    // Orchestrate could not read a repository file. Sweep every mode against
    // every core tool rather than sampling — a regression here is one mode
    // quietly losing one capability, which a sample cannot see.
    const core = MCP_TOOL_NAMES.filter((name) => (
      name !== 'repo_bash' && !name.startsWith('explain_')
    ));
    for (const mode of CHAT_MODES) {
      for (const tool of core) {
        expect([mode, tool, toolPermission(mode, tool)]).toEqual([mode, tool, 'allow']);
      }
      // Hierarchical tools are no longer narrowed per mode either.
      expect(toolPermission(mode, 'tm8_act', 'entities.delete')).toBe('allow');
      expect(toolPermission(mode, 'tm8_messages', 'messages.post')).toBe('allow');
      expect(exposedToolNames(mode, MCP_TOOL_NAMES)).toEqual(expect.arrayContaining([...core]));
    }
  });

  it('keeps shell in Build and approval-gated, denied in every other mode', () => {
    expect(toolPermission('build', 'repo_bash')).toBe('ask');
    // `ask` is dropped from the provider list: a headless run cannot settle an
    // interactive approval, so an exposed repo_bash would only fail mid-turn.
    expect(exposedToolNames('build', MCP_TOOL_NAMES)).not.toContain('repo_bash');
    for (const mode of CHAT_MODES.filter((entry) => entry !== 'build')) {
      expect([mode, toolPermission(mode, 'repo_bash')]).toEqual([mode, 'deny']);
    }
  });

  it('keeps the inline presentation tools as Explain’s extra surface', () => {
    const explainOnly = ['explain_diagram', 'explain_graph', 'explain_code', 'explain_asset'];
    for (const tool of explainOnly) {
      expect(toolPermission('explain', tool)).toBe('allow');
      for (const mode of CHAT_MODES.filter((entry) => entry !== 'explain')) {
        expect([mode, tool, toolPermission(mode, tool)]).toEqual([mode, tool, 'deny']);
      }
    }
    expect(exposedToolNames('explain', MCP_TOOL_NAMES)).toEqual(
      expect.arrayContaining(explainOnly),
    );
    // These are a rendering contract, not a capability: every mode still says
    // the same thing durably through docs and artifacts.
    expect(toolPermission('ask', 'doc_create')).toBe('allow');
    expect(toolPermission('orchestrate', 'artifact_create')).toBe('allow');
  });

  it('enforces mode at invocation even if a denied tool is called by name', async () => {
    const result = await new Tm8ToolRouter(transport, { mode: 'ask' }).call('repo_bash', {
      command: 'echo no',
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
