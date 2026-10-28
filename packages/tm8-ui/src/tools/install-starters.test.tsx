// @vitest-environment jsdom
/**
 * "Install starter tools" (Tools v2 §3.1): the Tools list's one press creates
 * every `examples/tools` starter the space does not hold yet, by name, through
 * `tools.create`, then sends each selection header; one refusal does not stop
 * the rest, and a header the node did not store is a note, not a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError, TOOL_STARTERS, toolStarterNamed } from '@tm8/contract';
import { createToolFixture, fixtureTool, HEADER_NOT_STORED } from './fixture';
import { InstallStarters, installStarters } from './InstallStarters';

afterEach(cleanup);
const SPACE = '00000000-0000-4000-8000-000000000001';

describe('installStarters', () => {
  it('reads the list first, skips names already present, creates the rest and sets their headers', async () => {
    const { port, created, headers } = createToolFixture(); // the fixture holds url-check already
    port.create = vi.fn(port.create); port.list = vi.fn(port.list);
    const progress = vi.fn();
    const results = await installStarters(port, SPACE, progress);
    expect(port.list).toHaveBeenCalledWith(SPACE);
    expect(results.map(result => [result.name, result.status])).toEqual(TOOL_STARTERS.map(starter => [starter.name, starter.name === fixtureTool.definition.name ? 'skipped' : 'created']));
    expect(created.map(tool => tool.definition.name).sort()).toEqual(TOOL_STARTERS.map(starter => starter.name).filter(name => name !== fixtureTool.definition.name).sort());
    for (const tool of created) {
      const starter = toolStarterNamed(tool.definition.name)!;
      expect(tool.definition).toEqual(expect.objectContaining({ source: starter.source, inputs: starter.spec.inputs, help: starter.spec.help, tm8Access: starter.spec.tm8Access, timeoutSeconds: starter.spec.timeoutSeconds }));
      expect(headers.get(tool.id)).toEqual({ whenToUse: starter.whenToUse, summary: starter.summary });
    }
    expect(progress).toHaveBeenCalledTimes(TOOL_STARTERS.length);
    expect(progress.mock.calls.at(-1)![0]).toEqual(results);
  });

  it('one refusal is one failed line; the others are still created', async () => {
    const { port } = createToolFixture();
    const create = port.create;
    port.create = vi.fn(async (spaceId, definition) => {
      if (definition.name === 'slack-notify') throw new CollabError('forbidden', 'only a member with edit rights can create a tool');
      return create(spaceId, definition);
    });
    const results = await installStarters(port, SPACE);
    expect(results.find(result => result.name === 'slack-notify')).toEqual({ name: 'slack-notify', status: 'failed', message: 'only a member with edit rights can create a tool' });
    expect(results.filter(result => result.status === 'created').length).toBe(TOOL_STARTERS.length - 2);
  });

  it('a header the node did not store is a note on a created tool', async () => {
    const { port } = createToolFixture(undefined, {}, { headerStored: false });
    const results = await installStarters(port, SPACE);
    const created = results.filter(result => result.status === 'created');
    expect(created.length).toBeGreaterThan(0);
    for (const result of created) expect(result).toMatchObject({ headerNotStored: HEADER_NOT_STORED });
  });
});

describe('InstallStarters', () => {
  it('installs on one press and reports every starter by name', async () => {
    const { port } = createToolFixture();
    const onInstalled = vi.fn();
    render(<InstallStarters spaceId={SPACE} port={port} onInstalled={onInstalled} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install starter tools' }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    const report = screen.getByRole('status');
    expect(report.textContent).toContain(`Installed ${TOOL_STARTERS.length - 1} of ${TOOL_STARTERS.length} starter tools.`);
    expect(report.textContent).toContain('url-check: already in this space, skipped');
    expect(report.textContent).toContain('gh-pr-status: created');
    expect(screen.getByRole('list', { name: 'Starter tools' }).querySelectorAll('li')).toHaveLength(TOOL_STARTERS.length);
  });

  it('a listing that fails installs nothing and says so', async () => {
    const { port } = createToolFixture();
    port.list = vi.fn(async () => { throw new CollabError('upstream_unavailable', 'node unreachable'); });
    port.create = vi.fn(port.create);
    render(<InstallStarters spaceId={SPACE} port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install starter tools' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Nothing was installed: node unreachable');
    expect(port.create).not.toHaveBeenCalled();
  });

  it('is disabled, with the reason, when the connection has no tools port', () => {
    render(<InstallStarters spaceId={SPACE} port={undefined} />);
    const button = screen.getByRole('button', { name: 'Install starter tools' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.title).toBe('Tools are unavailable on this connection.');
  });
});
