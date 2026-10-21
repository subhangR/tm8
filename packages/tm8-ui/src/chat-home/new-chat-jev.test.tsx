// @vitest-environment jsdom
/**
 * ✦ Ask Jev in the NEW-chat composer (doc 01a154f2, Phase 1).
 *
 * What must hold: the ✦ chip sits in the composer foot beside the model
 * picker, and only before the first message; one press asks `launch.suggest`
 * about the prompt (subject = the about entity, else the home anchor); nothing
 * changes until Apply; applied model, effort, mode and teammate go out through
 * `chat.start`, and skills and context ride the opening message as
 * references; a Codex pick is left out without an OpenAI credential; Send
 * never waits for Jev, and without Jev the composer's own picks go out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId, LaunchSuggestResult, ModelSuggestion } from '@tm8/contract';

import { TIER_LADDER } from '../../../jev/src/model';
import { answeringPort, item, okGroup, pendingPort, SKILLS, MEMORIES, REFERENCES, TEAMMATES } from '../jev/test-support';
import type { JevPort } from '../jev';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import { CLAUDE_RUNG, modeForWorkKind, withJevReferences, withoutCodex, type ChatJevPort } from './new-chat-jev';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000091';
const HOME = '019f0000-0000-7000-8000-0000000000aa' as EntityId;
const RESEARCHER = '019f0000-0000-7000-8000-000000000003';
const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic', agentTool: 'claude-code', efforts: EFFORTS },
  { model: 'claude-opus-5', label: 'Opus 5', provider: 'anthropic', agentTool: 'claude-code', efforts: EFFORTS },
  { model: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', agentTool: 'codex', efforts: EFFORTS },
];

const CODEX_PICK: ModelSuggestion = {
  tier: 'premium', model: 'gpt-6-astra', agentTool: 'codex', effort: 'high',
  need: 2.1, workKind: 'implement', reasons: ['Deep change across packages.'],
};

/* Jev's answer for the chat: a Codex model, Researcher on top, and the
   ranked groups from the shared fixtures. */
const GROUPS: Partial<LaunchSuggestResult['groups']> = {
  model: okGroup(CODEX_PICK),
  teammates: okGroup({ ...TEAMMATES, items: [item(RESEARCHER, 'team_member', 2.7, true, ['space'], 'Researcher')] }),
  skills: okGroup(SKILLS),
  memories: okGroup(MEMORIES),
  references: okGroup(REFERENCES),
};

function chatJev(jev: JevPort, opts: { codex?: boolean } = {}): ChatJevPort {
  return {
    jev,
    homeAnchor: async () => HOME,
    codexAvailable: async () => opts.codex ?? false,
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

async function renderChat(jev?: ChatJevPort, extra: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const { port, controls } = createChatHomeFixturePort();
  const view = render(
    <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" {...(jev ? { jev } : {})} {...extra} />,
  );
  const box = await waitFor(() => view.getByLabelText('Message the chat agent') as HTMLTextAreaElement);
  /* The roster read lands after mount; the start path needs a teammate. */
  await waitFor(() => expect(view.queryByTestId('tch-compose-refusal')).toBeNull());
  return { view, box, controls };
}

const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });

describe('pure helpers', () => {
  it('the Claude rung per tier is Jev’s own ladder', () => {
    for (const rung of TIER_LADDER) expect(CLAUDE_RUNG[rung.tier]).toBe(rung.claude);
  });

  it('a Codex pick becomes the same rung’s Claude model and says why; a Claude pick is untouched', () => {
    const swapped = withoutCodex(CODEX_PICK);
    expect(swapped).toMatchObject({ model: 'claude-opus-5', agentTool: 'claude-code', effort: 'high', tier: 'premium' });
    expect(swapped.reasons.at(-1)).toContain('Codex left out');
    const claude = { ...CODEX_PICK, model: 'claude-sonnet-5', agentTool: 'claude-code' as const };
    expect(withoutCodex(claude)).toBe(claude);
  });

  it('maps the work kind to a mode, and names none for an unclear one', () => {
    expect(modeForWorkKind('implement')).toBe('build');
    expect(modeForWorkKind('coordinate')).toBe('orchestrate');
    expect(modeForWorkKind('design')).toBe('plan');
    expect(modeForWorkKind('review')).toBe('ask');
    expect(modeForWorkKind('unclear')).toBeNull();
  });

  it('puts skills as / references and context as entity ids under the prompt', () => {
    const body = withJevReferences('Fix the invite flow', [
      { id: 'sk-1' as EntityId, kind: 'skill', title: 'code review', group: 'skills' },
      { id: 'doc-1' as EntityId, kind: 'doc', title: 'Join `spec`', group: 'references' },
      { id: 'mem-1' as EntityId, kind: 'memory', title: 'Links expire', group: 'memories' },
    ]);
    expect(body).toBe(
      'Fix the invite flow\n\nSkills: [/code review](tm8://skill/sk-1)\n\nContext: Join \'spec\' `doc-1` · Links expire `mem-1`',
    );
    expect(withJevReferences('As typed', [])).toBe('As typed');
  });
});

