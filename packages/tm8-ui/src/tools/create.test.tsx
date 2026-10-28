// @vitest-environment jsdom
/**
 * Creating a tool in the UI (Tools v2 §3.1): one `DefinitionForm` shared with
 * the page's editor, a starter that prefills every field, a selection header
 * sent after `tools.create`, and refusals placed where the server's own path
 * points — never a generic sentence over the node's message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollabError, TOOL_STARTERS, ToolDefinitionSchema, toolStarterDefinition, toolStarterNamed, type ToolDefinition } from '@tm8/contract';
import { ToolCreateControl, toolCreateValuesOf, toolCreateValuesOfStarter } from './ToolCreateControl';
import { createToolFixture, HEADER_NOT_STORED } from './fixture';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value, onChange, readOnly }: { value: string; onChange(value: string): void; readOnly?: boolean }) => <textarea aria-label="Source" value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
afterEach(cleanup);

const SPACE = '00000000-0000-4000-8000-000000000001';
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const typeInto = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));

function fillMinimal(name = 'hello') {
  typeInto('Name', name);
  typeInto('Description', 'Says hello');
}

describe('ToolCreateControl', () => {
  it('opens from the list header button as a dialog, creates through tools.create and reports the new tool', async () => {
    const { port } = createToolFixture(); port.create = vi.fn(port.create);
    const onCreated = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} label="New tool" onCreated={onCreated} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    const dialog = screen.getByRole('dialog', { name: 'New tool' });
    expect(within(dialog).getByRole('form', { name: 'New tool' })).toBeTruthy();
    fillMinimal();
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(port.create).toHaveBeenCalledWith(SPACE, expect.objectContaining({ name: 'hello', description: 'Says hello', runtime: 'bash', inputs: [], tm8Access: 'none', timeoutSeconds: expect.any(Number) }));
    const created = onCreated.mock.calls[0]![0] as { tool: { id: string; definition: ToolDefinition }; headerNotStored: string | null };
    expect(created.tool.definition.name).toBe('hello');
    expect(created.headerNotStored).toBeNull();
    // The dialog closes on success.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('autoOpen renders the form at once, with the starter select focused and no button', () => {
    render(<ToolCreateControl spaceId={SPACE} port={createToolFixture().port} autoOpen />);
    expect(screen.queryByRole('button', { name: 'New tool' })).toBeNull();
    expect(screen.getByRole('form', { name: 'New tool' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Start from a starter'));
  });

  it('a starter prefills every definition field and the selection header, and stays editable', async () => {
    const { port } = createToolFixture(); port.create = vi.fn(port.create); port.setHeader = vi.fn(port.setHeader);
    const onCreated = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen onCreated={onCreated} />);
    const starter = toolStarterNamed('gh-pr-status')!;
    fireEvent.change(screen.getByLabelText('Start from a starter'), { target: { value: 'gh-pr-status' } });
    expect(field('Name').value).toBe('gh-pr-status');
    expect(field('Description').value).toBe(starter.description);
    expect((screen.getByRole('combobox', { name: 'Runtime' }) as HTMLSelectElement).value).toBe(starter.runtime);
    expect((screen.getByRole('textbox', { name: 'Source' }) as HTMLTextAreaElement).value).toBe(starter.source);
    expect(field('Help (Markdown)').value).toBe(starter.spec.help);
    expect((screen.getByRole('combobox', { name: 'tm8 API access' }) as HTMLSelectElement).value).toBe(starter.spec.tm8Access);
    expect(field('Timeout (seconds)').value).toBe(String(starter.spec.timeoutSeconds));
    expect((screen.getByTestId('header-input-when') as HTMLTextAreaElement).value).toBe(starter.whenToUse);
    expect((screen.getByTestId('header-input-summary') as HTMLTextAreaElement).value).toBe(starter.summary);
    expect(screen.getAllByRole('textbox', { name: /^Input \d+ name$/ })).toHaveLength(starter.spec.inputs.length);
    expect(screen.getByText(starter.description, { selector: '.tool-starter-note' })).toBeTruthy();
    // Still a form: the name can be changed before creating.
    typeInto('Name', 'pr-status-copy');
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // Byte for byte what the starter declares (as the contract normalises it), under the edited name.
    // (`required` is explicit on every input the form emits; the contract leaves it optional.)
    const expected = ToolDefinitionSchema.parse({ ...toolStarterDefinition(starter), name: 'pr-status-copy' });
    expect((port.create as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([SPACE, { ...expected, inputs: expected.inputs.map(input => ({ required: false, ...input })) }]);
    expect(port.setHeader).toHaveBeenCalledWith(expect.any(String), { whenToUse: starter.whenToUse, summary: starter.summary, keywords: [] });
  });

  it('every starter yields a definition the contract accepts', () => {
    for (const starter of TOOL_STARTERS) {
      const values = toolCreateValuesOfStarter(starter.name)!;
      expect(values.draft.name).toBe(starter.name);
      expect(values.header.whenToUse).toBe(starter.whenToUse);
    }
    expect(toolCreateValuesOfStarter('no-such-starter')).toBeNull();
  });

  it('sets the selection header after the create and hands the host both', async () => {
    const { port, headers } = createToolFixture();
    const onCreated = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen onCreated={onCreated} />);
    fillMinimal('with-header');
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'Open when greeting' } });
    fireEvent.change(screen.getByTestId('header-input-summary'), { target: { value: 'Prints hello' } });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const { tool, headerNotStored } = onCreated.mock.calls[0]![0] as { tool: { id: string }; headerNotStored: string | null };
    expect(headerNotStored).toBeNull();
    expect(headers.get(tool.id)).toEqual({ whenToUse: 'Open when greeting', summary: 'Prints hello', keywords: [] });
  });

  it('a header the node does not store is a notice on a created tool, never a failed create', async () => {
    const { port } = createToolFixture(undefined, {}, { headerStored: false });
    const onCreated = vi.fn(); const onNotice = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen onCreated={onCreated} onNotice={onNotice} />);
    fillMinimal('no-header-kind');
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'Open when greeting' } });
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ headerNotStored: HEADER_NOT_STORED });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining(HEADER_NOT_STORED));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends no header when the fields are blank', async () => {
    const { port } = createToolFixture(); port.setHeader = vi.fn(port.setHeader);
    const onCreated = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen onCreated={onCreated} />);
    fillMinimal('plain');
    create();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(port.setHeader).not.toHaveBeenCalled();
  });

  it('places the server’s invalid_input issue on the field its path names and keeps the server message on top', async () => {
    const { port } = createToolFixture();
    port.create = vi.fn(async () => { throw new CollabError('invalid_input', 'request body failed contract validation', { details: { issues: [
      { code: 'too_small', path: ['definition', 'inputs', 0, 'default'], message: 'Number must be greater than or equal to 1' },
      { code: 'custom', path: ['definition', 'source'], message: 'source must not be empty' },
    ] } }); });
    const onCreated = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen onCreated={onCreated} />);
    fillMinimal('refused');
    fireEvent.click(screen.getByRole('button', { name: 'Add input' }));
    typeInto('Input 1 name', 'limit');
    create();
    expect(await screen.findByTestId('tool-create-problem')).toHaveProperty('textContent', 'request body failed contract validation');
    expect(screen.getByText('Number must be greater than or equal to 1')).toBeTruthy();
    expect(screen.getByText('source must not be empty')).toBeTruthy();
    expect(field('Input 1 default').getAttribute('aria-invalid')).toBe('true');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create tool' })).toHaveProperty('disabled', false);
  });

  it('a taken name lands on Name in the server’s words (invariant_violation 23505)', async () => {
    const { port } = createToolFixture();
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen />);
    fillMinimal('url-check'); // the fixture already holds url-check
    create();
    expect(await screen.findByText('a live tool already has this name')).toBeTruthy();
    expect(field('Name').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('Name'));
    expect(screen.queryByTestId('tool-create-problem')).toBeNull();
  });

  it('a refusal without a path shows the server’s own message at the top of the form', async () => {
    const { port } = createToolFixture();
    port.create = vi.fn(async () => { throw new CollabError('forbidden', 'only a member with edit rights can create a tool'); });
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen />);
    fillMinimal('forbidden');
    create();
    expect(await screen.findByTestId('tool-create-problem')).toHaveProperty('textContent', 'only a member with edit rights can create a tool');
  });

  it('refuses locally with the rule, before any request, when the draft cannot be a definition', async () => {
    const { port } = createToolFixture(); port.create = vi.fn(port.create);
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen />);
    typeInto('Name', 'Bad Name');
    typeInto('Timeout (seconds)', '0');
    create();
    expect(await screen.findByText('Use 2–63 characters: lowercase letters, digits and hyphens, starting with a letter.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number of seconds, at least 1.')).toBeTruthy();
    expect(port.create).not.toHaveBeenCalled();
  });

  it('reports busy to its host around the create and restores stored values', async () => {
    const { port } = createToolFixture();
    const onBusy = vi.fn(); const onValues = vi.fn();
    const initial = toolCreateValuesOfStarter('url-check')!;
    initial.draft.name = 'restored-name';
    render(<ToolCreateControl spaceId={SPACE} port={port} autoOpen initial={initial} onBusy={onBusy} onValues={onValues} onCreated={vi.fn()} />);
    expect(field('Name').value).toBe('restored-name');
    typeInto('Description', 'edited');
    expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ starter: 'url-check', draft: expect.objectContaining({ description: 'edited' }) }));
    create();
    await waitFor(() => expect(onBusy).toHaveBeenCalledWith(true));
  });

  it('says so and offers nothing when the connection has no tools port', () => {
    render(<ToolCreateControl spaceId={SPACE} port={undefined} autoOpen />);
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Tools are unavailable on this connection.');
    expect(screen.getByRole('button', { name: 'Create tool' })).toHaveProperty('disabled', true);
    cleanup();
    render(<ToolCreateControl spaceId={SPACE} port={undefined} label="New tool" />);
    expect(screen.getByRole('button', { name: 'New tool' })).toHaveProperty('disabled', true);
  });

  it('Cancel in the dialog closes it; a host Cancel is called instead when given', () => {
    render(<ToolCreateControl spaceId={SPACE} port={createToolFixture().port} label="New tool" />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    const onCancel = vi.fn();
    render(<ToolCreateControl spaceId={SPACE} port={createToolFixture().port} autoOpen onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('toolCreateValuesOf', () => {
  it('accepts only what the form itself stored', () => {
    const values = toolCreateValuesOfStarter('url-check')!;
    expect(toolCreateValuesOf({ ...values })).toEqual(values);
    expect(toolCreateValuesOf(null)).toBeNull();
    expect(toolCreateValuesOf({ title: 'a generic draft' })).toBeNull();
    expect(toolCreateValuesOf({ ...values, draft: { ...values.draft, runtime: 'perl' } })).toBeNull();
  });
});
