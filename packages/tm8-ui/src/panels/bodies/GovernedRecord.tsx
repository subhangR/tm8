import { useEffect, useMemo, useState } from 'react';
import {
  isCollabError,
  type ContentionReport,
  type EntityDetail,
  type EntitySummary,
  type ProjectBranchTopology,
  type ProjectDirectoryListing,
  type ProjectResource,
  type ProjectTrustLevel,
} from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { KindIcon, getKind } from '../../domain';
import { Eyebrow, Pill } from '../../kit';
import { ProjectFolderBrowser, useProjectSourceDraft } from '../../projects/project-source';
import { broadWorkingDirReason, broadWorkingDirWarning } from '../../projects/working-dir-risk';

/**
 * THE GOVERNED RECORD'S WRITABLE AND GIT-BACKED PARTS — the folder editor, the
 * trust switch, the git status and the work list a governed body draws when
 * its host hands it a record port.
 *
 * Everything here keys off the RECORD, never off a kind: a record that carries
 * a path is a node admin's read (W11), and only then are the folder and trust
 * controls offered, because only then would the node accept them.
 */

export interface GovernedRecordControls {
  /** `projects.update`: a new path and/or trust. Absent = this host cannot write. */
  update?(patch: { workingDir?: string; trust?: ProjectTrustLevel }): Promise<ProjectResource>;
  /** The node folder browser, for picking the new path. */
  directories?(path?: string): Promise<ProjectDirectoryListing>;
  branches?(): Promise<ProjectBranchTopology>;
  worktrees?(): Promise<ContentionReport>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String((cause as { message?: unknown } | null)?.message ?? cause);
}

// ---------------------------------------------------------------------------
// FOLDER EDITOR
// ---------------------------------------------------------------------------

