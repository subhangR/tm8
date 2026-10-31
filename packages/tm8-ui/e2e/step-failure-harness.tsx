import { createRoot } from 'react-dom/client';
import { TurnParts } from '../src/chat-home/TurnParts';
import type { ChatTurnPart } from '../src/chat-home/types';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/chat-home/chat-home.css';

/**
 * PIXEL harness for "why are the chats failing" (task 01a19109-aaca).
 *
 * jsdom cannot tell us what Tharak actually saw: a phone screen where a turn
 * that ANSWERED FINE was bracketed by filled red boxes. This renders the two
 * shapes that matter through the shipping `TurnParts`, at phone width.
 *
 * The data is synthetic but structurally faithful to a real craft turn
 * measured on the live node (chat 5d7fc25c, 83 calls / 8 failures / 23 runs):
 * failures land in SEPARATE runs because a run is cut at every piece of
 * content, and each shell result opens with a bare `Exit code N` line that
 * hides the cause on the line below.
 *
 *   left  — a turn the agent recovered from and finished (the screenshot)
 *   right — a turn that actually died, which must still read as an alert
 */
let seq = 0;
const bash = (command: string, result: string, isError?: boolean): ChatTurnPart[] => {
  const id = `c${(seq += 1)}`;
  return [
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'Bash', args: { command, description: command }, state: 'running' },
    { seq: (seq += 1), kind: 'tool_result', toolCallId: id, content: result, ...(isError ? { isError: true } : {}) },
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'Bash', args: { command, description: command }, state: isError ? 'error' : 'completed' },
  ];
};
const say = (text: string): ChatTurnPart[] => [{ seq: (seq += 1), kind: 'text', text }];

/** Two identical shell failures, one run apart — exactly the screenshot. */
const recovered: ChatTurnPart[] = [
  ...say("I'll check the current files to confirm whether the redesign was implemented."),
  ...bash('gh pr list', 'Exit code 4\nTo get started with GitHub CLI, please run:  gh auth login', true),
  ...say('That needs auth. Reading the tree directly instead.'),
  ...bash('gh pr view 12', 'Exit code 4\nTo get started with GitHub CLI, please run:  gh auth login', true),
  ...say('Checking the local files.'),
  ...bash('ls src', 'App.tsx\nSidebar.tsx\nheader.tsx'),
  ...bash('rg Dashboard src', 'Exit code 1', true),
  ...say(
    '**Partially — the redesign was started, but it isn’t complete.** The local frontend contains a new sidebar, workspace navigation, and header.\n\nHowever, the app references a new dashboard component whose file is missing, so I can’t call it a working redesign.',
  ),
  { seq: (seq += 1), kind: 'done' },
];

/** The same failure in a turn that genuinely died — stays an alert (R7). */
const died: ChatTurnPart[] = [
  ...say('Running the suite.'),
  ...bash('bun test', 'Exit code 1\nFAIL packages/server/test/w5/sweep.test.ts', true),
  { seq: (seq += 1), kind: 'error', message: 'runtime exited' },
  { seq: (seq += 1), kind: 'done' },
];

const Pane = ({ title, parts }: { title: string; parts: ChatTurnPart[] }) => (
  <div style={{ width: 390, border: '1px solid #ddd', borderRadius: 12, overflow: 'hidden' }}>
    <div style={{ padding: '6px 12px', font: '600 12px system-ui', background: '#f6f6f6' }}>{title}</div>
    <div className="tch-thread" style={{ padding: 12 }}>
      <TurnParts parts={parts} />
    </div>
  </div>
);

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" style={{ display: 'flex', gap: 20, padding: 20, alignItems: 'flex-start', background: '#fff' }}>
    <Pane title="turn finished — handled steps" parts={recovered} />
    <Pane title="turn failed — real alert" parts={died} />
  </div>,
);
