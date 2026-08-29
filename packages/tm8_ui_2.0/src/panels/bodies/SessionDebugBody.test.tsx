// @vitest-environment jsdom
/**
 * The Debug journal surface.
 *
 * THE FIRST DESCRIBE IS THE POINT OF THIS FILE. The header stats and the table
 * columns were originally written from OPPOSITE perspectives — the header
 * showed `agentToCli` under a "tokens in" label while the table read from the
 * CLI's side — so the same quantity appeared as "in" in one place and "out" in
 * the other, and the headline number named the wrong direction. The direction
 * is the whole meaning of this surface, so it is pinned rather than trusted.
 *
 * The convention, once: EVERYTHING here is from the AGENT's perspective.
 *   cliToAgent → "into agent context"  (stdout+stderr; the LARGE number)
 *   agentToCli → "typed by agent"      (argv+stdin;   the SMALL number)
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SessionJournalPage,
  SessionJournalRecord,
  SessionLaunchRecord,
  SessionTranscriptPage,
} from '@tm8/contract';
import { SessionDebugBody } from './SessionDebugBody.js';
import type { Seam } from '../../data/seam.js';

const SESSION = '019fbc0a-2eb2-7992-8da8-c6a6467a3c9a';

function record(over: Partial<SessionJournalRecord> = {}): SessionJournalRecord {
  return {
    v: 1, seq: 0, sessionId: SESSION, spaceId: null, teamMemberId: null,
    pid: 4242, startedAt: '2026-08-01T14:22:07.114Z', durationMs: 214,
    command: { path: ['entity', 'get'], argv: ['entity', 'get', 'abc'], cwd: '/repo' },
    input: { stdinChars: 0 },
    output: { stdoutChars: 4000, stderrChars: 0, stdoutSample: 'x', stderrSample: '', truncated: false },
    calls: [],
    result: { exitCode: 0, error: null },
    // Deliberately lopsided and unmistakable: 7 typed, 1000 into context.
    tokens: { estimator: 'chars/4', agentToCli: 7, cliToAgent: 1000 },
    ...over,
  };
}

function page(over: Partial<SessionJournalPage> = {}): SessionJournalPage {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    totals: {
      invocations: 1, failed: 0,
      agentToCliEst: 7, cliToAgentEst: 1000,
      estimator: 'chars/4', malformed: 0,
    },
    records: [record()],
    hasMore: false,
    ...over,
  };
}

const SYSTEM_PROMPT = '<tm8_system_prompt>you are Draco, the PTY engineer</tm8_system_prompt>';
const TASK_PROMPT = '<tm8_task_prompt count="1">Fix the resize race</tm8_task_prompt>';

function launched(over: Partial<SessionLaunchRecord> = {}): SessionLaunchRecord {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    manifest: {
      manifestVersion: '1',
      sessionId: SESSION,
      spaceId: '019fb748-0068-76dc-9869-1bb36133c554',
      generatedAt: '2026-08-01T14:20:00.000Z',
      mode: 'worker',
      baseUrl: 'http://127.0.0.1:7778',
      agent: { teamMemberId: 'tm-1', name: 'Draco', role: 'PTY engineer', identity: 'a one-bug brief' },
      launch: {
        tool: 'claude-code',
        model: 'opus',
        permissionMode: 'acceptEdits',
        accessMode: 'workspace-write',
        reasoningEffort: null,
        commandNetwork: { mode: 'loopback-proxy', allowedHosts: ['127.0.0.1', 'localhost'] },
        command: "claude --permission-mode acceptEdits --model 'opus'",
      },
      session: { title: 'Fix the resize race', workingDirectory: '/work/tm8', workdirMode: 'project' },
      project: { id: 'pr-1', name: 'tm8', workingDir: '/work/tm8', trust: 'trusted' },
      interactionProfile: { templateKey: 'tm8.chat.core', templateVersion: 1, source: 'core_default' },
      tasks: [{ id: 'tk-1', title: 'Fix the resize race' }],
    },
    envVarNames: ['TM8_BASE_URL', 'TM8_SESSION_ID', 'TM8_AGENT_TOKEN'],
    prompts: { system: SYSTEM_PROMPT, task: TASK_PROMPT, unavailableReason: null },
    recordedAt: '2026-08-01T14:20:00.000Z',
    ...over,
  };
}

function spoken(over: Partial<SessionTranscriptPage> = {}): SessionTranscriptPage {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    agentTool: 'claude-code',
    entries: [
      { at: '2026-08-01T14:21:00.000Z', source: 'user', text: 'Fix the resize race.', truncated: false },
      { at: '2026-08-01T14:21:40.000Z', source: 'assistant', text: 'Reading the PTY resize path.', truncated: false },
    ],
    stats: {
      partial: true,
      userMessages: 1, assistantMessages: 1, toolCalls: 3,
      inputTokens: 4820, outputTokens: 640,
      cacheReadTokens: 18200, cacheCreationTokens: 1100,
      tools: [{ name: 'Read', count: 3 }],
      models: ['claude-opus-4-6'],
    },
    stuck: null,
    lastActivityAt: '2026-08-01T14:21:40.000Z',
    malformed: 0,
    ...over,
  };
}

function seamWith(
  p: SessionJournalPage,
  l: SessionLaunchRecord = launched(),
  t: SessionTranscriptPage = spoken(),
): Seam {
  return {
    journal: vi.fn().mockResolvedValue(p),
    launch: vi.fn().mockResolvedValue(l),
    transcript: vi.fn().mockResolvedValue(t),
  } as unknown as Seam;
}

describe('direction is stated from the agent’s perspective, everywhere', () => {
  it('shows the LARGE number as into-context and the SMALL one as typed', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');

    // The big number must sit with the into-context label, not the typed one.
    const intoCtx = within(header).getByText(/into agent context/i).closest('.pn-debug__stat');
    const typed = within(header).getByText(/typed by agent/i).closest('.pn-debug__stat');
    expect(intoCtx?.textContent).toContain('1.0k');
    expect(typed?.textContent).toContain('7');
    // And the inversion this test exists to catch: 7 must NOT be the
    // into-context figure.
    expect(intoCtx?.textContent).not.toMatch(/\b7\b/);
  });

  it('orders the row cells the same way the columns are labelled', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const table = await screen.findByTestId('session-debug-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent ?? '');

    const tokCtxCol = headers.findIndex((h) => h.includes('~tok →ctx'));
    const tokTypedCol = headers.findIndex((h) => h.includes('~tok typed'));
    expect(tokCtxCol).toBeGreaterThan(-1);
    expect(tokTypedCol).toBeGreaterThan(-1);
    expect(cells[tokCtxCol]).toContain('1.0k'); // cliToAgent
    expect(cells[tokTypedCol]).toContain('7');   // agentToCli
  });
});

describe('honesty', () => {
  it('never prints a bare token number — every one carries ~ and names the estimator', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');
    for (const stat of Array.from(header.querySelectorAll('.pn-debug__stat'))) {
      const label = stat.textContent ?? '';
      if (!/tok/i.test(label)) continue;
      expect(label).toContain('~');
      expect(label).toContain('chars/4');
    }
  });

  it('permanently states the CLI boundary and that this is not a shell history', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const note = await screen.findByTestId('session-debug-boundary');
    expect(note.textContent).toMatch(/CLI boundary only/i);
    expect(note.textContent).toMatch(/not a shell history/i);
    expect(note.textContent).toMatch(/never the model’s reported usage/i);
  });

  it('renders an EXPLAINED empty when there is no journal — not a zero', async () => {
    const p = page({
      available: false,
      unavailableReason: 'no_journal_file',
      records: [],
      totals: { invocations: 0, failed: 0, agentToCliEst: 0, cliToAgentEst: 0, estimator: 'chars/4', malformed: 0 },
    });
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);

    const empty = await screen.findByTestId('session-debug-empty');
    expect(empty.textContent).toMatch(/journal/i);
    // The failure mode being guarded: a confident "0 commands" table.
    expect(screen.queryByTestId('session-debug-table')).toBeNull();
  });

  it('surfaces malformed records rather than dropping them silently', async () => {
    const p = page();
    p.totals.malformed = 3;
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);
    const header = await screen.findByTestId('session-debug-header');
    expect(header.textContent).toMatch(/malformed/i);
    expect(header.textContent).toContain('3');
  });

  it('marks a truncated sample and still shows the exact character count', async () => {
    const p = page({
      records: [record({
        output: { stdoutChars: 50_000, stderrChars: 0, stdoutSample: 'z'.repeat(20), stderrSample: '', truncated: true },
      })],
    });
    render(<SessionDebugBody seam={seamWith(p)} sessionId={SESSION} live={false} />);
    const table = await screen.findByTestId('session-debug-table');
    within(table).getAllByRole('button', { name: /expand/i })[0]!.click();
    await waitFor(() => expect(screen.getByTestId('session-debug-truncated')).toBeTruthy());
    expect(screen.getByTestId('session-debug-detail').textContent).toContain('50000');
  });
});

/**
 * WHAT THE SESSION WAS TOLD.
 *
 * The journal answers "what did this agent do". These pin the other half: the
 * bytes it was GIVEN at spawn. The two facts most worth guarding are that the
 * prompts shown are the STORED ones (so they cannot drift from what was sent)
 * and that the two dead ends — no manifest row at all, versus a manifest
 * written before prompts were captured — stay distinguishable.
 */
