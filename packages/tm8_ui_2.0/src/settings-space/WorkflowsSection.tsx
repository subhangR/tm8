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
 *
 * ── LAYOUT PASS, 2026-08-16 (settings frame wave) ────────────────────────────
 *
 * Four defects, each MEASURED in Chrome against the real stylesheets before it
 * was touched (SECTION-CONTRACT.md §8), not inferred:
 *
 * 1. NO SECTION ROOT. This file returned a bare fragment, so `.set-section`
 *    never existed and its head/scroller were adopted by `.set-body` directly.
 *    `document.querySelector('.set-section')` was null in every one of the five
 *    states dumped. Now `SectionFrame`, which is the only thing allowed to
 *    write those three class names (§2).
 *
 * 2. NO MEASURE. `.set-section__measure` was likewise absent, so the intro
 *    prose ran the full card — 752px at 1508x882, and 1044px at the card's own
 *    `--set-card-max`. `SectionFrame`'s default `measure` caps it at 860.
 *
 * 3. THE PARTIAL READ WAS ANSWERED WITH A FALSEHOOD, and it hid data. This is
 *    the only section reading TWO registries, so it has a state no sibling has:
 *    `axes === null` with `workflows` non-null. The old branch was
 *    `workflows === null || axes === null`, which told that case "The workflow
 *    registry has not been read" — a measurably false sentence; the workflow
 *    registry was read and its rules were sitting in the props — and then
 *    rendered nothing, so a stored rule could be neither seen nor deleted. The
 *    same hole existed for a space whose `type` axis is gone: every rule became
 *    `undeclared`, and the `typeAxis === null` early return hid all of them.
 *    The two reads now fail SEPARATELY, and stored rules survive either failure
 *    — marked `unverifiable` (axis unread: cannot say whether it is in force)
 *    or `inert` (axis read, value not declared).
 *
 * 4. THE ORDER WAS INVISIBLE, and the primary action was a banner. Seven
 *    checkboxes wrapped in one undifferentiated row showed neither the
 *    lifecycle they are drawn from nor which three the schema locks; Save wore
 *    `.set-refuse--block` (`display:block; width:100%`) and measured 886px.
 *
 * ON "ORDERED LIST" — CORRECTING THE BRIEF. This lane was asked to show the
 * statuses as an ordered list because "a workflow is a type key plus an ORDERED
 * list of statuses". Measured, that is not what a workflow is:
 * `task_workflows.statuses` is `text[]` under `statuses <@ array[...]` (a
 * SUBSET check, 132:122) and the enforcing trigger tests membership only
 * (`new.work_status <> all (vocab)`, 132:163); 132's own header says "the
 * SUBSET of the seven work statuses that tasks of that type may be moved TO.
 * There is no transition matrix". The stored array's order carries no meaning
 * and the server never reads it. What IS ordered is the seven-status LIFECYCLE
 * the subset is drawn from (`TASK_STATE_CONTROL.options`, and
 * `workflowStatusVocabulary()` returns it in that order). So the order shown
 * here is the lifecycle's, each status carrying its true position 1..7 across
 * both groups, and the caption says "a set, not a chain" so nobody reads a
 * transition matrix into a sequence the schema deliberately does not have.
 * Saving normalises the write to lifecycle order for the same reason: it is
 * free, it makes two equal vocabularies compare equal, and no reader depends
 * on it.
 */
import { useState } from 'react';
import type { TaskAxis, TaskWorkflow, TaskWorkflowInput } from '@tm8/contract';
import { STRUCTURAL_STATUSES, WORKFLOW_AXIS } from '../domain';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { workflowStatusVocabulary } from './port';
import { SETTINGS_SECTIONS } from './types';
import './workflows-section.css';

type WorkflowWrite = Omit<TaskWorkflowInput, 'clientMutationId' | 'actorId'>;

/**
 * How much this view can say about whether a stored rule is in force.
 * `unverifiable` exists because the axis read can fail on its own — see the
 * header, defect 3. Collapsing it into `inert` would state a fact this render
 * does not have.
 */
type Standing = 'declared' | 'inert' | 'unverifiable';

/** The section's own heading, from the registry rather than a re-typed copy (§2). */
const HEADING = SETTINGS_SECTIONS.find((s) => s.id === 'workflows')?.heading ?? 'Workflows';

