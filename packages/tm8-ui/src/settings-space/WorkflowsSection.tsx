/**
 * SETTINGS > WORKFLOWS (W4, 2026-08-16) — a space narrows the status
 * vocabulary per `type` axis value (migration 132).
 *
 * AUTHORED BESIDE AXES, by ruling: a workflow row is meaningless without its
 * `type` value existing next door, so this section draws ONE editor per value
 * the `type` axis declares — plus any stored rule whose value the axis no
 * longer declares, which 132's header calls INERT by construction and keeps
 * editable/deletable rather than orphaning.
 *
 * EVERY RULE IS THE SERVER'S, surfaced verbatim (the `AxesSection` law):
 * space-admin authorization, the duplicate-status refusal, the structural
 * check constraint and the per-task trigger all live in SQL. What the editor
 * states BEFORE the click is only what the schema makes unauthorable:
 * {open, working, done} are STRUCTURAL — present in every vocabulary, because
 * creation, the spawn door and completion must never be authorable out of
 * existence — so their boxes render locked with that reason, and the
 * narrowable set is exactly {pulled, in_review, blocked, cancelled}.
 *
 * DELETE IS WIDEN-BACK, NEVER DATA LOSS: dropping a rule restores the full
 * seven and no task row changes — 132's own comment, repeated under the
 * control because a delete button without that sentence reads as destructive.
 */
import { useState } from 'react';
import type { TaskAxis, TaskWorkflow, TaskWorkflowInput } from '@tm8/contract';
import { STRUCTURAL_STATUSES, WORKFLOW_AXIS } from '../domain';
import { workflowStatusVocabulary } from './port';

type WorkflowWrite = Omit<TaskWorkflowInput, 'clientMutationId' | 'actorId'>;

export interface WorkflowsSectionProps {
  /** The axis registry — `null` = the settings read failed. The `type` axis's values are the row set. */
  axes: readonly TaskAxis[] | null;
  /** `null` = the settings read failed; `[]` = a measured "no rules defined". */
  workflows: readonly TaskWorkflow[] | null;
  onUpsert: (input: WorkflowWrite) => Promise<void>;
  onDelete: (workflowId: string) => Promise<void>;
}

