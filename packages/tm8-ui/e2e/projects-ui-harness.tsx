import { createRoot } from 'react-dom/client';
import type { ProjectResource } from '@tm8/contract';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import { GateApp } from '../src/views/GateApp';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../src/data/fixtures/seam-fixture';
import { ada, chatLaunchPlan, chatStoppedWithWork, projectTm8Ui, sessionLive, sessionStale, taskBlocked, taskQueued } from '../src/fixtures';

/**
 * The Projects list and project page over the fixture seam (task 01a15a00).
 * `?member=1` reads as a space member (no folder paths, as W11 serves them);
 * otherwise as a node admin, with `projects.update` applied to the fixture.
 */
const seam = createFixtureSeam();
const member = new URLSearchParams(location.search).has('member');
const listed = seam.projects.bind(seam);
const overrides = new Map<string, Partial<ProjectResource>>([['proj-tm8ui', { trust: 'untrusted', workingDir: '/home/subhang/code/tm8' }]]);
seam.projects = async (spaceId) => (await listed(spaceId)).map((row) => {
  const next = { ...row, ...overrides.get(row.id) };
  if (member) delete next.workingDir;
  return next;
});
seam.projectAdmin = {
  async update(projectId, input) {
    const { clientMutationId: _id, ...patch } = input;
    overrides.set(projectId, { ...overrides.get(projectId), ...patch } as Partial<ProjectResource>);
    const rows = await seam.projects(FIXTURE_SPACE_ID);
    return rows.find((row) => row.id === projectId)!;
  },
};
seam.projectSetup = {
  ...(seam.projectSetup ?? {}),
  directories: async (path) => ({
    roots: ['/home/subhang'],
    path: path ?? '/home/subhang',
    parentPath: path && path !== '/home/subhang' ? '/home/subhang' : null,
    separator: '/',
    directories: ['code', 'notes', 'work'].map((name) => ({ name, path: `${path ?? '/home/subhang'}/${name}` })),
    truncated: false,
  }),
} as typeof seam.projectSetup;
const directories = seam.projectSetup!.directories;
seam.spaceProjects = {
  directories: (_spaceId, path) => directories(path),
  add: async () => { throw new Error('The harness does not add projects.'); },
  clone: async () => { throw new Error('The harness does not clone.'); },
  cloneJob: async () => { throw new Error('The harness does not clone.'); },
};
/* The fixture project has no `in_project` edges; give it a little of each kind. */
const entity = seam.entity.bind(seam);
seam.entity = async (id) => {
  const detail = await entity(id);
  if (id !== projectTm8Ui.id) return detail;
  const linked = [sessionLive, sessionStale, taskQueued, taskBlocked, chatLaunchPlan, chatStoppedWithWork];
  return {
    ...detail,
    connections: {
      ...detail.connections,
      incoming: [{
        type: 'in_project',
        direction: 'incoming',
        label: 'in project',
        edges: linked.map((source, i) => ({
          id: `harness-in-project-${i}`, type: 'in_project', source, target: projectTm8Ui, props: {},
          createdBy: ada, createdAt: source.activityAt, updatedAt: source.activityAt,
        })),
      }],
    },
  };
};
if (!location.hash) location.hash = `#/s/${FIXTURE_SPACE_ID}/workspace`;
createRoot(document.getElementById('root')!).render(<GateApp seam={seam} />);