describe('spawn configuration', () => {
  it('shows the prompt bytes that were actually sent, on both channels', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    expect((await screen.findByTestId('session-debug-system-prompt')).textContent).toBe(SYSTEM_PROMPT);
    expect(screen.getByTestId('session-debug-task-prompt').textContent).toBe(TASK_PROMPT);
  });

  it('shows the spawn-time configuration: teammate, launch posture, workdir, project, profile', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const fields = (await screen.findByTestId('session-debug-launch-fields')).textContent ?? '';
    for (const fact of [
      'Draco', 'PTY engineer', 'worker', 'claude-code', 'opus', 'acceptEdits',
      'workspace-write', 'loopback-proxy', '/work/tm8', '(project)', 'tm8', '(trusted)',
      'tm8.chat.core', '(core_default)', 'http://127.0.0.1:7778',
    ]) {
      expect(fields).toContain(fact);
    }
    // …and the whole document is still reachable, so a field this grid does not
    // know about is visible rather than swallowed.
    expect(screen.getByTestId('session-debug-raw-manifest').textContent).toContain('manifestVersion');
  });

  it('lists environment variable NAMES and says the values are never recorded', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const section = await screen.findByTestId('session-debug-launch');
    expect(section.textContent).toContain('TM8_AGENT_TOKEN');
    // S15: their absence must read as structural, not as a display choice.
    expect(section.textContent).toMatch(/values are never recorded/i);
  });

  it('keeps "no manifest row" and "prompts not recorded" as two DIFFERENT explained empties', async () => {
    const noRow = seamWith(page(), launched({
      available: false,
      unavailableReason: 'no_manifest_row',
      manifest: null,
      envVarNames: [],
      prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
      recordedAt: null,
    }));
    const { unmount } = render(<SessionDebugBody seam={noRow} sessionId={SESSION} live={false} />);
    const missing = await screen.findByTestId('session-debug-launch-empty');
    expect(missing.textContent).toMatch(/no manifest was recorded/i);
    expect(screen.queryByTestId('session-debug-launch-fields')).toBeNull();
    unmount();

    const oldRow = seamWith(page(), launched({
      prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
    }));
    render(<SessionDebugBody seam={oldRow} sessionId={SESSION} live={false} />);
    const stale = await screen.findByTestId('session-debug-prompts-empty');
    expect(stale.textContent).toMatch(/before launch prompts were captured/i);
    // The manifest it DOES have is still shown — a prompt gap is not a spawn gap.
    expect(screen.getByTestId('session-debug-launch-fields')).toBeTruthy();
    expect(screen.queryByTestId('session-debug-system-prompt')).toBeNull();
  });

  it('a failed launch read does not blank the journal, and vice versa', async () => {
    const seam = {
      journal: vi.fn().mockResolvedValue(page()),
      launch: vi.fn().mockRejectedValue(new Error('launch read exploded')),
      transcript: vi.fn().mockResolvedValue(spoken()),
    } as unknown as Seam;
    render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
    const err = await screen.findByTestId('session-debug-launch-error');
    expect(err.textContent).toMatch(/launch read exploded/i);
    expect(screen.getByTestId('session-debug-table')).toBeTruthy();
  });
});

