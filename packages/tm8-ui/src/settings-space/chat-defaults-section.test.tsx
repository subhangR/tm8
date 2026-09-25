// @vitest-environment jsdom
/**
 * Settings → Chat defaults (entity-chat design 01a0da4e §3.4).
 *
 *   · the scope (space-wide, server-stored, admins only) is stated FIRST;
 *   · one row per registry kind a chat can be about — never message/chat,
 *     never the `c:*` fallback — plus the space's real custom kinds;
 *   · teammate and model are each optional, and each change writes a PATCH of
 *     that ONE kind; emptying both clears it (`null`);
 *   · the server's refusal is rendered beside its row;
 *   · a stored value that no longer resolves is shown and named, not dropped;
 *   · a save here reaches every other `useChatDefaults` consumer (lane C's).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ChatDefault, ChatDefaultsView } from '@tm8/contract';
import { allKinds, CUSTOM_KIND_FALLBACK } from '../domain';
import { modelCatalog } from '../domain/model-catalog';
import {
  chatDefaultKindRows,
  resolveChatDefault,
  useChatDefaults,
  type ChatDefaultsOptions,
  type ChatDefaultsSeam,
} from '../chat-defaults';
import { ChatDefaultsSection } from './ChatDefaultsSection';

afterEach(cleanup);

const SPACE = 'space-1';
const TEAMMATES = [
  { id: 'tm-draco', label: 'Draco' },
  { id: 'tm-ada', label: 'Ada' },
];

function fakeSeam(initial: ChatDefaultsView['defaults'] = {}, refuse?: string) {
  let view: ChatDefaultsView = { spaceId: SPACE, defaults: initial, revision: 0 };
  const setChatDefaults = vi.fn(async (_space: string, patch: Record<string, ChatDefault | null>) => {
    if (refuse) throw new Error(refuse);
    const next = { ...view.defaults };
    for (const [kind, entry] of Object.entries(patch)) {
      if (entry === null) delete next[kind];
      else next[kind] = entry;
    }
    view = { ...view, defaults: next, revision: view.revision + 1 };
    return view;
  });
  const seam: ChatDefaultsSeam = { chatDefaults: vi.fn(async () => view), setChatDefaults };
  return { seam, setChatDefaults };
}

function mount(seam: ChatDefaultsSeam, custom: ChatDefaultsOptions['kinds'] = []) {
  const options: ChatDefaultsOptions = { kinds: [...chatDefaultKindRows(), ...custom], teammates: TEAMMATES };
  return render(
    <ChatDefaultsSection
      heading="Chat defaults"
      nodeKey="local"
      wiring={{ seam, spaceId: SPACE, loadOptions: async () => options }}
    />,
  );
}

const FIRST = chatDefaultKindRows()[0]!;
const MODEL = modelCatalog('local')[0]!.model;

describe('Chat defaults — the section', () => {
  it('states its space-wide scope at the top, before any row', async () => {
    const { seam } = fakeSeam();
    const { container } = mount(seam);
    await screen.findByTestId('chat-defaults-table');
    const scope = screen.getByTestId('chat-defaults-scope');
    expect(scope.textContent).toMatch(/whole space/i);
    expect(scope.textContent).toMatch(/every member/i);
    expect(scope.textContent).toMatch(/owners and admins/i);
    // Order in the document: the scope precedes the table.
    const order = Array.from(container.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'));
    expect(order.indexOf('chat-defaults-scope')).toBeLessThan(order.indexOf('chat-defaults-table'));
  });

  it('one row per registry kind a chat can be about, plus custom kinds — never message, chat or the fallback', async () => {
    const { seam } = fakeSeam();
    mount(seam, [{ kind: 'c:bug', label: 'Bug', custom: true }]);
    await screen.findByTestId('chat-defaults-table');
    const expected = allKinds()
      .map((row) => row.kind)
      .filter((kind) => kind !== 'message' && kind !== 'chat' && kind !== CUSTOM_KIND_FALLBACK);
    expect(expected.length).toBeGreaterThan(10);
    for (const kind of expected) expect(screen.getByTestId(`chat-default-row-${kind}`)).toBeTruthy();
    expect(screen.getByTestId('chat-default-row-c:bug').textContent).toMatch(/custom/);
    expect(screen.queryByTestId('chat-default-row-message')).toBeNull();
    expect(screen.queryByTestId('chat-default-row-chat')).toBeNull();
    expect(screen.queryByTestId(`chat-default-row-${CUSTOM_KIND_FALLBACK}`)).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(expected.length + 1 + 1); // + custom + header
  });

  it('each pick writes a PATCH of that one kind; both fields optional; emptying both clears it', async () => {
    const { seam, setChatDefaults } = fakeSeam();
    mount(seam);
    const row = await screen.findByTestId(`chat-default-row-${FIRST.kind}`);
    const teammate = within(row).getByLabelText(`default teammate for ${FIRST.label}`);
    const model = within(row).getByLabelText(`default model for ${FIRST.label}`);

    fireEvent.change(teammate, { target: { value: 'tm-draco' } });
    await waitFor(() => expect(setChatDefaults).toHaveBeenLastCalledWith(SPACE, { [FIRST.kind]: { teammateId: 'tm-draco' } }));
    await waitFor(() => expect(row.getAttribute('data-complete')).toBe('false'));

    fireEvent.change(model, { target: { value: MODEL } });
    await waitFor(() => expect(setChatDefaults).toHaveBeenLastCalledWith(SPACE, { [FIRST.kind]: { teammateId: 'tm-draco', model: MODEL } }));
    await waitFor(() => expect(row.getAttribute('data-complete')).toBe('true'));

    fireEvent.change(teammate, { target: { value: '' } });
    await waitFor(() => expect(setChatDefaults).toHaveBeenLastCalledWith(SPACE, { [FIRST.kind]: { model: MODEL } }));
    fireEvent.change(model, { target: { value: '' } });
    await waitFor(() => expect(setChatDefaults).toHaveBeenLastCalledWith(SPACE, { [FIRST.kind]: null }));
  });

  it('renders the server refusal beside its row', async () => {
    const { seam } = fakeSeam({}, 'Space owner/admin human principal required');
    mount(seam);
    const row = await screen.findByTestId(`chat-default-row-${FIRST.kind}`);
    fireEvent.change(within(row).getByLabelText(`default model for ${FIRST.label}`), { target: { value: MODEL } });
    expect((await screen.findByTestId(`chat-default-refusal-${FIRST.kind}`)).textContent).toMatch(/owner\/admin/);
  });

  it('a stored value that no longer resolves is shown and named, not dropped', async () => {
    const { seam } = fakeSeam({ [FIRST.kind]: { teammateId: 'tm-gone', model: 'retired-model' } });
    mount(seam);
    const row = await screen.findByTestId(`chat-default-row-${FIRST.kind}`);
    const teammate = within(row).getByLabelText(`default teammate for ${FIRST.label}`) as HTMLSelectElement;
    const model = within(row).getByLabelText(`default model for ${FIRST.label}`) as HTMLSelectElement;
    expect(teammate.value).toBe('tm-gone');
    expect(teammate.selectedOptions[0]!.textContent).toMatch(/no longer in this space/);
    expect(model.value).toBe('retired-model');
    expect(model.selectedOptions[0]!.textContent).toMatch(/no longer offered/);
  });

  it('says it is not wired when the port carries no chat-defaults seam', () => {
    render(<ChatDefaultsSection heading="Chat defaults" nodeKey="local" />);
    expect(screen.getByTestId('chat-defaults-scope')).toBeTruthy();
    expect(screen.getByTestId('section-absent').textContent).toMatch(/not wired/);
  });
});

describe('useChatDefaults — the shared read lane C consumes', () => {
  it('reads one kind, and a save through ANY consumer reaches every other', async () => {
    const { seam } = fakeSeam({ task: { teammateId: 'tm-ada' } });
    const panel = renderHook(() => useChatDefaults(seam, SPACE, 'task'));
    const settings = renderHook(() => useChatDefaults(seam, SPACE));
    await waitFor(() => expect(panel.result.current.status).toBe('ready'));
    expect(panel.result.current.entry).toEqual({ teammateId: 'tm-ada' });
    // One read shared by both consumers.
    expect(seam.chatDefaults).toHaveBeenCalledTimes(1);

    await act(async () => {
      await settings.result.current.set('task', { teammateId: 'tm-ada', model: MODEL });
    });
    expect(panel.result.current.entry).toEqual({ teammateId: 'tm-ada', model: MODEL });
  });

  it('idle without a seam or space', () => {
    const { result } = renderHook(() => useChatDefaults(null, null, 'task'));
    expect(result.current.status).toBe('idle');
    expect(result.current.entry).toBeNull();
  });
});

describe('resolveChatDefault — the skip-when-default rule (§3.4)', () => {
  const ctx = {
    teammateExists: (id: string) => id === 'tm-ada',
    modelOffered: (model: string) => model === MODEL,
  };
  it('skips the card only when BOTH are set and BOTH resolve', () => {
    expect(resolveChatDefault({ teammateId: 'tm-ada', model: MODEL }, ctx)).toEqual({ skip: true, teammateId: 'tm-ada', model: MODEL, problems: [] });
    expect(resolveChatDefault({ teammateId: 'tm-ada' }, ctx).skip).toBe(false);
    expect(resolveChatDefault({ model: MODEL }, ctx).skip).toBe(false);
    expect(resolveChatDefault(null, ctx)).toEqual({ skip: false, teammateId: null, model: null, problems: [] });
  });
  it('names a default that no longer resolves and keeps the part that does', () => {
    const r = resolveChatDefault({ teammateId: 'tm-ada', model: 'retired' }, ctx);
    expect(r).toMatchObject({ skip: false, teammateId: 'tm-ada', model: null });
    expect(r.problems).toEqual(['default model retired is no longer offered']);
    expect(resolveChatDefault({ teammateId: 'tm-gone', model: MODEL }, ctx).problems[0]).toMatch(/tm-gone is no longer in this space/);
  });
});
