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
import { useEffect, useMemo } from 'react';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { Pill, type PillTone } from '../kit';
import type { GateData } from '../views/useGateData';
import {
  isRun,
  phaseStatesOf,
  phases,
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

function PhaseRow({ phase, state }: { phase: Phase; state: PhaseState }) {
  const { name, box } = nameAndBoxOf(phase.title);
  return (
    <div className="cb-rail__row" data-testid={`cb-phase-${phase.id}`}>
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
        </div>
      </div>
      <Pill tone={STATE_TONE[state]} dot={state === 'running' ? 'pulse' : undefined}>
        {state}
      </Pill>
    </div>
  );
}

function PhaseRail({
  phaseList,
  statesOf,
}: {
  phaseList: readonly Phase[];
  statesOf: (phase: Phase) => PhaseState;
}) {
  return (
    <div className="cb-rail" role="list" aria-label="CodeBrain phases">
      {phaseList.map((phase) => (
        <PhaseRow key={phase.id} phase={phase} state={statesOf(phase)} />
      ))}
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

  const taskRows = data.rowsFor('task')(undefined);
  const taskLoading = data.pageStateOf('task')().loading;
  const runs = useMemo(
    () => taskRows.filter((t) => isRun(t, phaseIds, data.graph.edges)),
    [taskRows, phaseIds, data.graph.edges],
  );

  const selectedRun: EntitySummary | null =
    runId === null ? null : (taskRows.find((t) => t.id === runId) ?? null);
  const notFound = runId !== null && selectedRun === null && !taskLoading;

  if (selectedRun) {
    const runStates = phaseStatesOf(selectedRun, phaseList, data.graph.edges);
    return (
      <div className="cb-root" data-testid="codebrain-screen">
        <div className="cb-layout">
          <div>
            <h1 className="t-h2 cb-header">{selectedRun.title}</h1>
            <PhaseRail phaseList={phaseList} statesOf={(p) => runStates.get(p.id) ?? 'queued'} />
          </div>
          <div className="cb-detail" data-testid="cb-detail-pane" />
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
          {
            'CodeBrain is six phases, each a different model, and one cross-vendor review — DEFINE, PLAN, BUILD, VERIFY, REVIEW and SHIP, working a task in sequence.'
          }
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
          {' with the DEFINE teammate.'}
        </p>
      </div>
    </div>
  );
}
