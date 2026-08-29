/**
 * THE REVIEW BOARD — dev-only, never product. Both frames, both themes, the
 * annotation band on, so the user can put this beside the oracle and diff.
 *
 * Precedent: `auth/AuthBoard.tsx` and `settings-space/SettingsBoard.tsx`. The
 * `data-theme` attribute here is a dev tool on a dev page; D1 keeps a theme
 * SWITCH out of product chrome, and this is not product chrome.
 *
 * The board is also where the states no real seam can reach get shown at all:
 * the upload queue's three phases, the missing-bytes row, the degraded and
 * cold node. That is its job — a state you cannot see is a state nobody
 * reviews.
 */
import type { ReactNode } from 'react';
import { FilesScreen } from './FilesScreen';
import { NodeRoom } from './NodeRoom';
import { staticNodePort } from './port';
import {
  SPECIMEN_ATTACHED,
  SPECIMEN_BUBBLE,
  SPECIMEN_NODE_FACTS,
  SPECIMEN_NODE_FACTS_COLD,
  SPECIMEN_NODE_FACTS_DEGRADED,
  SPECIMEN_PROVIDERS,
  SPECIMEN_QUEUE,
} from './specimen';

type Theme = 'light' | 'dark';

export function FilesNodeBoard({ theme = 'light' }: { theme?: Theme }) {
  return (
    <div
      className="cv2-root fn-board" data-astryx-theme="neutral"
      data-theme={theme === 'dark' ? 'dark' : undefined}
      data-testid="files-node-board"
      data-board-theme={theme}
    >
      <BoardFrame
        id="T3-4"
        title="T3-4 · FILES — UPLOAD · ATTACH · PREVIEW · FAIL HONESTLY"
        sub="files are attachments on entities and messages, never a kind of their own — one chip grammar everywhere"
      >
        <FilesScreen
          notes
          destinationLabel="T-114"
          queue={SPECIMEN_QUEUE}
          maxSizeBytes={null}
          bubble={SPECIMEN_BUBBLE}
          attached={SPECIMEN_ATTACHED}
        />
      </BoardFrame>

      <BoardFrame
        id="T3-5"
        title="T3-5 · NODE SETTINGS & STATUS — THE MACHINE ROOM, ON GRAPHITE"
        sub="the health payload the canvas assumes does not exist in this contract — reachability and live sessions are measured, the rest is stated as unmeasured"
      >
        <NodeRoom
          notes
          port={staticNodePort(SPECIMEN_NODE_FACTS)}
          nodeName="dockyard"
          version="tm8 v0.8.2"
          providers={SPECIMEN_PROVIDERS}
        />
      </BoardFrame>

      <BoardFrame
        id="T3-5b"
        title="T3-5 · DEGRADED — the same card, from a real seam state"
        sub="connection phase 'polling': websocket down, HTTP catch-up succeeding. The amber word is the seam's verdict, not a styling choice."
      >
        <NodeRoom
          notes
          port={staticNodePort(SPECIMEN_NODE_FACTS_DEGRADED)}
          nodeName="dockyard"
          version="tm8 v0.8.2"
          providers={SPECIMEN_PROVIDERS}
        />
      </BoardFrame>

      <BoardFrame
        id="T3-5c"
        title="T3-5 · COLD — what a real mount renders before anything is measured"
        sub="no host-supplied name, no version, no providers, no liveness snapshot. Every dash here is a fact about this build."
      >
        <NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_COLD)} notes />
      </BoardFrame>

      <BoardFrame
        id="T3-4b"
        title="T3-4 · EMPTY — the product default, nothing supplied"
        sub="no queue, no message, no attachments, no download resolver. This is what the screen says when it has nothing: it never goes blank and it never invents."
      >
        <FilesScreen destinationLabel="this task" />
      </BoardFrame>
    </div>
  );
}

function BoardFrame({
  id,
  title,
  sub,
  children,
}: {
  id: string;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <section className="fn-board__frame" data-frame={id}>
      <div className="fn-board__head">
        <span className="fn-board__id">{title}</span>
        <span className="fn-board__sub">{sub}</span>
      </div>
      {children}
    </section>
  );
}

/** Both themes side by side — the page a reviewer actually opens. */
export function FilesNodeBoardBothThemes() {
  return (
    <div className="fn-board__both">
      <FilesNodeBoard theme="light" />
      <FilesNodeBoard theme="dark" />
    </div>
  );
}
