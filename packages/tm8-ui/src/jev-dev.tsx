import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import './mobile/mobile.css';
import './mobile/mobile-screens.css';
import './mobile/mobile-chrome.css';
import type { EntityId } from '@tm8/contract';
import { createFixtureSeam, FIXTURE_SPACE_ID } from './data/fixtures/seam-fixture';
import type { FixtureJevScenario } from './data/fixtures/jev-fixture';
import { fixtureSummaries } from './fixtures/entities';
import { MobileSurfaceProvider } from './mobile';
import { LaunchSheet } from './views/LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS } from './views/launch-fixtures';
import { LaunchComposerPopup } from './new-session/LaunchComposerPopup';
import type { LaunchMemory, LaunchTeammate } from './domain/launch';

/**
 * ASK JEV SCRATCH HARNESS — the `credsetup-dev` pattern, for what jsdom
 * cannot settle: how ✦ Ask Jev LOOKS on LaunchSheet and the Run popup, at a
 * desktop width and at a 390px phone, over the fixture seam's scripted
 * `launch.suggest` (every group ok, one group failed, or no key).
 *
 * Usage: /jev-dev.html?surface=sheet|popup&phone=1&scenario=ok|group_failed|no_key&ask=1&review=1
 */
const params = new URLSearchParams(location.search);
const seam = createFixtureSeam();
seam.fixtureControls.setJevScenario((params.get('scenario') as FixtureJevScenario | null) ?? 'ok');
seam.fixtureControls.setJevDelay(Number(params.get('delay') ?? 250));

/* The roster and memories from the SAME fixture rows Jev ranks, so a rank
   click lands on a teammate this sheet can actually pick. */
const teammates: LaunchTeammate[] = fixtureSummaries
  .filter((row) => row.state.kind === 'team_member')
  .map((row) => ({
    id: row.id, name: row.title, initial: row.title.charAt(0).toUpperCase(),
    model: 'claude-opus-5', agentTool: 'claude-code', owner: '@ada',
  }));
const memories: LaunchMemory[] = fixtureSummaries
  .filter((row) => row.state.kind === 'memory')
  .map((row) => ({
    id: row.id, statement: row.title, subjectScope: 'space', mark: 'unflagged',
    injectedWhenPicked: true, detail: '',
  }));
const subject = fixtureSummaries.find((row) => row.state.kind === 'task')!;

function Harness() {
  const [theme, setTheme] = useState<'light' | 'dark'>((params.get('theme') as 'light' | 'dark') ?? 'light');
  const surface = params.get('surface') ?? 'sheet';
  const phone = params.get('phone') === '1';
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [last, setLast] = useState<string>('');

  /* `ask=1` presses the button once the surface is up, so a screenshot can be
     taken of the answered state without a click script. */
  useEffect(() => {
    if (params.get('ask') !== '1') return;
    const timer = setTimeout(() => {
      (document.querySelector('[data-testid="jev-ask"]') as HTMLButtonElement | null)?.click();
      if (params.get('review') === '1') {
        setTimeout(() => (document.querySelector('[data-testid="jev-review"]') as HTMLButtonElement | null)?.click(), 700);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [host]);

  const body = useMemo(() => surface === 'popup' ? (
    <LaunchComposerPopup
      subject={{ id: subject.id, title: subject.title }}
      spaceId={FIXTURE_SPACE_ID}
      teammates={teammates.map((t) => ({ id: t.id, label: t.name, agentTool: t.agentTool, model: t.model }))}
      projects={LAUNCH_PROJECTS.map((p) => ({ projectId: p.id as never, name: p.name, trusted: p.trusted }))}
      capacity={LAUNCH_CAPACITY}
      jev={seam.commands.jev}
      loadDescription={() => Promise.resolve('Invite links should be single-use, and the join screen must say so when one has already been used.')}
      onSpawn={(input) => { setLast(JSON.stringify(input, null, 2)); }}
      onDismiss={() => {}}
    />
  ) : (
    <LaunchSheet
      subjectId={subject.id as EntityId}
      spaceId={FIXTURE_SPACE_ID}
      fromChip="◔ Run ▸"
      fromCaption={`Task · “${subject.title}”`}
      teammates={teammates}
      projects={LAUNCH_PROJECTS}
      profiles={LAUNCH_PROFILES}
      capacity={LAUNCH_CAPACITY}
      memories={memories}
      jev={seam.commands.jev}
      onLaunch={(config) => setLast(JSON.stringify(config, null, 2))}
      onDispatch={() => setLast('dispatch')}
      onCancel={() => {}}
    />
  ), [surface]);

  if (phone) {
    return (
      <div className="cv2-root" data-shell="mobile" data-theme={theme}
        style={{ width: 390, height: 844, position: 'relative', overflow: 'hidden', background: 'var(--pn-surface)' }}>
        <div className="msheet-host" ref={setHost} style={{ position: 'absolute', inset: 0 }} />
        {host ? <MobileSurfaceProvider sheetHost={host}>{body}</MobileSurfaceProvider> : null}
      </div>
    );
  }
  return (
    <div className="cv2-root shell-scope" data-theme={theme} style={{ height: 'calc(100vh / 1.1)', position: 'relative', background: 'var(--pn-surface)' }}>
      <div style={{ position: 'absolute', right: 12, top: 12, width: 360, fontSize: 11 }}>
        <button type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>theme: {theme}</button>
        <pre data-testid="dev-last" style={{ whiteSpace: 'pre-wrap', color: 'var(--pn-ink-2)' }}>{last}</pre>
      </div>
      {body}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