export function FolderEditor({
  current,
  controls,
  onDone,
}: {
  current: string;
  controls: GovernedRecordControls & Required<Pick<GovernedRecordControls, 'update'>>;
  onDone(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useProjectSourceDraft({
    directories: (path) => (controls.directories ? controls.directories(path) : Promise.reject(new Error('Browsing folders is not available here.'))),
    onEdit: () => setError(null),
  });
  // Seed the field with the current path once.
  useEffect(() => { draft.setWorkingDir(current); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const next = draft.workingDir.trim();
  const separator = /^[A-Za-z]:[\\/]/.test(next) ? '\\' : '/';
  const broad = next ? broadWorkingDirReason(next, separator) : null;

  if (draft.browser.open) {
    return (
      <div className="gb-folder-edit" data-testid="governed-folder-browser">
        <ProjectFolderBrowser draft={draft} nodeLabel="this node" allowNewFolder={false} />
      </div>
    );
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!next) return setError('Enter the folder’s full path.');
    if (next === current) return onDone();
    setBusy(true);
    try {
      await controls.update({ workingDir: next });
      onDone();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <form className="gb-folder-edit" data-testid="governed-folder-edit" onSubmit={save}>
      <div className="gb-folder-edit__row">
        <input
          aria-label="Working folder"
          value={draft.workingDir}
          onChange={(event) => draft.setWorkingDir(event.target.value)}
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
        {controls.directories ? (
          <button type="button" className="gb-verb" onClick={() => draft.openBrowser('workingDir')} disabled={busy}>
            Browse…
          </button>
        ) : null}
      </div>
      <p className="gb-folder-edit__note">
        New chats, sessions, worktrees and terminals start in this folder. Ones already running keep their folder.
        The folder must already exist on the node.
      </p>
      {broad ? <p className="gb-folder-edit__warn" role="alert">{broadWorkingDirWarning(broad)}</p> : null}
      {error ? <p className="gb-folder-edit__error" role="alert">{error}</p> : null}
      <div className="gb-folder-edit__actions">
        <button type="button" className="gb-verb" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="gb-verb gb-verb--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save folder'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// TRUST SWITCH
// ---------------------------------------------------------------------------

/**
 * Trusting is a safety decision, so it takes two clicks: the first states
 * what it allows, the second makes it. Untrusting is one click away from the
 * same confirm, since it stops nothing already running.
 */
export function TrustSwitch({
  trust,
  path,
  update,
}: {
  trust: ProjectTrustLevel;
  path: string;
  update: NonNullable<GovernedRecordControls['update']>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next: ProjectTrustLevel = trust === 'trusted' ? 'untrusted' : 'trusted';

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await update({ trust: next });
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className={next === 'trusted' ? 'gb-verb gb-verb--primary' : 'gb-verb'}
        data-testid="governed-trust-toggle"
        onClick={() => setConfirming(true)}
      >
        {next === 'trusted' ? 'Trust this project' : 'Untrust'}
      </button>
    );
  }
  return (
    <div className="gb-trust__confirm" data-testid="governed-trust-confirm" role="group" aria-label="Confirm trust change">
      <p>
        {next === 'trusted'
          ? <>Agents will run in <code>{path}</code> without asking first. Only trust a folder whose code you trust.</>
          : <>New runs in <code>{path}</code> will ask for confirmation first. Nothing already running is stopped.</>}
      </p>
      <div className="gb-trust__confirm-actions">
        <button type="button" className="gb-verb" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        <button type="button" className="gb-verb gb-verb--primary" onClick={() => void apply()} disabled={busy}>
          {busy ? 'Saving…' : next === 'trusted' ? 'Trust' : 'Untrust'}
        </button>
      </div>
      {error ? <p className="gb-folder-edit__error" role="alert">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GIT STATUS
// ---------------------------------------------------------------------------

type GitState =
  | { phase: 'loading' }
  | { phase: 'error'; notARepo: boolean; message: string }
  | { phase: 'ready'; topology: ProjectBranchTopology; worktrees: ContentionReport | null };

export function GitStatusBlock({ controls, label }: { controls?: GovernedRecordControls; label?: string }) {
  const [state, setState] = useState<GitState>({ phase: 'loading' });
  const [generation, setGeneration] = useState(0);
  const branches = controls?.branches;
  const worktrees = controls?.worktrees;

  useEffect(() => {
    if (!branches) return;
    let live = true;
    setState({ phase: 'loading' });
    void (async () => {
      try {
        const [topology, lanes] = await Promise.all([
          branches(),
          worktrees ? worktrees().catch(() => null) : Promise.resolve(null),
        ]);
        if (live) setState({ phase: 'ready', topology, worktrees: lanes });
      } catch (cause) {
        if (!live) return;
        setState({ phase: 'error', notARepo: isCollabError(cause) && cause.code === 'invalid_input', message: messageOf(cause) });
      }
    })();
    return () => { live = false; };
  }, [branches, worktrees, generation]);

  if (!branches) return null;
  const head = label ?? 'GIT';

  return (
    <section className="gb-git" data-testid="governed-git">
      <div className="gb-git__head">
        <Eyebrow faint>{head}</Eyebrow>
        <button type="button" className="gb-git__refresh" aria-label="Refresh git status" onClick={() => setGeneration((n) => n + 1)}>
          ↻
        </button>
      </div>
      {state.phase === 'loading' ? <p className="pn-section__empty">Reading git…</p> : null}
      {state.phase === 'error' ? (
        <p className="pn-section__empty" data-testid="governed-git-error">
          {state.notARepo ? 'This folder is not a git repository.' : `Git status could not be read: ${state.message}`}
        </p>
      ) : null}
      {state.phase === 'ready' ? <GitFacts topology={state.topology} worktrees={state.worktrees} /> : null}
    </section>
  );
}

function GitFacts({ topology, worktrees }: { topology: ProjectBranchTopology; worktrees: ContentionReport | null }) {
  const current = topology.branches.find((branch) => branch.isCurrent) ?? null;
  const merged = topology.branches.filter((branch) => branch.merged && !branch.isDefault).length;
  const stale = topology.branches.filter((branch) => branch.stale).length;
  const unmerged = topology.branches.filter((branch) => !branch.merged && !branch.isDefault);
  const lanes = worktrees?.lanes ?? null;
  const overlaps = worktrees?.pairs.length ?? 0;
  return (
    <div className="gb-git__facts">
      <div className="gb-git__line" data-testid="governed-git-current">
        <span className="gb-git__glyph" aria-hidden>⑂</span>
        <code className="gb-git__branch">{current?.name ?? 'detached HEAD'}</code>
        {current && !current.isDefault ? (
          <span className="gb-git__ab" title={`against ${topology.defaultBranch}`}>
            ↑{current.ahead} ↓{current.behind} vs {topology.defaultBranch}
          </span>
        ) : current ? (
          <span className="gb-git__ab">default branch</span>
        ) : null}
        {current?.upstream ? <span className="gb-git__muted">tracks {current.upstream}</span> : null}
      </div>
      {current ? (
        <div className="gb-git__muted gb-git__subject" title={current.subject}>
          {current.head.slice(0, 7)} · {current.subject}
        </div>
      ) : null}
      <div className="gb-git__stats">
        <span>{topology.branches.length}{topology.truncated ? '+' : ''} branch{topology.branches.length === 1 ? '' : 'es'}</span>
        {unmerged.length > 0 ? <span>{unmerged.length} not merged</span> : null}
        {merged > 0 ? <span>{merged} merged</span> : null}
        {stale > 0 ? <span>{stale} stale</span> : null}
        {lanes ? <span data-testid="governed-git-worktrees">{lanes.length} active worktree{lanes.length === 1 ? '' : 's'}</span> : null}
        {overlaps > 0 ? <Pill tone="wait">{overlaps} overlapping</Pill> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WORK LIST — everything recorded in this project, filterable by kind
// ---------------------------------------------------------------------------

const ALL = '*';

export function WorkListBlock({
  detail,
  edgeType,
  label,
  livenessOf,
  now,
  onOpenEntity,
}: {
  detail: EntityDetail;
  edgeType: string;
  label?: string;
  livenessOf?: (id: string) => SessionLiveness;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: EntitySummary[] = [];
    for (const group of [...detail.connections.incoming, ...detail.connections.outgoing]) {
      if (group.type !== edgeType) continue;
      for (const edge of group.edges) {
        const other = edge.source.id === detail.id ? edge.target : edge.source;
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        out.push(other);
      }
    }
    return out.sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));
  }, [detail, edgeType]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const [filter, setFilter] = useState<string>(ALL);
  const shown = filter === ALL ? rows : rows.filter((row) => row.kind === filter);
  const live = livenessOf ? rows.filter((row) => livenessOf(row.id) === 'live').length : 0;

  return (
    <section className="gb-work" data-testid="governed-work">
      <Eyebrow faint>{`${label ?? 'IN THIS PROJECT'} · ${rows.length}${live > 0 ? ` · ${live} LIVE` : ''}`}</Eyebrow>
      {rows.length === 0 ? (
        <p className="pn-section__empty">
          Nothing has run in this project yet. Chats, sessions and tasks started in it will show up here.
        </p>
      ) : (
        <>
          <div className="gb-work__filters" role="tablist" aria-label="Filter by kind">
            <FilterChip active={filter === ALL} onClick={() => setFilter(ALL)} label="All" count={rows.length} />
            {kinds.map(([kind, count]) => (
              <FilterChip
                key={kind}
                active={filter === kind}
                onClick={() => setFilter(kind)}
                label={getKind(kind).labelPlural}
                count={count}
              />
            ))}
          </div>
          <ul className="gb-work__rows">
            {shown.map((row) => (
              <WorkRow key={row.id} row={row} verdict={livenessOf?.(row.id)} now={now} onOpenEntity={onOpenEntity} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick(): void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'gb-work__chip gb-work__chip--on' : 'gb-work__chip'}
      onClick={onClick}
    >
      {label} <span className="gb-work__count">{count}</span>
    </button>
  );
}

function WorkRow({
  row,
  verdict,
  now,
  onOpenEntity,
}: {
  row: EntitySummary;
  verdict: SessionLiveness | undefined;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const treatment = verdict ? getKind(row.kind).list.liveTreatment?.(verdict) ?? null : null;
  const content = (
    <>
      <span aria-hidden className="gb-work__glyph"><KindIcon kind={row.kind} /></span>
      <span className="gb-work__title">{row.title || row.id}</span>
      {treatment ? <Pill tone={treatment.tone} dot={treatment.dot ?? undefined}>{treatment.label}</Pill> : null}
      <span className="gb-work__ago">{elapsed(row.activityAt, now)}</span>
    </>
  );
  return (
    <li data-testid="governed-work-row" data-kind={row.kind}>
      {onOpenEntity ? (
        <button type="button" className="gb-work__row" onClick={() => onOpenEntity(row.id)}>{content}</button>
      ) : (
        <div className="gb-work__row gb-work__row--static">{content}</div>
      )}
    </li>
  );
}

function elapsed(iso: string, now: string): string {
  const mins = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