/**
 * WHAT THE AGENT SAID — the third face, read from the agent's own native JSONL.
 *
 * These pin the honesty rules that make the section safe to read, because each
 * one is a claim the data cannot support if it is stated carelessly: a tail's
 * token count is not a session's spend, a stuck heuristic is not a liveness
 * verdict, and a missing transcript is a real and common state rather than a
 * session that said nothing.
 */
describe('the agent transcript section', () => {
  it('renders the agent’s own turns, oldest-first as the server sends them', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const turns = await screen.findByTestId('session-debug-turns');
    // `.tr-turn`, not `.pn-debug__turn`: the turns render through the SHARED
    // TranscriptTurns component that the session panel's Transcript surface
    // also mounts, so the two cannot disagree about what the agent said.
    const texts = [...turns.querySelectorAll('.tr-turn')].map((n) => n.textContent ?? '');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/Fix the resize race/);
    expect(texts[1]).toMatch(/Reading the PTY resize path/);
  });

  // The counts describe the WINDOW. Presenting a tail's tokens as a session's
  // spend is the exact dishonesty `partial` exists to prevent.
  it('says the counts cover only the window when the read was partial', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    const note = await screen.findByTestId('session-debug-transcript-boundary');
    expect(note.textContent).toMatch(
      /only the newest part of the transcript that was read, not the whole session/i,
    );
    // …and states that tool bodies are structurally absent, so their absence
    // cannot read as a display choice someone could ask to have turned on.
    expect(note.textContent).toMatch(/tool arguments and tool output are never returned/i);
  });

  it('says the counts cover everything when the whole file fit', async () => {
    const whole = spoken();
    const seam = seamWith(page(), launched(), spoken({
      stats: whole.stats === null ? null : { ...whole.stats, partial: false },
    }));
    render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
    const note = await screen.findByTestId('session-debug-transcript-boundary');
    expect(note.textContent).toMatch(/entire session/i);
  });

  // A stuck badge that read as a verdict would be a claim over a heuristic.
  it('reports stuck as a heuristic with its raw numbers, deferring to liveness', async () => {
    const seam = seamWith(page(), launched(), spoken({
      stuck: { silentMs: 420_000, toolCallsSinceText: 9 },
    }));
    render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
    const stuck = await screen.findByTestId('session-debug-transcript-stuck');
    expect(stuck.textContent).toMatch(/9 tool calls/);
    expect(stuck.textContent).toMatch(/420s/);
    expect(stuck.textContent).toMatch(/heuristic/i);
    expect(stuck.textContent).toMatch(/liveness/i);
  });

  it('never renders a stuck badge when the heuristic does not fire', async () => {
    render(<SessionDebugBody seam={seamWith(page())} sessionId={SESSION} live={false} />);
    await screen.findByTestId('session-debug-turns');
    expect(screen.queryByTestId('session-debug-transcript-stuck')).toBeNull();
  });

  // Four distinct dead ends, four distinct sentences: collapsing them would
  // misattribute a data-model gap to an agent that produced nothing.
  it.each([
    ['no_native_session_id', /cannot be identified/i],
    ['unsupported_agent_tool', /no transcript tm8 can read/i],
    ['no_transcript_file', /has not written its first turn/i],
    ['unreadable', /could not be read/i],
  ] as const)('explains %s rather than showing an empty conversation', async (reason, matcher) => {
    const seam = seamWith(page(), launched(), spoken({
      available: false, unavailableReason: reason, agentTool: null, stats: null, entries: [],
    }));
    render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
    const empty = await screen.findByTestId('session-debug-transcript-empty');
    expect(empty.textContent).toMatch(matcher);
    expect(screen.queryByTestId('session-debug-turns')).toBeNull();
  });

  it('a failed transcript read does not blank the journal', async () => {
    const seam = {
      journal: vi.fn().mockResolvedValue(page()),
      launch: vi.fn().mockResolvedValue(launched()),
      transcript: vi.fn().mockRejectedValue(new Error('transcript read exploded')),
    } as unknown as Seam;
    render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
    const err = await screen.findByTestId('session-debug-transcript-error');
    expect(err.textContent).toMatch(/transcript read exploded/i);
    expect(screen.getByTestId('session-debug-table')).toBeTruthy();
  });
});

describe('polling', () => {
  it('reads once and does NOT poll a session that is not live', async () => {
    vi.useFakeTimers();
    try {
      const seam = seamWith(page());
      render(<SessionDebugBody seam={seam} sessionId={SESSION} live={false} />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((seam.journal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      // The transcript grows like the journal does, so it obeys the same rule:
      // an exited session's transcript is finished, and polling it is waste.
      expect((seam.transcript as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A launch record is written once at spawn and can never change, so re-reading
  // it every 5s would ship a whole manifest to learn nothing.
  it('never polls the launch record, even while the session is live', async () => {
    vi.useFakeTimers();
    try {
      const seam = seamWith(page());
      render(<SessionDebugBody seam={seam} sessionId={SESSION} live />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((seam.journal as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
      expect((seam.transcript as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
      expect((seam.launch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