describe('✦ Ask Jev in the new-chat composer', () => {
  it('sits in the composer foot beside the model picker; without a port there is no chip', async () => {
    const { view } = await renderChat(chatJev(answeringPort(GROUPS)));
    const chip = view.getByTestId('tch-jev');
    /* The very next control in the same foot row is the model picker. */
    expect(chip.nextElementSibling?.contains(view.getByTestId('tch-model'))).toBe(true);
    expect(within(chip).getByTestId('jev-entry-badge').textContent).toBe('✦ Ask Jev');
    cleanup();

    const bare = await renderChat();
    expect(bare.view.queryByTestId('tch-jev')).toBeNull();
  });

  it('asks only on tap, about the prompt, with the home anchor as subject and the composer’s teammate', async () => {
    const jev = answeringPort(GROUPS);
    const { view, box } = await renderChat(chatJev(jev));
    type(box, 'Fix the invite flow\nIt double-sends.');
    expect(jev.inputs).toHaveLength(0);
    fireEvent.click(view.getByTestId('jev-entry-button'));
    await waitFor(() => expect(jev.inputs).toHaveLength(1));
    expect(jev.inputs[0]).toMatchObject({
      subjectId: HOME,
      draft: { title: 'Fix the invite flow', description: 'Fix the invite flow\nIt double-sends.' },
    });
    expect(jev.inputs[0]?.teamMemberId).toBeTruthy();
  });

  it('an about entity is the subject when the host has one', async () => {
    const jev = answeringPort(GROUPS);
    const ABOUT = '019f0000-0000-7000-8000-0000000000bb' as EntityId;
    const { view, box } = await renderChat(chatJev(jev), { aboutId: ABOUT });
    type(box, 'Summarise this');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    await waitFor(() => expect(jev.inputs[0]?.subjectId).toBe(ABOUT));
  });

  it('changes nothing until Apply; applied picks go out through chat.start and the opening message', async () => {
    const { view, box, controls } = await renderChat(chatJev(answeringPort(GROUPS)));
    type(box, 'Fix the invite flow');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    await waitFor(() => view.getByTestId('jev-panel-model-value'));

    /* Answered, nothing applied: the composer still shows its own picks. */
    expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 5');
    /* No OpenAI credential: the Codex pick is left out for its Claude rung. */
    expect(view.getByTestId('jev-panel-model-value').textContent).toContain('Opus 5');
    expect(view.getByTestId('jev-panel-model-value').textContent).toContain('claude-code');
    expect(view.getByTestId('jev-panel-mode-value').textContent).toContain('build');

    fireEvent.click(view.getByTestId('jev-apply-mode'));
    fireEvent.click(view.getByTestId('jev-apply-model'));
    fireEvent.click(view.getByTestId('jev-apply-skills'));
    fireEvent.click(view.getByTestId('jev-apply-references'));
    fireEvent.click(view.getByTestId('jev-apply-teammate'));

    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Opus 5'));
    expect(view.getByTestId('tch-settings-role').getAttribute('data-mode')).toBe('build');
    /* What Apply put in the first message is shown, and removable. */
    const strip = view.getByTestId('chat-jev-refs');
    expect(within(strip).getByTestId('chat-jev-ref-sk-a')).toBeTruthy();
    expect(within(strip).getByTestId('chat-jev-ref-ref-a')).toBeTruthy();
    fireEvent.click(view.getByTestId('chat-jev-ref-remove-ref-b'));
    expect(within(strip).queryByTestId('chat-jev-ref-ref-b')).toBeNull();

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    const start = controls.roots[0]!;
    expect(start).toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'high', mode: 'build', teammateId: RESEARCHER });
    expect(start.body).toBe(
      'Fix the invite flow\n\nSkills: [/skill sk-a](tm8://skill/sk-a)\n\nContext: Join-screen spec `ref-a`',
    );
    /* The chat is named after the person's words, not the references. */
    expect(start.title).toBe('Fix the invite flow');

    /* The chat has started: no Jev on its turns. */
    await waitFor(() => expect(view.queryByTestId('tch-jev')).toBeNull());
    expect(view.queryByTestId('chat-jev-refs')).toBeNull();
  });

  it('with an OpenAI credential the Codex pick stays Jev’s', async () => {
    const { view, box } = await renderChat(chatJev(answeringPort(GROUPS), { codex: true }));
    type(box, 'Fix the invite flow');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    await waitFor(() => expect(view.getByTestId('jev-panel-model-value').textContent).toContain('GPT-6 Astra'));
    fireEvent.click(view.getByTestId('jev-apply-model'));
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('GPT-6 Astra'));
  });

  it('Send never waits for Jev: an unanswered ask leaves the composer’s own picks and the typed body', async () => {
    const jev = pendingPort();
    const { view, box, controls } = await renderChat(chatJev(jev));
    type(box, 'Quick question');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    await waitFor(() => expect(jev.calls).toHaveLength(1));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ model: 'claude-sonnet-5', body: 'Quick question' });
  });

  it('without Jev, a remembered model still starts the chat', async () => {
    const jev = answeringPort(GROUPS);
    const { box, controls, view } = await renderChat(chatJev(jev), { newChatSeed: { model: 'claude-opus-5' } });
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Opus 5'));
    type(box, 'Hello');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]?.model).toBe('claude-opus-5');
    expect(jev.inputs).toHaveLength(0);
  });
});
