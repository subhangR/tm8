import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import { ChatHomeScreen, type HomeRootOption } from '../src/chat-home/ChatHomeScreen';
import { createChatHomeFixturePort, CHAT_HOME_FIXTURE_THREAD } from '../src/chat-home/fixtures';
import type { ChatModelOption } from '../src/chat-home/types';
import { EntityListPanel, ListViewSwitcher } from '../src/panels';
import { getKind, CHATS_ROOT, type CollectionMode } from '../src/domain';
import type { HomeRoot } from '../src/stores/homeRegionStore';
import { useGateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/chat-home/chat-home.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR HOME'S LEFT-COLUMN HEADER.
 *
 * The deliverable this exists for is COUNTED IN ROWS: the header used to
 * stack five (root tabs · kind selector · search · lifecycle tiers · filters)
 * and now stacks four, because the kind selector restated the kind the root
 * tabs already name. "Four rows" is a claim about `getBoundingClientRect().top`
 * — how many distinct line bands the controls occupy — and jsdom has no layout
 * engine, so the whole vitest suite can prove only that each CONTROL exists.
 * Whether they share a line is answerable only here.
 *
 * It is also where the WIDTH argument gets checked. Home's column is
 * `minmax(210px, 280px)` (chat-home.css), so `?w=` mounts the column at a
 * given width and the measure script sweeps the range. The proposal that
 * started this work wanted search and the lifecycle tabs on ONE row; the tabs
 * measure ~207px natural, which is the entire column at its floor, and that
 * number came from this harness rather than from an opinion.
 *
 * The header is the REAL `ChatHomeScreen` over the fixture chat port, hosting
 * the REAL `EntityListPanel` over the fixture seam — the same two components
 * the app mounts, so what Playwright measures is the shipping pair under the
 * shipping stylesheet.
 */
const MODELS: ChatModelOption[] = [
  {
    model: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    provider: 'Anthropic',
    agentTool: 'claude-code',
  },
];

const ROOT_OPTIONS: HomeRootOption[] = [
  { kind: 'task', label: 'Tasks', single: 'Task' },
  { kind: 'work_session', label: 'Sessions', single: 'Session' },
  { kind: 'doc', label: 'Docs', single: 'Doc' },
];

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const auto = params.get('w') === 'auto';
  const width = auto ? 0 : Number(params.get('w') ?? '280');
  const kind = params.get('kind') ?? 'task';
  /* `?legacy=1` mounts the arrangement this task replaced: the panel draws its
     OWN kind-selector row and the header line has no switcher. Keeping both
     arrangements in one build makes the before/after a real control — the
     alternative is measuring two checkouts and hoping nothing else moved. */
  const legacy = params.get('legacy') === '1';

  const seam = useMemo(() => createFixtureSeam(), []);
  const { port } = useMemo(() => createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]), []);
  const data = useGateData({ leftKind: kind, rightKind: 'task', seam });

  const [root, setRoot] = useState<HomeRoot>(kind);
  /* The same lift HomeView performs: the switcher is in the header and the
     body is in the column, so the value lives above both. */
  const [modeByKind, setModeByKind] = useState<Readonly<Record<string, CollectionMode>>>({});
  const modeFor = useCallback(
    (k: string): CollectionMode => modeByKind[k] ?? getKind(k).defaultMode,
    [modeByKind],
  );

  const renderRootAside = useCallback(
    (listRoot: HomeRoot): ReactNode =>
      listRoot === CHATS_ROOT || legacy ? null : (
        <ListViewSwitcher
          config={getKind(listRoot)}
          mode={modeFor(listRoot)}
          onMode={(next) => setModeByKind((prev) => ({ ...prev, [listRoot]: next }))}
        />
      ),
    [modeFor, legacy],
  );

  const renderRootList = useCallback(
    (listRoot: HomeRoot): ReactNode => {
      if (listRoot === CHATS_ROOT || !data.ready) return null;
      return (
        <EntityListPanel
          kind={listRoot}
          selectorSlot={legacy ? 'panel' : 'host'}
          mode={modeFor(listRoot)}
          onMode={(next) => setModeByKind((prev) => ({ ...prev, [listRoot]: next }))}
          rowsFor={data.rowsFor(listRoot)}
          pageStateOf={data.pageStateOf(listRoot)}
          loadMore={data.loadMore(listRoot)}
          boardFor={data.boardFor(listRoot) as never}
          members={data.members}
          ctx={{ viewerActorId: undefined }}
          compact
        />
      );
    },
    [data, modeFor, legacy],
  );

  if (!data.ready) return <div data-testid="harness-booting">booting…</div>;

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ position: 'fixed', inset: 0, display: 'flex' }}
    >
      {/* The column at an EXPLICIT width, standing in for the Home grid's
          `minmax(210px, 280px)` track — a fixed width is what lets the sweep
          ask "what would this row do at 210?" without needing a viewport that
          produces 210.

          `?w=auto` drops the clamp so `.tch-root`'s own grid sizes the column
          against the viewport. That arm answers a different and prior
          question: which widths in `minmax(210px, 280px)` the layout ACTUALLY
          produces. A row that only breaks at a width the app never renders is
          a different finding from one that breaks in front of users. */}
      <div
        style={
          auto
            ? { flex: 1, minWidth: 0, display: 'flex', height: '100%' }
            : { width, minWidth: width, maxWidth: width, display: 'flex', height: '100%' }
        }
        data-testid="home-column"
      >
        <ChatHomeScreen
          port={port}
          spaceId={data.spaceId}
          models={MODELS}
          root={root}
          onRoot={setRoot}
          kindCell={ROOT_OPTIONS.find((o) => o.kind === kind) ?? ROOT_OPTIONS[0]!}
          rootKindOptions={ROOT_OPTIONS}
          renderRootList={renderRootList}
          renderRootAside={renderRootAside}
          onNewEntity={() => {}}
          newEntityUnavailable={null}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
