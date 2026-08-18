import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './rich-input/rich-input.css';
import './chat-home/chat-home.css';
import { ChatHomeScreen } from './chat-home/ChatHomeScreen';
import { createChatHomeFixturePort } from './chat-home/fixtures';
import type { ChatModelOption } from './chat-home/types';
import type { CockpitStage } from './routes/types';
import './session-graph/session-graph.css';

/**
 * CHAT WAITING-MARKS SCRATCH HARNESS — same spirit as loader-dev.tsx and
 * terminal-dev.tsx: a gate-free mount of ONE surface so a browser can answer
 * what jsdom structurally cannot.
 *
 * This lane needs it for four questions, all of which jsdom answers "no
 * opinion" to because it loads no stylesheets and rasterizes nothing:
 *
 *   1. does the send button keep its footprint? The mark is 4:5 where the old
 *      spinner was 1:1, and the button's own comment promises the same size.
 *   2. does the mark READ at 11px and 16px, or is it a smudge?
 *   3. does it read on a BRAND-FILLED button, on both grounds? The mark's
 *      default ink is brand, which on that button would be invisible.
 *   4. what does it actually cost, sustained, with both marks turning? Boot
 *      mounts one mark for under a second. A chat turn runs for minutes.
 *
 * ALSO drives the Cockpit STAGES (fleet-UI lane): the harness holds `?stage=`
 * itself, so the two panes that are not entities can be looked at in a real
 * browser — which is the only place their layout, their status pills and the
 * graph's actual drawing can be judged.
 *
 * Usage: /chat-dev.html   (add ?theme=dark for the dark ground,
 *                          ?stage=fleet or ?stage=graph for a stage,
 *                          ?empty=1 for a space with no conversations)
 */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const SPACE_ID = '019f0000-0000-7000-8000-000000000090';

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  /* `?empty=1` gives a space with NO conversations — the new-thread state,
     where the composer is centred and a stage has to un-centre it. jsdom can
     assert the attribute; only a browser can show the layout. */
  const empty = params.get('empty') === '1';
  const { port } = useMemo(
    () => (empty ? createChatHomeFixturePort([]) : createChatHomeFixturePort()),
    [empty],
  );
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<CockpitStage | null>(
    params.get('stage') === 'fleet' ? 'fleet' : params.get('stage') === 'graph' ? 'graph' : null,
  );

  // The harness drives the surface into its streaming state the way a person
  // does — type, send — rather than faking a phase. A faked phase would prove
  // the mark renders under a prop nobody sets.
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="cv2-root"
      data-theme={theme}
      data-harness-ready={ready || undefined}
      style={{ background: 'var(--pn-paper)', height: '100vh' }}
    >
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        viewerName="Sam"
        stage={stage}
        onStageChange={setStage}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
