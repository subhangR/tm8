// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

afterEach(cleanup);

const models: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

describe('automatic chat title', () => {
  it('submits a short label while retaining the complete human opening', async () => {
    const { port } = createChatHomeFixturePort([]);
    const create = vi.fn(port.startThread.create);
    const view = render(<ChatHomeScreen
      port={{ ...port, startThread: { ...port.startThread, create } }}
      spaceId="019f0000-0000-7000-8000-000000000092"
      models={models}
      coldStart="composer"
    />);
    await waitFor(() => expect(view.getByTestId('tch-settings-runs-as')).toBeTruthy());
    const prompt = 'Please fix the login bug in the new Safari version.\n\n  - keep every reproduction step\n  - preserve the indent';
    const composer = view.getByLabelText('Message the chat agent');
    fireEvent.change(composer, { target: { value: prompt } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0].title).toBe('fix the login bug');
    expect(create.mock.calls[0]![0].body).toContain(prompt);
  });
});