export interface WorkflowsSectionProps {
  /** The axis registry — `null` = the settings read failed. The `type` axis's values are the row set. */
  axes: readonly TaskAxis[] | null;
  /** `null` = the settings read failed; `[]` = a measured "no rules defined". */
  workflows: readonly TaskWorkflow[] | null;
  onUpsert: (input: WorkflowWrite) => Promise<void>;
  onDelete: (workflowId: string) => Promise<void>;
  /** Overridable only so a host can render the section under a different registry heading. */
  heading?: string;
}

export function WorkflowsSection({
  axes,
  workflows,
  onUpsert,
  onDelete,
  heading = HEADING,
}: WorkflowsSectionProps) {
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

  const vocabulary = workflowStatusVocabulary();
  const axesUnread = axes === null;
  const typeAxis = axes?.find((a) => a.name === WORKFLOW_AXIS) ?? null;
  const declared = typeAxis?.axisValues ?? [];
  const stored = workflows ?? [];
  /* Rules the axis does not (or cannot) account for. With the axis unread every
     rule lands here as `unverifiable`; with it read, only values it no longer
     declares, as `inert`. Either way they RENDER — the bug this replaces was
     that they did not. */
  const unaccounted = axesUnread ? stored : stored.filter((w) => !declared.includes(w.typeValue));
  const standing: Standing = axesUnread ? 'unverifiable' : 'inert';

  const ruledCount = declared.filter((v) => stored.some((w) => w.typeValue === v)).length;

  const alert = failure ? (
    <span className="set-workflows__error" role="alert" data-testid="workflows-error">
      {failure}
    </span>
  ) : null;

  function rowFor(typeValue: string, rule: TaskWorkflow | null, rowStanding: Standing) {
    return (
      <WorkflowRow
        key={rule ? rule.id : typeValue}
        typeValue={typeValue}
        rule={rule}
        standing={rowStanding}
        busy={busy}
        vocabulary={vocabulary}
        onSave={(statuses) => void run(() => onUpsert({ typeValue, statuses: statuses as never }))}
        onDelete={(workflowId) => void run(() => onDelete(workflowId))}
      />
    );
  }

  /* The unaccounted rules, rendered under whichever absence explains them. A
     list that exists only in this branch is still a list — it gets the same
     container so its rows sit on the same rhythm as the ruled ones. */
  const strays =
    unaccounted.length > 0 ? (
      <div className="set-workflows__list" data-testid="workflows-stray-list">
        {unaccounted.map((rule) => rowFor(rule.typeValue, rule, standing))}
      </div>
    ) : null;

  // ── the workflow read failed: nothing below is knowable ──────────────────
  if (workflows === null) {
    return (
      <SectionFrame title={heading} bodyTestId="workflows-body">
        {alert}
        <SectionAbsent
          testId="workflows-absent"
          head="The workflow registry has not been read."
          why={
            axesUnread
              ? 'the settings read did not resolve — neither the workflow rules nor the axes they key on arrived; this is an unread, not a space with no workflows'
              : 'the settings read did not resolve — this is an unread, not a space with no workflows'
          }
        />
      </SectionFrame>
    );
  }

  // ── the workflows arrived, the axes did not: say WHICH read failed ───────
  if (axesUnread) {
    return (
      <SectionFrame title={heading} bodyTestId="workflows-body">
        {alert}
        <SectionAbsent
          testId="workflows-axes-absent"
          head={`The ${WORKFLOW_AXIS} axis has not been read, so no rule below can be checked against it.`}
          why={`the workflow rules themselves DID arrive and are shown — what is missing is the axis that says which ${WORKFLOW_AXIS} values exist, so this view cannot tell an in-force rule from an inert one, and cannot offer an editor for a value it has never seen`}
        />
        {strays}
      </SectionFrame>
    );
  }

  // ── no `type` axis at all: nothing to key a rule on ──────────────────────
  if (typeAxis === null) {
    return (
      <SectionFrame title={heading} bodyTestId="workflows-body">
        {alert}
        <SectionAbsent
          testId="workflows-no-axis"
          head={`This space has no ${WORKFLOW_AXIS} axis, so there is nothing to key a workflow on.`}
          why={`workflows narrow the status vocabulary per ${WORKFLOW_AXIS} value — define the axis under Task axes and its values gain an editor here`}
        />
        {strays}
      </SectionFrame>
    );
  }

  // ── the axis exists but declares no values: free text keys nothing ───────
  if (declared.length === 0) {
    return (
      <SectionFrame title={heading} bodyTestId="workflows-body">
        {alert}
        <SectionAbsent
          testId="workflows-no-values"
          head={`The ${WORKFLOW_AXIS} axis declares no values, so no workflow can be keyed yet.`}
          why={`an axis with no values means free text (Task axes says so on the row), and a rule keys on one declared value — add values to ${WORKFLOW_AXIS} under Task axes and each one gains its own editor here`}
        />
        {strays}
      </SectionFrame>
    );
  }

  return (
    <SectionFrame
      title={heading}
      bodyTestId="workflows-body"
      action={
        <span className="set-workflows__count" data-testid="workflows-count">
          {ruledCount} of {declared.length} narrowed
        </span>
      }
    >
      {alert}
      {/* The two facts that hold for EVERY row, stated once. They used to be
          per-row copy; at five rows that was ten repeated lines and roughly a
          third of the section's scroll height, and a sentence a reader has
          already skipped four times is not a sentence that is being read. */}
      <span className="set-prose set-workflows__intro">
        Each {WORKFLOW_AXIS} value below can narrow which statuses its tasks may be moved to. A task
        re-typed outside its vocabulary is flagged off-workflow — never rewritten. Statuses are shown
        in lifecycle order, numbered 1–{vocabulary.length}: a vocabulary is a set, not a transition
        chain, so any allowed status can be moved to from any other.
      </span>
      <div className="set-workflows__list">
        {declared.map((value) =>
          rowFor(value, stored.find((w) => w.typeValue === value) ?? null, 'declared'),
        )}
        {unaccounted.map((rule) => rowFor(rule.typeValue, rule, 'inert'))}
      </div>
    </SectionFrame>
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
  standing,
  busy,
  vocabulary,
  onSave,
  onDelete,
}: {
  typeValue: string;
  rule: TaskWorkflow | null;
  standing: Standing;
  busy: boolean;
  vocabulary: ReadonlyArray<{ id: string; label: string }>;
  onSave: (statuses: string[]) => void;
  onDelete: (workflowId: string) => void;
}) {
  const storedStatuses = rule === null ? vocabulary.map((s) => s.id) : (rule.statuses as readonly string[]);
  const [checked, setChecked] = useState<readonly string[]>(storedStatuses);

  /* The write, in lifecycle order — see the file header on why normalising is
     safe: the server reads this array as a set. */
  const statuses = vocabulary
    .filter((s) => STRUCTURAL_STATUSES.includes(s.id) || checked.includes(s.id))
    .map((s) => s.id);

  const structural = vocabulary.filter((s) => STRUCTURAL_STATUSES.includes(s.id));
  const narrowable = vocabulary.filter((s) => !STRUCTURAL_STATUSES.includes(s.id));

  /* A rule that exists and matches its draft has nothing to save, and a live
     button over a no-op write is how a user learns to distrust the button.
     With NO rule, Save always stands: creating a rule that allows all seven is
     a different stored state from having no rule at all, and it is the only
     door to the first one. */
  const dirty =
    rule === null ||
    statuses.length !== storedStatuses.length ||
    statuses.some((s) => !storedStatuses.includes(s));

  const inert = standing !== 'declared';

  return (
    <div
      className={`set-workflows__row${inert ? ' set-workflows__row--inert' : ''}`}
      data-testid="workflow-row"
      data-standing={standing}
    >
      <div className="set-workflows__head">
        <span className="set-workflows__name">{typeValue}</span>
        <span
          className={`set-workflows__pill set-workflows__pill--${rule === null ? 'unruled' : 'ruled'}`}
        >
          {rule === null ? 'no rule' : 'narrowed'}
        </span>
        <span className="set-workflows__summary" data-testid="workflow-summary">
          {rule === null
            ? 'no rule — all statuses allowed'
            : `allows ${storedStatuses.length} of ${vocabulary.length}`}
        </span>
        <div className="set-workflows__grow" />
        {standing === 'inert' ? (
          <span className="set-workflows__pill set-workflows__pill--inert">
            not a declared {WORKFLOW_AXIS} value — this rule is inert until the value returns
          </span>
        ) : null}
        {standing === 'unverifiable' ? (
          <span className="set-workflows__pill set-workflows__pill--inert">
            the {WORKFLOW_AXIS} axis is unread — whether this rule is in force is not knowable here
          </span>
        ) : null}
      </div>

      {/* THE ORDER, for the vocabulary as it stands. `·` and not `→`: 132 has no
          transition matrix, and an arrow would draw one. */}
      <span className="set-workflows__path" data-testid="workflow-path">
        {statuses.map((id, i) => (
          <span key={id}>
            {i > 0 ? <span className="set-workflows__path-sep">·</span> : null}
            {vocabulary.find((s) => s.id === id)?.label ?? id}
          </span>
        ))}
      </span>

      <fieldset className="set-workflows__groups">
        <div className="set-workflows__group">
          <span className="set-workflows__legend">Always allowed — the schema's three</span>
          <div className="set-workflows__boxes">
            {structural.map((status) => {
              /* The schema's reason, at the control: 132's check constraint
                 requires these three in every vocabulary — creation writes
                 open, the spawn door writes working, complete writes done —
                 so no space can author them out. On BOTH nodes deliberately:
                 on the label so the whole chip is the tooltip target now that
                 it is one, and on the input because a disabled checkbox is
                 where a reader looks for why it is disabled. */
              const why = `${status.label} is structural — every workflow must keep open, working and done`;
              return (
                <label
                  key={status.id}
                  className="set-workflows__box set-workflows__box--locked"
                  title={why}
                >
                  <span className="set-workflows__ord">{ordinalOf(vocabulary, status.id)}</span>
                  <input
                    type="checkbox"
                    checked
                    disabled
                    aria-label={`${status.label} is structural for ${typeValue}`}
                    title={why}
                  />
                  {status.label}
                </label>
              );
            })}
          </div>
        </div>

        <div className="set-workflows__group">
          <span className="set-workflows__legend">This type may also be moved to</span>
          <div className="set-workflows__boxes">
            {narrowable.map((status) => {
              const on = checked.includes(status.id);
              return (
                <label
                  key={status.id}
                  className={[
                    'set-workflows__box',
                    on ? 'set-workflows__box--on' : '',
                    busy ? 'set-workflows__box--disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="set-workflows__ord">{ordinalOf(vocabulary, status.id)}</span>
                  <input
                    type="checkbox"
                    checked={on}
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
              );
            })}
          </div>
        </div>
      </fieldset>

      <div className="set-workflows__acts">
        <button
          type="button"
          className="set-chip set-workflows__save"
          data-testid="workflow-save"
          disabled={busy || !dirty}
          title={
            dirty
              ? undefined
              : `${typeValue} already allows exactly these statuses — nothing to save`
          }
          onClick={() => onSave(statuses)}
        >
          {/* `Save workflow for <value>` and not a shorter `Save changes`: the
              shell's own sweep (`settings.test.tsx` LIVE_VERBS) allows this
              section exactly `/^Save workflow for /` and `/^remove workflow
              for /`, and that file is shared by twelve lanes — a nicer label
              here is not worth a rename in a file none of us owns. The
              create-vs-update distinction is carried by the `no rule` pill and
              the stamp instead, which is where it reads better anyway. */}
          {busy ? 'Working…' : `Save workflow for ${typeValue}`}
        </button>
        {rule !== null ? (
          <button
            type="button"
            className="set-ghost set-workflows__remove"
            data-testid="workflow-delete"
            disabled={busy}
            onClick={() => onDelete(rule.id)}
          >
            {`remove workflow for ${typeValue}`}
          </button>
        ) : null}
      </div>
      <span className="set-workflows__stamp">
        {rule === null
          ? `saving narrows which statuses ${typeValue} tasks can be moved to; the server refuses anything else`
          : /* 132's own comment, at the control: deleting is widen-back. */
            `removing this rule widens ${typeValue} back to every status — never data loss, no task changes`}
      </span>
    </div>
  );
}

/** A status's 1-based position in the lifecycle, true across both groups. */
function ordinalOf(vocabulary: ReadonlyArray<{ id: string }>, id: string): number {
  return vocabulary.findIndex((s) => s.id === id) + 1;
}
