// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatHomeScreen } from './ChatHomeScreen';
import { ChatCredentialPicker } from './ChatCredentialPicker';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatCredentialSelection } from '@tm8/contract';

afterEach(cleanup);
const SPACE = '019f0000-0000-7000-8000-000000000090';
const models = [{ model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' }];

it('offers a credential choice before the first chat message', async () => {
  const { port } = createChatHomeFixturePort([]);
  const create = vi.fn(port.startThread.create);
  const view = render(<ChatHomeScreen port={{ ...port, startThread: { ...port.startThread, create } }} spaceId={SPACE} models={models} />);
  await waitFor(() => expect(view.getByTestId('tch-teammate').textContent).not.toContain('No '));
  fireEvent.click(view.getByLabelText('Chat credentials'));
  fireEvent.click(view.getByTestId('tch-credentials-member'));
  const composer = view.getByLabelText('Message the chat agent');
  fireEvent.change(composer, { target: { value: 'Use my account' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]![0].credentialSelection).toEqual({ source: 'member' });
});

it('saves a credential change on an existing chat, including during a turn', async () => {
  const { port } = createChatHomeFixturePort();
  const setCredentials = vi.fn(async input => input.credentialSelection as ChatCredentialSelection);
  const view = render(<ChatHomeScreen port={{ ...port, setCredentials }} spaceId={SPACE} models={models}
    routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId} />);
  await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Sonnet'));
  fireEvent.click(view.getByLabelText('Chat credentials'));
  fireEvent.click(view.getByTestId('tch-credentials-node'));
  await waitFor(() => expect(setCredentials).toHaveBeenCalledWith({
    chatId: CHAT_HOME_FIXTURE_THREAD.summary.rootId, credentialSelection: { source: 'node' },
  }));
  await waitFor(() => expect(view.getByTestId('tch-credentials').textContent).toContain('Server'));
});

it('keeps the prior selection and shows a policy refusal', async () => {
  const { port } = createChatHomeFixturePort();
  const view = render(<ChatHomeScreen port={{ ...port, setCredentials: async () => { throw new Error('Server credential forbidden'); } }}
    spaceId={SPACE} models={models} routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId} />);
  await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Sonnet'));
  fireEvent.click(view.getByLabelText('Chat credentials'));
  fireEvent.click(view.getByTestId('tch-credentials-node'));
  await waitFor(() => expect(view.getByText('Server credential forbidden')).toBeTruthy());
  expect(view.getByTestId('tch-credentials').textContent).toContain('Auto');
});

it('lists named space credentials and prevents backend models from choosing a server account', async () => {
  const { port } = createChatHomeFixturePort();
  const changed = vi.fn();
  const view = render(<ChatCredentialPicker port={{ ...port, credentialOptions: async () => [{ id: SPACE, label: 'Shared account' }] }}
    spaceId={SPACE} value={{ source: 'auto' }} onChange={changed} disabled={false} backendKeyOnly={false} />);
  fireEvent.click(view.getByLabelText('Chat credentials'));
  await waitFor(() => expect(view.getByText('Shared account')).toBeTruthy());
  fireEvent.click(view.getByTestId(`tch-credentials-space:${SPACE}`));
  expect(changed).toHaveBeenCalledWith({ source: 'space', credentialId: SPACE });
  view.rerender(<ChatCredentialPicker port={port} spaceId={SPACE} value={{ source: 'auto' }} onChange={changed} disabled={false} backendKeyOnly />);
  fireEvent.click(view.getByLabelText('Chat credentials'));
  expect(view.getByTestId('tch-credentials-node').getAttribute('aria-disabled')).toBe('true');
});
