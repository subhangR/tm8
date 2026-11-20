import { useEffect, useState } from 'react';
import type { EntityCapabilities, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { describeAccessMode } from '../domain/launch';
import { loadTaskAccess, maskAccessLabel, repositoryLabel, type AccessProject, type AccessRun, type TaskAccessSnapshot } from './load';
import './task-access.css';

type State =
  | { taskId: EntityId; phase: 'loading' | 'error' }
  | { taskId: EntityId; phase: 'ready'; snapshot: TaskAccessSnapshot };

/** One task view; it grants no authority and renders no raw manifest or credential values. */
export function TaskAccessSection({ seam, taskId, onOpenEntity }: {
  seam: Seam;
  taskId: EntityId;
  onOpenEntity?: (id: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ taskId, phase: 'loading' });
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let completed = false;
    let changedDuringRead = false;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ taskId, phase: 'loading' });
    setStale(false);
    const unsubscribe = seam.onEvent(() => {
      changedDuringRead = true;
      if (completed) setStale(true);
    });
    void loadTaskAccess(seam, taskId, { signal: controller.signal }).then(
      (snapshot) => {
        if (controller.signal.aborted) return;
        completed = true;
        setState({ taskId, phase: 'ready', snapshot });
        setStale(changedDuringRead);
        staleTimer = setTimeout(() => setStale(true), 60_000);
      },
      () => { if (!controller.signal.aborted) setState({ taskId, phase: 'error' }); },
    );
    return () => {
      controller.abort();
      unsubscribe();
      clearTimeout(staleTimer);
    };
  }, [seam, taskId, refresh]);

  // A reused panel must never paint the previous task's account/permission facts.
  const visible = state.taskId === taskId ? state : { taskId, phase: 'loading' as const };
  return (
    <section className="pn-task-access pn-section" data-testid="task-access-section" aria-label="Task access">
      <div className="pn-task-access__head">
        <h3>Access</h3>
        <button type="button" className="pn-task-access__refresh" disabled={visible.phase === 'loading'} onClick={() => setRefresh((n) => n + 1)}>Refresh access</button>
      </div>
      {visible.phase === 'loading' ? <p role="status">Reading access…</p> : null}
      {visible.phase === 'error' ? <p role="alert">Access could not be read. Refresh to try again.</p> : null}
      {visible.phase === 'ready' ? (
        <>
          <p className="pn-task-access__note">
            Checked <time dateTime={visible.snapshot.checkedAt}>{new Date(visible.snapshot.checkedAt).toLocaleString()}</time>.
            {stale ? <strong role="status" data-testid="task-access-stale"> Access may have changed. Refresh to recheck.</strong> : null}
          </p>
          {visible.snapshot.issues.length > 0 ? <p className="pn-task-access__incomplete" role="alert" data-testid="task-access-incomplete">Incomplete access view. {visible.snapshot.issues.join(' ')} Refresh to recheck.</p> : null}
          <h4>Your task permissions now</h4>
          <p data-testid="task-access-permissions">{taskChanges(visible.snapshot.capabilities)}</p>
          <h4>Linked repositories and project roots</h4>
          {visible.snapshot.projects.length === 0 ? <p className="pn-task-access__note">{visible.snapshot.issues.some((issue) => issue.startsWith('Project links')) ? 'Project links could not be fully read.' : 'No readable project is linked to this task.'}</p> : (
            <ul className="pn-task-access__projects">{visible.snapshot.projects.map((project) => <li key={project.id}><ProjectRow project={project} onOpenEntity={onOpenEntity} /></li>)}</ul>
          )}
          <h4>Recorded run access</h4>
          <p className="pn-task-access__note">Launch policies and directories are recorded facts. Account status and scopes are current metadata; live OS permissions are not measured.</p>
          {visible.snapshot.runs.length === 0 ? <p className="pn-task-access__note">{visible.snapshot.issues.some((issue) => issue.startsWith('Run links')) ? 'Run links could not be fully read.' : 'No readable work session is linked to this task.'}</p> : visible.snapshot.runs.map((run) => <RunRow key={run.session.id} run={run} onOpenEntity={onOpenEntity} />)}
        </>
      ) : null}
    </section>
  );
}

function taskChanges(capabilities: EntityCapabilities): string {
  const changes = [
    capabilities.canEdit && 'edit details', capabilities.canLink && 'link resources',
    capabilities.canAddChild && 'add subtasks', capabilities.canComplete && 'complete the task',
    capabilities.canDelete && 'delete the task',
  ].filter(Boolean);
  return changes.length ? `Allowed requests: ${changes.join(', ')}. Each change is checked by the server.` : 'No task changes are allowed for this viewer.';
}

function EntityName({ id, title, onOpenEntity }: { id: string; title: string; onOpenEntity?: (id: string) => void }) {
  return onOpenEntity ? <button type="button" className="pn-task-access__link" onClick={() => onOpenEntity(id)}>{title}</button> : <span>{title}</span>;
}

