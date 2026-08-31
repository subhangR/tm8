/**
 * CodeBrainScreen — the top-level CodeBrain view (SPEC §7). Mounted
 * route-matched in `GateApp` beside `boardV2`, not target-matched: there is
 * no `MenuTarget` for it (see `landingOfRoute`'s `codebrain` case).
 *
 * Three absences render as three different sentences (§7.5), never
 * conflated into one blank panel or one spinner that never resolves:
 *   - team_member rows not hydrated yet -> a WAIT
 *   - hydrated, and the CodeBrain root has no children -> a FACT (A7)
 *   - hydrated, phases found, no runs yet -> a DIFFERENT fact
 */
import { useEffect, useMemo, useState } from 'react';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { Pill, type PillTone } from '../kit';
import type { GateData } from '../views/useGateData';
import {
  isRun,
  phaseStatesOf,
  phases,
  sessionsFor,
  type Phase,
  type PhaseState,
} from './codebrain-model';
import './codebrain.css';

interface CodeBrainScreenProps {
  data: GateData;
  runId: EntityId | null;
  onSelectRun: (id: EntityId) => void;
}

const STATE_TONE: Readonly<Record<PhaseState, PillTone>> = {
  done: 'info',
  running: 'run',
  queued: 'idle',
  waiting: 'wait',
  failed: 'block',
};

/**
 * `title.split('·')[1].split('—')` for presentation only (SPEC §6.1) — the
 * phase's real identity stays its `id`/`position`. A title that does not
 * split (no specialist "N · NAME — box" shape) renders whole, unsplit.
 */
function nameAndBoxOf(title: string): { name: string; box: string | null } {
  const dotIdx = title.indexOf('·');
  const dashIdx = title.indexOf('—');
  if (dotIdx === -1 || dashIdx === -1 || dashIdx < dotIdx) {
    return { name: title, box: null };
  }
  return {
    name: title.slice(dotIdx + 1, dashIdx).trim(),
    box: title.slice(dashIdx + 1).trim(),
  };
}

/**
 * The cross-vendor mark (§7.4, AC5) — derived from `agentTool`, never a
 * model-name list, so it survives a new model landing in the catalogue.
 * Colour is never the only channel: a persistent glyph plus `title`/
 * `aria-label` naming the tool carry the split for a reader who cannot see
 * hue.
 */
function VendorMark({ agentTool }: { agentTool: string | null }) {
  if (agentTool === null || agentTool === 'claude-code') return null;
  const label = `Built on ${agentTool}, not claude-code`;
  return (
    <span className="cb-vendor-mark" role="img" aria-label={label} title={label}>
      {'⟂'}
    </span>
  );
}

