import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
/* `panels/index.ts` is what imports this in the app, and this harness reaches
   past the index for `panels.css` alone — so the refused-attach control in the
   composer foot rendered UNSTYLED here and measured 50px against a 44px floor
   that is not actually broken. A deep-path import drops the sheet; the module's
   own index is the only thing that carries it. */
import './panels/honesty/honesty.css';
import './rich-input/rich-input.css';
/* THE PHONE'S ZOOM GATE. `app.css` puts `zoom: 1.1` on `.cv2-root` and
   `mobile-chrome.css` declines it for `[data-shell='mobile']` — so a harness
   that sets the attribute but never loads that file renders the phone at 1.1
   and every rect it reports is 10% too big (44px controls measured 48.4). The
   rest of the file names `.mobile-*` classes this harness does not mount. */
import './mobile/mobile-chrome.css';
import './chat-home/chat-home.css';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './chat-home/ChatHomeScreen';
import { MobileSurfaceProvider } from './mobile';
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
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'claude-opus-5', label: 'Claude Opus 5', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'gpt-5.6-sol', label: 'OpenAI GPT 5.6', provider: 'OpenAI', agentTool: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
/* The composer redesign's roster: roles and standing permissions, so the
   orchestrate filter, the crew panel and the derived ceiling all have
   something to show (`?composer=1` also lists a project). */
const COMPOSER_TEAMMATES = [
  { id: '019f0000-0000-7000-8000-00000000a001' as EntityId, label: 'Builder', avatar: null, mode: 'worker' as const, permissionMode: null },
  { id: '019f0000-0000-7000-8000-00000000a002' as EntityId, label: 'Conductor', avatar: null, mode: 'coordinator' as const, permissionMode: 'acceptEdits' },
  { id: '019f0000-0000-7000-8000-00000000a003' as EntityId, label: 'Fast Fixer', avatar: null, mode: 'worker' as const, permissionMode: 'plan' },
  { id: '019f0000-0000-7000-8000-00000000a004' as EntityId, label: 'Codex Worker', avatar: null, mode: 'worker' as const, permissionMode: null },
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
  const composer = params.get('composer') === '1';
  const { port } = useMemo(
    () => {
      const base = empty
        ? createChatHomeFixturePort([])
        : Number.isFinite(turns) && turns > 0
          ? createChatHomeFixturePort([lengthen(turns)])
          : createChatHomeFixturePort();
      if (!composer) return base;
      return {
        ...base,
        port: {
          ...base.port,
          listTeammates: async () => COMPOSER_TEAMMATES,
          listProjects: async () => [
            { id: '019f0000-0000-7000-8000-00000000b001' as EntityId, name: 'tm8-web' },
            { id: '019f0000-0000-7000-8000-00000000b002' as EntityId, name: 'tm8' },
          ],
        },
      };
    },
    [empty, turns, composer],
  );
  const [ready, setReady] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
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
         `.mobile-frame__content` documents one layer down in chat-home.css.

         THE TOUCH TOKENS ARE PUBLISHED HERE, and without them this harness
         quietly lies. `--mobile-touch-min` is declared on `.mobile-frame`
         (mobile/mobile.css), which a one-surface harness does not mount — so
         every DEF-026 rule in chat-home.css resolves its `var()` to nothing and
         is DROPPED. Measured before this line: the pick triggers read 23.4px
         against a 44px floor the stylesheet plainly sets. The attribute alone
         is not the phone; the attribute plus the frame's tokens is. */
      style={{
        background: 'var(--pn-paper)',
        height: '100vh',
        display: 'flex',
        ...(mobile
          ? ({
              '--mobile-touch-min': '44px',
              '--mobile-keyboard-inset': '0px',
              '--mobile-safe-bottom': '0px',
            } as React.CSSProperties)
          : {}),
      }}
      ref={setHost}
    >
      {/* THE PHONE'S SURFACE CONTEXT, and this harness was wrong without it.
          `oneSurface` is what `ComposerSelect` reads to draw its options in a
          sheet rather than the desktop's anchored popover, and what
          `EntityTray` reads to draw no chips — so `?shell=mobile` alone was
          rendering the DESKTOP arrangement of both, under the phone's CSS.
          `MobileShell` is the only production provider; this stands in for it
          and for nothing else. `sheetHost` is this root, which is what the
          frame's sheet host is a stand-in for too.

          MOUNTED ONLY ON THE PHONE BRANCH, and the provider's own docblock is
          why: `oneSurface` is hard-coded `true` there, deliberately, so
          wrapping the desktop tree in it "to keep one shape" hands the desktop
          the phone's arrangement. It did, for one run — the desktop tray
          measured 0 chips. */}
      {mobile ? (
        <MobileSurfaceProvider sheetHost={host}>
          <ChatHomeScreen
            port={port}
            spaceId={SPACE_ID}
            models={MODELS}
            viewerName="Sam"
            /* THE STAGES ARE A DESKTOP SEAM. `MobileShell` mounts
               `ChatHomeSurface` with no `onStageChange` and no `onShowChat`, so
               a harness that passes them draws Fleet/Graph tabs the phone has
               never had — and any measurement of the tray then describes a row
               no reader sees. */
            soloConversation
          />
        </MobileSurfaceProvider>
      ) : (
        <ChatHomeScreen
          port={port}
          spaceId={SPACE_ID}
          models={MODELS}
          viewerName="Sam"
          stage={stage}
          onStageChange={setStage}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