function ProjectRow({ project, onOpenEntity }: { project: AccessProject; onOpenEntity?: (id: string) => void }) {
  const repo = repositoryLabel(project.repoUrl);
  return <>
    <EntityName id={project.id} title={project.title} onOpenEntity={onOpenEntity} />
    <dl><dt>Repository</dt><dd>{repo ? <code>{repo}</code> : 'Repository metadata unavailable'}</dd>
      <dt>Current project root</dt><dd>{project.workingDir ? <code>{project.workingDir}</code> : 'Not visible to this viewer'}</dd></dl>
  </>;
}

function RunRow({ run, onOpenEntity }: { run: AccessRun; onOpenEntity?: (id: string) => void }) {
  const connectors = run.connectorAccounts;
  return (
    <article className="pn-task-access__run" data-testid="task-access-run">
      <EntityName id={run.session.id} title={run.session.title} onOpenEntity={onOpenEntity} />
      {!run.available ? <p className="pn-task-access__note">{run.failed ? 'Launch record unavailable. Refresh to retry.' : 'Launch access was not recorded for this session.'}</p> : (
        <>
          {run.recordedAt ? <p className="pn-task-access__note">Launch recorded <time dateTime={run.recordedAt}>{new Date(run.recordedAt).toLocaleString()}</time></p> : null}
          <dl>
            <dt>Permitted agent changes at launch</dt><dd>{run.accessMode ? describeAccessMode(run.accessMode) : 'Access mode not recorded'}{run.accessModeSource ? ` (${run.accessModeSource})` : ''}</dd>
            <dt>Native approval policy</dt><dd>{run.permissionMode ?? 'Not recorded'}</dd>
            <dt>Working directory</dt><dd>{run.workingDirectory ? <code>{run.workingDirectory}</code> : 'Not recorded'}{run.workdirMode ? ` (${run.workdirMode})` : ''}</dd>
            <dt>Project</dt><dd>{run.project ? <EntityName id={run.project.id} title={run.project.title} onOpenEntity={onOpenEntity} /> : run.projectRecorded ? 'Current project metadata unavailable' : 'No project recorded'}</dd>
            {run.project ? <><dt>Repository</dt><dd><code>{repositoryLabel(run.project.repoUrl) ?? 'Repository metadata unavailable'}</code></dd></> : null}
            <dt>Command network</dt><dd>{run.network ?? 'Not recorded'}</dd>
          </dl>
          {run.sandboxDegraded ? <p className="pn-task-access__incomplete">Filesystem sandbox restrictions were not enforced at launch.</p> : null}
          <h5>Provider credentials used</h5>
          {run.credentials.length === 0 ? <p className="pn-task-access__note">Effective provider sources were not recorded.</p> : <ul>{run.credentials.map((credential) => <li key={credential.provider}>
            <strong>{credential.provider}</strong> · {credential.source} credential
            {credential.credential ? <> · <EntityName id={credential.credential.id} title={credential.credential.label} onOpenEntity={onOpenEntity} />{credential.credential.displayLogin ? ` · ${credential.credential.displayLogin}` : ''} · {credential.credential.status} now</> : credential.source === 'space' ? ` · ${credential.pinned ? 'Current credential metadata unavailable' : 'Exact credential was not recorded'}` : ' · Account identity was not recorded'}
          </li>)}</ul>}
          <h5>Connector accounts bound to this session</h5>
          <p className="pn-task-access__note">Recorded resolved bindings, which may be updated on resume. Labels, status and scopes are current metadata.</p>
          {!connectors?.available ? <p className="pn-task-access__note">{connectors?.unavailableReason === 'read_failed' ? 'Connector account metadata unavailable. Refresh to retry.' : 'Resolved connector accounts were not recorded.'}</p> : <>
            {connectors.entries.length === 0 && connectors.hiddenCount === 0 ? <p className="pn-task-access__note">No connectors were bound to this session.</p> : null}
            <ul>{connectors.entries.map((entry) => <li key={entry.serverId}>
              <EntityName id={entry.serverId} title={maskAccessLabel(entry.serverName)} onOpenEntity={onOpenEntity} />
              {entry.account ? <>
                {' · '}{maskAccessLabel(entry.account.label)}{entry.account.accountLabel ? ` · ${maskAccessLabel(entry.account.accountLabel)}` : ''}
                {' · '}{entry.account.status ?? entry.account.reason} now · {entry.account.usable ? 'usable by you' : 'not usable by you'}
                {entry.account.grantedScopes.length > 0 ? <p className="pn-task-access__scopes">Granted scopes: {entry.account.grantedScopes.map(maskAccessLabel).join(', ')}</p> : <p className="pn-task-access__note">Granted scopes not recorded.</p>}
              </> : entry.credentialRequired ? ' · Current account metadata unavailable' : ' · No account required'}
            </li>)}</ul>
            {connectors.hiddenCount > 0 ? <p className="pn-task-access__note">{connectors.hiddenCount} connector{connectors.hiddenCount === 1 ? '' : 's'} cannot be shown to this viewer.</p> : null}
          </>}
        </>
      )}
    </article>
  );
}
