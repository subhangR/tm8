import { createRoot } from 'react-dom/client';
import { EmptyCenter } from '../src/views/EmptyCenter';
import { BoardScreen } from '../src/board/BoardScreen';
import { FilesExplorerScreen } from '../src/files-explorer';
import type { FilesExplorerPort, ExplorerRoot } from '../src/files-explorer';
import { ProjectsTrustScreen } from '../src/settings-governance/ProjectsTrustScreen';
import type { GateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/board/board.css';
import '../src/files-explorer/files-explorer.css';
import '../src/settings-governance/governance.css';

/**
 * ONBOARDING EMPTY STATES — a deterministic browser harness that forces each of
 * the four stuck tabs into the exact NEW-USER state (no sessions, no tasks, no
 * project) so the copy and CTAs can be photographed. Props are hand-built to
 * pin the empty branch; the fixture seam seeds data, which is the wrong state.
 */

// -- Board: a loaded, EMPTY board over a minimal GateData double -------------
const emptyBoardData = {
  spaceId: 'space-onboarding',
  seam: { commands: { createEntity: async () => ({ ok: true }) } },
  reconcileCommand: () => undefined,
  boardFor: () => () => ({ groups: [], nextCursor: null, limit: 50 }),
  detailOf: () => undefined,
  refetchDetail: () => undefined,
  members: [],
  rowsFor: () => () => [],
} as unknown as GateData;

// -- Files: a port with only the Library root, empty ------------------------
const libraryRoot: ExplorerRoot = { id: 'library', kind: 'library', label: 'Library', writable: true };
const noProjectPort: FilesExplorerPort = {
  roots: async () => [libraryRoot],
  list: async () => ({ entries: [], truncated: false }),
  downloadHref: () => null,
};

function Frame({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ font: '12px/1.4 ui-monospace, monospace', color: '#888', padding: '4px 2px' }}>{label}</div>
      <div
        className="cv2-root"
        style={{ width: 1440, height, display: 'flex', border: '1px solid #ccc', overflow: 'hidden' }}
      >
        {children}
      </div>
    </section>
  );
}

function Harness() {
  return (
    <div data-testid="harness-ready" style={{ padding: 20 }}>
      <Frame label="WORK — empty centre (no sessions, no tasks)" height={420}>
        <div data-testid="cap-work" style={{ flex: 1, display: 'flex' }}>
          <EmptyCenter
            rows={[]}
            liveIds={[]}
            livenessOf={() => 'not-running'}
            newTask={{ unavailable: null, create: () => undefined }}
            onStartTerminal={() => undefined}
          />
        </div>
      </Frame>

      <Frame label="BOARD — empty board (the New task control + first-run line)" height={420}>
        <div data-testid="cap-board" style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
          <BoardScreen
            data={emptyBoardData}
            viewerMemberId={null}
            onNotice={() => undefined}
            onOpenEntity={() => undefined}
          />
        </div>
      </Frame>

      <Frame label="FILES — no project linked (Library root only)" height={420}>
        <div data-testid="cap-files" style={{ flex: 1, display: 'flex' }}>
          <FilesExplorerScreen port={noProjectPort} />
        </div>
      </Frame>

      <Frame label="SETTINGS › PROJECTS — no linked projects" height={520}>
        <div data-testid="cap-projects" style={{ flex: 1, display: 'flex', overflow: 'auto' }}>
          <ProjectsTrustScreen spaceLabel="space · Onboarding Test" projects={{ phase: 'ready', value: [] }} />
        </div>
      </Frame>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