/**
 * Elapsed time (A4) — derived from the phase's most recent session's
 * `startedAt`/`exitedAt`. Absent ⇒ render NOTHING, never a zero: a session
 * that has not started has no duration to claim, and a fabricated "0s"
 * would read as a real, tiny measurement rather than as no data at all.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

function elapsedOf(sessions: readonly EntitySummary[], now: number): string | null {
  const withStart = sessions.filter(
    (s) => s.state.kind === 'work_session' && s.state.startedAt,
  );
  if (withStart.length === 0) return null;
  const latest = withStart.reduce((a, b) =>
    (a.state as { startedAt: string }).startedAt > (b.state as { startedAt: string }).startedAt
      ? a
      : b,
  );
  const state = latest.state as { startedAt: string; exitedAt: string | null };
  const startMs = Date.parse(state.startedAt);
  const endMs = state.exitedAt ? Date.parse(state.exitedAt) : now;
  return formatElapsed(endMs - startMs);
}

function PhaseRow({
  phase,
  state,
  elapsed,
  selected,
  onSelect,
}: {
  phase: Phase;
  state: PhaseState;
  elapsed?: string | null;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { name, box } = nameAndBoxOf(phase.title);
  const Row = onSelect ? 'button' : 'div';
  return (
    <Row
      className={`cb-rail__row${selected ? ' cb-rail__row--selected' : ''}`}
      data-testid={`cb-phase-${phase.id}`}
      {...(onSelect ? { type: 'button', onClick: onSelect } : {})}
    >
      <span aria-hidden className={`cb-rail__bead cb-rail__bead--${state}`} />
      <div>
        <div className="t-body">
          <span className="cb-rail__name">
            {phase.position} {name}
          </span>{' '}
          <VendorMark agentTool={phase.agentTool} />
        </div>
        {box ? <div className="cb-rail__box t-secondary">{box}</div> : null}
        <div className="cb-rail__meta">
          {phase.model ? <span className="t-secondary">{phase.model}</span> : null}
          {elapsed ? <span className="t-secondary cb-rail__elapsed">{`took ${elapsed}`}</span> : null}
        </div>
      </div>
      <Pill tone={STATE_TONE[state]} dot={state === 'running' ? 'pulse' : undefined}>
        {state}
      </Pill>
    </Row>
  );
}

function PhaseRail({
  phaseList,
  statesOf,
  elapsedOf: elapsedOfProp,
  selectedId,
  onSelect,
}: {
  phaseList: readonly Phase[];
  statesOf: (phase: Phase) => PhaseState;
  elapsedOf?: (phase: Phase) => string | null;
  selectedId?: EntityId | null;
  onSelect?: (phase: Phase) => void;
}) {
  return (
    <div className="cb-rail" role="list" aria-label="CodeBrain phases">
      {phaseList.map((phase) => (
        <PhaseRow
          key={phase.id}
          phase={phase}
          state={statesOf(phase)}
          elapsed={elapsedOfProp?.(phase)}
          selected={selectedId === phase.id}
          onSelect={onSelect ? () => onSelect(phase) : undefined}
        />
      ))}
    </div>
  );
}

/** The right column (§7.2) — model/tool, teammate id, state, as a kv list. */
function PhaseDetail({
  phase,
  state,
  elapsed,
}: {
  phase: Phase;
  state: PhaseState;
  elapsed: string | null;
}) {
  const { name, box } = nameAndBoxOf(phase.title);
  return (
    <div className="cb-detail" data-testid="cb-detail-pane">
      <div className="t-h3">
        {phase.position} · {name}
        {box ? <span className="t-secondary"> — {box}</span> : null}
      </div>
      <dl className="cb-detail__kv">
        {phase.model || phase.agentTool ? (
          <div className="cb-detail__row">
            <dt className="t-label">{'model'}</dt>
            <dd className="t-body">
              {[phase.model, phase.agentTool].filter(Boolean).join(' · ')}
            </dd>
          </div>
        ) : null}
        <div className="cb-detail__row">
          <dt className="t-label">{'teammate'}</dt>
          <dd className="t-mono">{phase.id}</dd>
        </div>
        <div className="cb-detail__row">
          <dt className="t-label">{'state'}</dt>
          <dd className="t-body">{state}</dd>
        </div>
        {elapsed ? (
          <div className="cb-detail__row">
            <dt className="t-label">{'took'}</dt>
            <dd className="t-body">{elapsed}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function CodeBrainScreen({ data, runId, onSelectRun }: CodeBrainScreenProps) {
  useEffect(() => {
    data.ensureKind('team_member');
    data.ensureKind('task');
  }, [data.ensureKind]);

  const memberRows = data.rowsFor('team_member')(undefined);
  const memberLoading = data.pageStateOf('team_member')().loading;
  const phaseList = useMemo(() => phases(memberRows), [memberRows]);
  const phaseIds = useMemo(() => new Set(phaseList.map((p) => p.id)), [phaseList]);
  /* Read from the graph, same as the rail — AC3 (§7.5 item 1's explainer
     names the phases in prose, and prose that hardcodes them can drift from
     a rail that renders whatever the graph actually holds; empty when not
     yet hydrated, never padded to a fixed six). */
  const phaseNames = useMemo(
    () => phaseList.map((p) => nameAndBoxOf(p.title).name),
    [phaseList],
  );

  const taskRows = data.rowsFor('task')(undefined);
  const taskLoading = data.pageStateOf('task')().loading;
  const runs = useMemo(
    () => taskRows.filter((t) => isRun(t, phaseIds, data.graph.edges)),
    [taskRows, phaseIds, data.graph.edges],
  );

  const selectedRun: EntitySummary | null =
    runId === null ? null : (taskRows.find((t) => t.id === runId) ?? null);
  const notFound = runId !== null && selectedRun === null && !taskLoading;

  /* Which phase the detail pane shows. `null` until a row is clicked, at
     which point it stays fixed on the viewer's pick rather than jumping
     around as state changes underneath them. */
  const [pickedPhaseId, setPickedPhaseId] = useState<EntityId | null>(null);

  if (selectedRun) {
    const runStates = phaseStatesOf(selectedRun, phaseList, data.graph.edges);
    const now = Date.now();
    const elapsedOfPhase = (phase: Phase) =>
      elapsedOf(sessionsFor(selectedRun.id, phase.id, data.graph.edges), now);

    /* Default focus, absent a click: the running phase, else the frontier
       (lowest-position not done), else the first phase — the one a viewer
       who has not clicked anything would want to see. */
    const defaultPhase =
      phaseList.find((p) => runStates.get(p.id) === 'running') ??
      phaseList.find((p) => runStates.get(p.id) !== 'done') ??
      phaseList[0] ??
      null;
    const detailPhase = pickedPhaseId
      ? (phaseList.find((p) => p.id === pickedPhaseId) ?? defaultPhase)
      : defaultPhase;

    return (
      <div className="cb-root" data-testid="codebrain-screen">
        <div className="cb-layout">
          <div>
            <h1 className="t-h2 cb-header">{selectedRun.title}</h1>
            <PhaseRail
              phaseList={phaseList}
              statesOf={(p) => runStates.get(p.id) ?? 'queued'}
              elapsedOf={elapsedOfPhase}
              selectedId={detailPhase?.id ?? null}
              onSelect={(p) => setPickedPhaseId(p.id)}
            />
          </div>
          {detailPhase ? (
            <PhaseDetail
              phase={detailPhase}
              state={runStates.get(detailPhase.id) ?? 'queued'}
              elapsed={elapsedOfPhase(detailPhase)}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="cb-root" data-testid="codebrain-screen">
      <div className="cb-empty">
        {notFound ? (
          <p className="t-body cb-empty__not-found" data-testid="cb-not-found">
            {'The run in this link was not found.'}
          </p>
        ) : null}

        <p className="t-body">
          {phaseNames.length > 0
            ? `CodeBrain is six phases, each a different model, and one cross-vendor review — ${phaseNames.join(', ')}, working a task in sequence.`
            : 'CodeBrain is six phases, each a different model, and one cross-vendor review, working a task in sequence.'}
        </p>

        {memberLoading ? (
          <p className="t-secondary" data-testid="cb-phases-loading">
            {'Loading CodeBrain’s phases…'}
          </p>
        ) : phaseList.length === 0 ? (
          <p className="t-secondary" data-testid="cb-no-phases">
            {'This space has no CodeBrain phases yet.'}
          </p>
        ) : (
          <PhaseRail phaseList={phaseList} statesOf={() => 'queued'} />
        )}

        <div>
          <div className="t-label">{'Runs in this space'}</div>
          {taskLoading ? (
            <p className="t-secondary" data-testid="cb-runs-loading">
              {'Loading runs…'}
            </p>
          ) : runs.length === 0 ? (
            <p className="t-secondary" data-testid="cb-no-runs">
              {'No runs in this space yet.'}
            </p>
          ) : (
            <div className="cb-runs">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="cb-runs__item"
                  onClick={() => onSelectRun(run.id)}
                >
                  {run.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="t-secondary cb-empty__starts">
          {'Start one: '}
          <code className="t-mono">{'tm8 session spawn'}</code>
          {phaseNames[0] ? ` with the ${phaseNames[0]} teammate.` : ' with the first CodeBrain teammate.'}
        </p>
      </div>
    </div>
  );
}