export function WorkflowsSection({ axes, workflows, onUpsert, onDelete }: WorkflowsSectionProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(act: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await act();
    } catch (error) {
      // The server's own words — "space admin required", "workflow statuses
      // must be unique", the check-constraint sentence — are the product copy
      // here, because SQL is where the rule lives.
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const typeAxis = axes?.find((a) => a.name === WORKFLOW_AXIS) ?? null;
  const declared = typeAxis?.axisValues ?? [];
  // Stored rules whose value the axis no longer declares: INERT (no task can
  // carry the value) but shown, editable, deletable — never silently dropped.
  const undeclared = (workflows ?? []).filter((w) => !declared.includes(w.typeValue));

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Workflows</span>
        <div className="set-section__grow" />
      </div>

      <div className="set-section__scroll">
        {failure ? (
          <span className="set-absent__why" role="alert" data-testid="workflows-error">
            {failure}
          </span>
        ) : null}

        {workflows === null || axes === null ? (
          <div className="set-absent" data-testid="workflows-absent">
            <span className="set-absent__head">The workflow registry has not been read.</span>
            <span className="set-absent__why">
              the settings read did not resolve — this is an unread, not a space with no workflows
            </span>
          </div>
        ) : typeAxis === null ? (
          <div className="set-absent" data-testid="workflows-no-axis">
            <span className="set-absent__head">
              This space has no {WORKFLOW_AXIS} axis, so there is nothing to key a workflow on.
            </span>
            <span className="set-absent__why">
              workflows narrow the status vocabulary per {WORKFLOW_AXIS} value — define the axis
              under Task axes and its values gain an editor here
            </span>
          </div>
        ) : (
          <>
            <span className="set-prose">
              Each {WORKFLOW_AXIS} value below can narrow which statuses its tasks may be moved to.
              A task re-typed outside its vocabulary is flagged off-workflow — never rewritten.
            </span>
            {declared.map((value) => (
              <WorkflowRow
                key={value}
                typeValue={value}
                rule={(workflows ?? []).find((w) => w.typeValue === value) ?? null}
                declared
                busy={busy}
                onSave={(statuses) => void run(() => onUpsert({ typeValue: value, statuses: statuses as never }))}
                onDelete={(workflowId) => void run(() => onDelete(workflowId))}
              />
            ))}
            {undeclared.map((rule) => (
              <WorkflowRow
                key={rule.id}
                typeValue={rule.typeValue}
                rule={rule}
                declared={false}
                busy={busy}
                onSave={(statuses) => void run(() => onUpsert({ typeValue: rule.typeValue, statuses: statuses as never }))}
                onDelete={(workflowId) => void run(() => onDelete(workflowId))}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One type value's vocabulary editor. Checkbox state is DRAFT (initialised
 * from the stored rule, full seven when none); Save writes the WHOLE
 * vocabulary because `upsert_task_workflow` has no sparse form.
 */
function WorkflowRow({
  typeValue,
  rule,
  declared,
  busy,
  onSave,
  onDelete,
}: {
  typeValue: string;
  rule: TaskWorkflow | null;
  declared: boolean;
  busy: boolean;
  onSave: (statuses: string[]) => void;
  onDelete: (workflowId: string) => void;
}) {
  const vocabulary = workflowStatusVocabulary();
  const stored = rule === null ? vocabulary.map((s) => s.id) : (rule.statuses as readonly string[]);
  const [checked, setChecked] = useState<readonly string[]>(stored);

  const statuses = vocabulary
    .filter((s) => STRUCTURAL_STATUSES.includes(s.id) || checked.includes(s.id))
    .map((s) => s.id);

  return (
    <div className="set-invite" data-testid="workflow-row">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="set-invite__code">{typeValue}</span>
        <span className="set-invite__meta" data-testid="workflow-summary">
          {rule === null ? 'no rule — all statuses allowed' : `allows ${stored.length} of ${vocabulary.length}`}
        </span>
        <div className="set-section__grow" />
        {!declared ? (
          <span className="set-invite__meta">
            not a declared {WORKFLOW_AXIS} value — this rule is inert until the value returns
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {vocabulary.map((status) =>
          STRUCTURAL_STATUSES.includes(status.id) ? (
            <label key={status.id} className="set-invite__meta">
              <input
                type="checkbox"
                checked
                disabled
                aria-label={`${status.label} is structural for ${typeValue}`}
                /* The schema's reason, at the control: 132's check constraint
                   requires these three in every vocabulary — creation writes
                   open, the spawn door writes working, complete writes done —
                   so no space can author them out. */
                title={`${status.label} is structural — every workflow must keep open, working and done`}
              />
              {status.label}
            </label>
          ) : (
            <label key={status.id} className="set-invite__meta">
              <input
                type="checkbox"
                checked={checked.includes(status.id)}
                disabled={busy}
                aria-label={`${typeValue} allows ${status.label}`}
                onChange={(e) =>
                  setChecked((prior) =>
                    e.target.checked ? [...prior, status.id] : prior.filter((v) => v !== status.id),
                  )
                }
              />
              {status.label}
            </label>
          ),
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="set-refuse--block"
          data-testid="workflow-save"
          disabled={busy}
          onClick={() => onSave(statuses)}
        >
          {busy ? 'Working…' : `Save workflow for ${typeValue}`}
        </button>
        {rule !== null ? (
          <button
            type="button"
            className="set-invite__meta"
            data-testid="workflow-delete"
            disabled={busy}
            onClick={() => onDelete(rule.id)}
          >
            {`remove workflow for ${typeValue}`}
          </button>
        ) : null}
      </div>
      <span className="set-invite__stamp">
        {rule === null
          ? `saving narrows which statuses ${typeValue} tasks can be moved to; the server refuses anything else`
          : /* 132's own comment, at the control: deleting is widen-back. */
            `removing this rule widens ${typeValue} back to every status — never data loss, no task changes`}
      </span>
    </div>
  );
}
