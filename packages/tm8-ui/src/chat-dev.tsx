import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './rich-input/rich-input.css';
import './chat-home/chat-home.css';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './chat-home/ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './chat-home/fixtures';
import type { ChatModelOption, ChatThreadDetail } from './chat-home/types';
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
 *                          ?empty=1 for a space with no conversations,
 *                          ?shell=mobile for the phone arrangement,
 *                          ?turns=N for a thread long enough to overflow)
 *
 * `?shell=mobile` + `?turns=N` are what the TRANSCRIPT SCROLL questions need,
 * and they are the two facts jsdom cannot supply between them: the phone rules
 * are all scoped `.cv2-root[data-shell='mobile']`, and a scroller only
 * misbehaves once its content EXCEEDS it. The 3-turn fixture fits inside a
 * 844px phone, so every scroll defect is invisible at the default length.
 */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const SPACE_ID = '019f0000-0000-7000-8000-000000000090';

/** The fixture thread with its turns repeated until there are `count` of them,
 *  ids kept unique so React keys and the turn model stay honest. */
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

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  /* `?empty=1` gives a space with NO conversations — the new-thread state,
     where the composer is centred and a stage has to un-centre it. jsdom can
     assert the attribute; only a browser can show the layout. */
  const empty = params.get('empty') === '1';
  const mobile = params.get('shell') === 'mobile';
  const turns = Number.parseInt(params.get('turns') ?? '', 10);
  const { port } = useMemo(
    () =>
      empty
        ? createChatHomeFixturePort([])
        : Number.isFinite(turns) && turns > 0
          ? createChatHomeFixturePort([lengthen(turns)])
          : createChatHomeFixturePort(),
    [empty, turns],
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
      /* The phone rules key on this attribute and nothing else — `MobileShell`
         does not have to be in the tree for them to apply, which is what makes
         a one-surface harness a fair reading of the phone's chat. */
      data-shell={mobile ? 'mobile' : undefined}
      data-harness-ready={ready || undefined}
      /* A FLEX COLUMN, because `.tch-root` is `flex: 1` with no height of its
         own. Left as a plain block this host would size the grid to its
         CONTENT — the transcript would never overflow, `scrollHeight` would
         equal `clientHeight`, and every scroll question would read as "fine"
         on a surface that has no scroller at all. That is the exact trap
         `.mobile-frame__content` documents one layer down in chat-home.css. */
      style={{ background: 'var(--pn-paper)', height: '100vh', display: 'flex' }}
    >
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        viewerName="Sam"
        stage={stage}
        onStageChange={setStage}
        {...(mobile ? { soloConversation: true as const } : {})}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
