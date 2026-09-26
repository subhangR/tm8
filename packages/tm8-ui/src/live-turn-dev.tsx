import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './panels/honesty/honesty.css';
import './rich-input/rich-input.css';
import './chat-home/chat-home.css';
import './session-graph/session-graph.css';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './chat-home/ChatHomeScreen';
import { TranscriptDock } from './chat-home/LiveTurnStatus';
import type { TurnInProgress } from './chat-home/live-turn-status-model';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './chat-home/fixtures';
import type { ChatModelOption, ChatThreadDetail, ChatTurnItem, ChatTurnPart } from './chat-home/types';

/**
 * LIVE STATUS ROW SCRATCH HARNESS (lane 2) — chat-dev.tsx's spirit, one
 * question: what does the row under the conversation LOOK like in each phase,
 * and does it stay put while a real turn streams? jsdom loads no stylesheets,
 * so none of that is a vitest question.
 *
 *   /live-turn-dev.html            a real Send, then a scripted multi-step turn
 *                                  streamed through the fixture port's frames
 *   /live-turn-dev.html?gallery=1  every phase side by side, incl. stopped /
 *                                  failed / 90s-quiet, which the interim
 *                                  turn-in-progress feed cannot produce yet
 *   ?theme=dark                    the dark ground
 *   ?until=N                       stop the script after N frames
 */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const ROOT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const AGENT = '019f0000-0000-7000-8009-000000000001' as EntityId;

function lengthen(count: number): ChatThreadDetail {
  const base = CHAT_HOME_FIXTURE_THREAD;
  const turns = Array.from({ length: count }, (_, index) => {
    const turn = base.turns[index % base.turns.length]!;
    return {
      ...turn,
      messageId: `019f0000-0000-7000-8000-${String(900 + index).padStart(12, '0')}` as EntityId,
      body: `${index + 1}. ${turn.body}`,
    };
  });
  return { summary: base.summary, turns };
}

const BASH = { command: 'bun run build', description: 'Build the workspace' };
const CREATE = { operation: 'entities.create', body: { kind: 'task', title: 'Provider interface' } };
const READ = (id: string) => ({ operation: 'entities.get', params: { id } });

/** [delay ms after the previous frame, part] */
const SCRIPT: [number, ChatTurnItem][] = [
  [2500, { kind: 'tool_call', toolCallId: 'b1', name: 'Bash', args: BASH, state: 'running' }],
  [2500, { kind: 'tool_result', toolCallId: 'b1', content: 'built in 4.1s' }],
  [7000, { kind: 'tool_call', toolCallId: 'c1', name: 'mcp__tm8__tm8_act', args: CREATE, state: 'running' }],
  [1500, { kind: 'tool_result', toolCallId: 'c1', content: { entity: { id: '019f0000-0000-7000-8009-0000000000c1', kind: 'task', title: 'Provider interface' } } }],
  [4000, { kind: 'tool_call', toolCallId: 'r1', name: 'mcp__tm8__tm8_read', args: READ('a'), state: 'running' }],
  [300, { kind: 'tool_call', toolCallId: 'r2', name: 'mcp__tm8__tm8_read', args: READ('b'), state: 'running' }],
  [300, { kind: 'tool_call', toolCallId: 'r3', name: 'mcp__tm8__tm8_read', args: READ('c'), state: 'running' }],
  [4000, { kind: 'tool_result', toolCallId: 'r1', content: { entity: { id: '019f0000-0000-7000-8009-0000000000a1', kind: 'task', title: 'Docker provider' } } }],
  [200, { kind: 'tool_result', toolCallId: 'r2', content: { entity: { id: '019f0000-0000-7000-8009-0000000000a2', kind: 'task', title: 'gVisor sandbox' } } }],
  [200, { kind: 'tool_result', toolCallId: 'r3', content: { entity: { id: '019f0000-0000-7000-8009-0000000000a3', kind: 'doc', title: 'Container plan' } } }],
];

function LiveHarness({ until }: { until: number }) {
  const { port, controls } = useMemo(() => createChatHomeFixturePort([lengthen(12)]), []);
  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    // Send the way a person does — type, press Send — so the phase machine,
    // not the harness, decides what the row shows.
    timers.push(
      window.setTimeout(() => {
        const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the chat agent"]');
        if (!box) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(box, 'Plan the containers work and build it.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>('button[aria-label^="Send"], button.tch-send')?.click();
          let at = 0;
          SCRIPT.slice(0, until).forEach(([delay, part], seq) => {
            at += delay;
            timers.push(
              window.setTimeout(() => {
                if (cancelled) return;
                controls.emit({ type: 'chat.turn.delta', chatId: ROOT, messageId: AGENT, seq, part });
                document.body.dataset.frames = String(seq + 1);
              }, at),
            );
          });
        }, 200);
      }, 900),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [controls, until]);
  return <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} viewerName="Sam" />;
}

