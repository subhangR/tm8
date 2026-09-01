import { createRoot } from 'react-dom/client';
import { CodeBrainScreen } from '../src/codebrain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * The CodeBrain module over a stub seam carrying a REAL roster shape — the
 * phase names, positions and session statuses the live pipeline actually has.
 * jsdom proves the spine orders correctly; this is where it is legible.
 */
const members = [
  ['01a057c5-c9f3-763e-8073-68d723407602', 'CodeBrain v3 — idea-to-ship pipeline (opus 5)', 0, null],
  ['m1', 'CodeBrain 1 · TRIAGE — /discover', 1, 'root'],
  ['m2', 'CodeBrain 2a · EXPLORE — similar features', 2, 'root'],
  ['m3', 'CodeBrain 2b · EXPLORE — architecture', 3, 'root'],
  ['m4', 'CodeBrain 3 · CLARIFY — the gate', 4, 'root'],
  ['m5', 'CodeBrain 4 · ARCHITECT — design panel', 5, 'root'],
  ['m6', 'CodeBrain 5 · IMPLEMENT — write the code', 6, 'root'],
  ['m7', 'CodeBrain 6 · REVIEW — correctness lens', 7, 'root'],
  ['m8', 'CodeBrain 7 · GRADE — readiness', 8, 'root'],
] as const;

const ROOT = '01a057c5-c9f3-763e-8073-68d723407602';
const seam = {
  query: async (q: { kinds?: string[] }) => {
    if (q.kinds?.[0] === 'team_member') {
      return {
        page: {
          items: members.map(([id, title, position, p]) => ({
            id, title, position, kind: 'team_member',
            parentId: p === 'root' ? ROOT : null,
            state: { kind: 'team_member' },
          })),
          nextCursor: null,
        },
      };
    }
    return {
      page: {
        items: [
          { id: 's1', kind: 'work_session', state: { kind: 'work_session', status: 'running', teammate: { id: 'm6' } } },
          { id: 's2', kind: 'work_session', state: { kind: 'work_session', status: 'running', teammate: { id: 'm7' } } },
          { id: 's3', kind: 'work_session', state: { kind: 'work_session', status: 'idle', teammate: { id: 'm7' } } },
        ],
        nextCursor: null,
      },
    };
  },
};

createRoot(document.getElementById('root')!).render(
  /* `.cv2-root` is where tokens.css DEFINES every --pn-* token; without it a
     harness renders the component with every variable unresolved and looks
     broken while the shipped app is fine. GateApp supplies this class. */
  <div className="cv2-root" style={{ height: '100vh' }}>
    <CodeBrainScreen seam={seam as never} spaceId={'sp' as never} onOpenEntity={() => {}} />
  </div>,
);
