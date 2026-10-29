// @vitest-environment jsdom
/**
 * The UI create flow over the REAL loops client (loops PR6, design 01a182d4
 * §6): the list, New loop, the pickers and the server's preview, Create, the
 * new row. The transport records every catalog call, and the create body is
 * held to the contract's own `LoopCreateInputSchema`, so what the form sends
 * is what the server accepts — not merely what a stub client was handed.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  LoopCreateInputSchema,
  LoopSchedulePreviewInputSchema,
  type EntitySummary,
  type LoopCreateInput,
  type LoopView,
  type OperationName,
  type SpaceId,
} from '@tm8/contract';
import type { HttpClient, RequestOptions } from '../data/real/http';
import { createLoopsClient } from './api';
import { fixtureLoopView } from './fixture';
import { LoopsList } from './LoopsList';
import type { LoopFormSources } from './sources';

afterEach(cleanup);

const SPACE = '019fe999-0000-7000-8000-00000000c100' as SpaceId;
const ADA = '019fe999-0000-7000-8000-00000000c101';
const LOOP = '019fe999-0000-7000-8000-00000000c102';

function recordingServer() {
  const calls: { op: OperationName; options: RequestOptions }[] = [];
  let created: LoopView | null = null;
  const answer = (op: OperationName, options: RequestOptions): unknown => {
    switch (op) {
      case 'loops.list': return { items: created ? [created] : [], nextCursor: null };
      case 'loops.schedule.preview': {
        const body = LoopSchedulePreviewInputSchema.parse(options.body);
        return { valid: true, problem: null, summary: `Weekdays at 09:00 ${body.timezone ?? 'UTC'}`, next: ['2026-11-02T09:00:00.000Z'] };
      }
      case 'loops.create': {
        const input = LoopCreateInputSchema.parse(options.body) as LoopCreateInput;
        created = fixtureLoopView(LOOP, SPACE, { ...input.definition, retry: input.definition.retry ?? {} }, {
          schedule: { valid: true, problem: null, summary: `Weekdays at 09:00 ${input.definition.timezone}`, next: [] },
        });
        return created;
      }
      case 'loops.get': return created;
      default: throw new Error(`unexpected ${op}`);
    }
  };
  const http = { call: vi.fn(async (op: OperationName, options: RequestOptions = {}) => {
    calls.push({ op, options });
    return answer(op, options);
  }) } as unknown as HttpClient;
  return { http, calls };
}

const sources: LoopFormSources = {
  query: (async (input: { kinds?: string[] }) => ({
    page: { items: input.kinds?.[0] === 'team_member' ? [{ id: ADA, kind: 'team_member', title: 'Ada' } as unknown as EntitySummary] : [], nextCursor: null },
  })) as never,
  entity: (async (id: string) => ({ id, title: id === ADA ? 'Ada' : 'Entity', state: { kind: 'team_member' } })) as never,
  projects: (async () => []) as never,
};

it('a human creates a loop through the list, and the server accepts exactly what the form sent', async () => {
  const { http, calls } = recordingServer();
  const onOpen = vi.fn();
  render(<div className="cv2-root"><LoopsList spaceId={SPACE} client={createLoopsClient(http)} sources={sources} onOpen={onOpen} /></div>);
  expect(await screen.findByTestId('loops-empty')).toBeTruthy();

  fireEvent.click(screen.getByTestId('loop-new'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning triage' } });
  fireEvent.click(screen.getByTestId('loop-teammate'));
  fireEvent.click(await screen.findByTestId(`loop-teammate-${ADA}`));
  fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'weekdays' } });
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Europe/London' } });
  // The preview is the server's: asked through loops.schedule.preview, drawn as it answered.
  await waitFor(() => expect(screen.getByTestId('loop-schedule-summary').textContent).toBe('Weekdays at 09:00 Europe/London'));
  expect(calls.some(call => call.op === 'loops.schedule.preview'
    && (call.options.body as { schedule: string; timezone: string }).schedule === '0 9 * * 1-5'
    && (call.options.body as { timezone: string }).timezone === 'Europe/London')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Create loop' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(LOOP));

  const create = calls.find(call => call.op === 'loops.create')!;
  expect(create.options.params).toEqual({ spaceId: SPACE });
  // Strict: an unknown key in the body would have thrown in the recording server.
  const body = LoopCreateInputSchema.parse(create.options.body);
  expect(body).toMatchObject({
    spaceId: SPACE, enabled: true, clientMutationId: expect.stringMatching(/^au-/),
    definition: { title: 'Morning triage', schedule: '0 9 * * 1-5', timezone: 'Europe/London', action: 'spawn', teamMemberId: ADA },
  });
  // The browser computed nothing a server owns.
  expect(JSON.stringify(body)).not.toMatch(/nextRunAt/);

  // The list re-reads and draws the new row from the server's view.
  const row = await screen.findByTestId(`loop-row-${LOOP}`);
  expect(row.textContent).toContain('Morning triage');
  expect(row.textContent).toContain('Weekdays at 09:00 Europe/London');
  await waitFor(() => expect(row.textContent).toContain('Ada'));
});