const T = Date.now();
const S = 1000;
const call = (seq: number, id: string, name: string, args: unknown, settled: boolean): ChatTurnPart[] => [
  { seq, kind: 'tool_call', toolCallId: id, name, args, state: 'running' },
  ...(settled ? [{ seq: seq + 1, kind: 'tool_result' as const, toolCallId: id, content: 'ok' }] : []),
];
const GALLERY: { label: string; turn: TurnInProgress; parts: ChatTurnPart[]; away?: number }[] = [
  { label: 'sending', turn: { phase: 'sending', chatId: null, messageId: null, startedAt: T, lastFrameAt: null }, parts: [] },
  { label: 'waiting', turn: { phase: 'waiting', chatId: ROOT, messageId: AGENT, startedAt: T - 14 * S, lastFrameAt: null }, parts: [] },
  { label: 'streaming · step running', turn: { phase: 'streaming', chatId: ROOT, messageId: AGENT, startedAt: T - 72 * S, lastFrameAt: T - S }, parts: [...call(1, 'b', 'Bash', BASH, true), ...call(3, 'c', 'mcp__tm8__tm8_act', CREATE, false)] },
  { label: 'streaming · between blocks, 40s quiet', turn: { phase: 'streaming', chatId: ROOT, messageId: AGENT, startedAt: T - 72 * S, lastFrameAt: T - 40 * S }, parts: call(1, 'b', 'Bash', BASH, true) },
  { label: 'streaming · 100s quiet (escalated)', turn: { phase: 'streaming', chatId: ROOT, messageId: AGENT, startedAt: T - 200 * S, lastFrameAt: T - 100 * S }, parts: call(1, 'b', 'Bash', BASH, true) },
  { label: 'streaming · reader scrolled up', turn: { phase: 'streaming', chatId: ROOT, messageId: AGENT, startedAt: T - 20 * S, lastFrameAt: T - 2 * S }, parts: call(1, 'b', 'Bash', BASH, false), away: 3 },
  { label: 'stopping', turn: { phase: 'stopping', chatId: ROOT, messageId: AGENT, startedAt: T - 30 * S, lastFrameAt: T - 3 * S }, parts: call(1, 'b', 'Bash', BASH, true) },
  { label: 'stopped', turn: { phase: 'stopped', chatId: ROOT, messageId: AGENT, startedAt: T - 72 * S, lastFrameAt: T - 10 * S, endedAt: T - 2 * S }, parts: [...call(1, 'b', 'Bash', BASH, true), ...call(3, 'c', 'Bash', BASH, true)] },
  { label: 'failed', turn: { phase: 'failed', chatId: ROOT, messageId: AGENT, startedAt: T - 72 * S, lastFrameAt: T - 5 * S, endedAt: T - 5 * S, error: 'Provider refused' }, parts: call(1, 'b', 'Bash', BASH, true) },
];

function Gallery() {
  return (
    <div style={{ padding: 24, display: 'grid', gap: 14, width: '100%', maxWidth: 760, margin: '0 auto' }}>
      {GALLERY.map((item) => (
        <section key={item.label} data-gallery={item.label}>
          <div style={{ font: '600 11px var(--pn-mono)', color: 'var(--pn-ink-3)', marginBottom: 4 }}>{item.label}</div>
          <TranscriptDock turn={item.turn} parts={item.parts} away={item.away !== undefined} unseen={item.away ?? 0} onJump={() => {}} />
        </section>
      ))}
      <section data-gallery="no turn · reader scrolled up">
        <div style={{ font: '600 11px var(--pn-mono)', color: 'var(--pn-ink-3)', marginBottom: 4 }}>no turn · reader scrolled up</div>
        <TranscriptDock turn={null} parts={null} away unseen={0} onJump={() => {}} />
      </section>
    </div>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  const until = Number.parseInt(params.get('until') ?? '', 10);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      className="cv2-root"
      data-theme={theme}
      data-harness-ready={ready || undefined}
      style={{ background: 'var(--pn-paper)', height: '100vh', display: 'flex', overflow: 'auto' }}
    >
      {params.get('gallery') === '1' ? <Gallery /> : <LiveHarness until={Number.isFinite(until) ? until : SCRIPT.length} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
