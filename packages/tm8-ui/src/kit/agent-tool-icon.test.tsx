// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentToolIcon, agentToolKind } from './AgentToolIcon';

describe('AgentToolIcon', () => {
  it('draws Claude and Codex as their real SVG marks, not text glyphs', () => {
    const claude = render(<AgentToolIcon tool="claude-code" />).container;
    expect(claude.querySelector('svg[data-tool-kind="claude"]')).not.toBeNull();
    expect(claude.textContent).toBe('');
    const codex = render(<AgentToolIcon tool="codex" size={22} />).container;
    const svg = codex.querySelector('svg[data-tool-kind="codex"]');
    expect(svg?.getAttribute('width')).toBe('22');
    expect(codex.textContent).toBe('');
  });

  it('keeps a glyph for tools without a mark, and a terminal is never an agent', () => {
    expect(render(<AgentToolIcon tool="gemini" />).container.textContent).toBe('✧');
    expect(render(<AgentToolIcon tool={null} />).container.textContent).toBe('✦');
    expect(agentToolKind('claude-code', { shell: true })).toBe('shell');
    expect(agentToolKind(null)).toBe('agent');
    expect(agentToolKind('Codex')).toBe('codex');
  });
});
