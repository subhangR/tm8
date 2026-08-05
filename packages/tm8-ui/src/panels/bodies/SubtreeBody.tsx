import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AcceptanceCriterion, EntityDetail, EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { ContentBlockRef, KindConfig, StatusSource } from '../../domain';
import { getKind } from '../../domain';
import { Avatar, Chip, Eyebrow } from '../../kit';
import { DisabledIconControl, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import './subtree-body.css';

/**
 * THE SUBTREE ARCHETYPE BODY — T0-4 frame 2, the `task` region.
 *
 * Anatomy, in the order D48.1 rules (grid → description → ACCEPTANCE →
 * SUBTREE → RUNS → LINKED). T0-4's own anatomy frame puts the description
 * ABOVE the grid and its 12-kinds card puts it below; the two disagree inside
 * one canvas, so the ledger's order wins rather than a coin toss. ACCEPTANCE
 * sits with the description because both are the task's OWN definition; the
 * three regions after it are its relations.
 *
 * IT IS AN ARCHETYPE, NOT A KIND. Nothing here knows what a task is. Every
 * per-kind decision is answered by the REGISTRY ROW of the entity in hand:
 *
 *   · which children are child WORK and which are RUNS — a kind whose row
 *     carries a `liveTreatment` is a kind whose rows present a seam liveness
 *     verdict, which is precisely what the RUNS region is for;
 *   · whether a child is DONE — its status value appears in its own kind's
 *     `done` lifecycle tier filter (D41/D56 made those tiers contract-shaped,
 *     so this reads real query values, not a list this file remembers);
 *   · the WORD for a status — `panel.statusPill.labels`, the D22 home;
 *   · the parent's row LABEL — so the grid reads "Project ⬒ tm8-ui" for a
 *     project parent and "Task ◻ …" for a task parent with no branch.
 *
 * Member-name reads (`state.priority`, `content.description`) are the
 * GenericBody idiom — structural questions about the shape in hand, never
 * "is this a task?" — and they are what keeps §15.2's guard green.
 *
 * ACCEPTANCE was the A2 deferral (D30, D48.2) and is now drawn — the reversal
 * is RULED, in D73, not taken in a render file. The criteria ride in
 * `content.acceptanceCriteria`, which the detail read has always hydrated, so
 * the panel was showing a task with none of the conditions that decide whether
 * it is finished. It is still a STRUCTURAL read — a content shape that carries
 * no criteria member gets no region, which is how the archetype stays free of
 * "is this a task?".
 *
 * WHAT IT DOES NOT DRAW, and why that is a ruling rather than an omission:
 *   · A `＋ add child…` that silently does nothing — R7: it renders disabled
 *     with its reason until a dispatch is wired.
 */

export interface SubtreeBodyProps {
  detail: EntityDetail;
  /**
   * The GenericBody block list, accepted so the wiring is a drop-in swap.
   * CONSUMED FOR `notice` ONLY: this archetype's regions come from the
   * entity's own structure, not from block composition. A subtree row that
   * declared any other block would render nothing — so the test file asserts
   * no such row exists rather than leaving it to be noticed on screen.
   */
  blocks?: readonly ContentBlockRef[];
  /**
   * THE VERDICT, per run row — `seam.liveness.statusOf`, handed down.
   *
   * Never derived here and never read off the record beside it: a run row's
   * `state.status` says "running" for a session whose node restarted, and
   * rendering that word is the exact lie D6 exists to forbid. `undefined`
   * means NOT MEASURED, and renders hollow — never "not running".
   */
  livenessOf?: (sessionId: string) => SessionLiveness | undefined;
  onOpenEntity?: (id: string) => void;
  /** Wired ⇒ `＋ add child…` is live; absent ⇒ it renders disabled (R7). */
  onAddChild?: () => void;
  /** Current staged value; undefined means use the persisted description. */
  descriptionDraft?: string;
  /** Present only when this task can actually be patched. */
  onDescriptionChange?: (description: string) => void;
  descriptionUnavailableReason?: string;
  /** Staged criteria; undefined means use the persisted ones. */
  criteriaDraft?: readonly AcceptanceCriterion[];
  /**
   * Handed the WHOLE next array, never one criterion — a SHAPE choice, and
   * NOT a concurrency defence. An earlier version of this comment claimed it
   * was one ("a caller given a single flip would rebuild from a stale copy");
   * that was false. `acceptanceCriteria` is patched as a unit, so the array is
   * rebuilt either way, and the array rebuilt HERE is `criteriaDraft ??
   * persisted` — the currently-RENDERED list, which may already be stale.
   * Handing it whole only moves where the stale copy is read; it centralises
   * the rebuild, which is worth doing, and prevents nothing.
   *
   * THE ACTUAL DEFENCE is `useTaskSave`'s `expectedVersion`, captured at the
   * FIRST edit and never re-read at save time: a write that lands while the
   * boxes are being ticked becomes a 409 the user answers, not a silent
   * overwrite. See that hook's `overwrite()` for the collection-specific edge
   * it refuses.
   */
  onCriteriaChange?: (next: AcceptanceCriterion[]) => void;
  /**
   * A reason present WINS over a handler. Passing both resolves to REFUSAL —
   * never a live, clickable box wearing a refusal tooltip.
   */
  criteriaUnavailableReason?: string;
}

export function SubtreeBody({
  detail,
  blocks,
  livenessOf,
  onOpenEntity,
  onAddChild,
  descriptionDraft,
  onDescriptionChange,
  descriptionUnavailableReason,
  criteriaDraft,
  onCriteriaChange,
  criteriaUnavailableReason,
}: SubtreeBodyProps) {
  const children = [...detail.hierarchy.children.items];
  const childWork = children.filter((c) => !isRunKind(c));
  const runs = dedupe([...children.filter(isRunKind), ...peersOf(detail).filter(isRunKind)]);
  const linked = dedupe(peersOf(detail).filter((p) => !isRunKind(p)));
  const notices = (blocks ?? []).filter((b) => b.block === 'notice');

  return (
    <div
      className="pn-body sb-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
      data-testid="subtree-body"
    >
      <MetaGrid detail={detail} onOpenEntity={onOpenEntity} />
      <DescriptionEditor
        detail={detail}
        draft={descriptionDraft}
        onChange={onDescriptionChange}
        unavailableReason={descriptionUnavailableReason}
      />
      <AcceptanceSection
        detail={detail}
        draft={criteriaDraft}
        onChange={onCriteriaChange}
        unavailableReason={criteriaUnavailableReason}
      />
      <SubtreeSection
        detail={detail}
        childWork={childWork}
        onOpenEntity={onOpenEntity}
        onAddChild={onAddChild}
      />
      <RunsSection runs={runs} livenessOf={livenessOf} onOpenEntity={onOpenEntity} />
      <LinkedSection linked={linked} onOpenEntity={onOpenEntity} />
      {notices.length > 0 ? (
        <div className="sb-notices" data-testid="subtree-notices">
          {notices.map((block, i) => {
            const text = typeof block.params?.text === 'string' ? block.params.text : null;
            return text ? (
              <p className="pn-notice" key={`${block.block}:${i}`}>
                {text}
              </p>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The composed metadata grid — T0-4 `grid-template-columns:1fr 1fr;gap:6px 12px`
// ---------------------------------------------------------------------------

/**
 * Members the grid never draws as a plain row, each for its own reason:
 *   · `kind` is the discriminator, not content;
 *   · the pill source is already in the header — one fact, one rendering, or
 *     the two drift the first time either is edited;
 *   · `acceptance` is the n/m SUMMARY of the criteria the ACCEPTANCE region
 *     draws in full — counting them twice is the same drift;
 *   · the rest have composed cells below.
 */
const COMPOSED_KEYS = new Set(['kind', 'acceptance', 'assignees', 'priority', 'dueDate', 'axes']);

function MetaGrid({ detail, onOpenEntity }: { detail: EntityDetail; onOpenEntity?: (id: string) => void }) {
  const state = detail.state as unknown as Record<string, unknown>;
  const content = detail.content as unknown as Record<string, unknown>;
  const config = getKind(detail.kind);
  const pillKey = statusFieldOf(config);
  const parent = detail.hierarchy.parent;

  const cells: { key: string; label: string; value: ReactNode }[] = [];

  /**
   * Fields the CONTROL STRIP now owns, and which this grid must therefore not
   * draw a second time.
   *
   * This is the D67 amendment's rule applied to the panel. The tile used to
   * carry static status / priority / assignee chips ABOVE a working control
   * strip, and the reported bug was "the buttons are broken" when in truth the
   * things that looked like buttons were `<span>`s and the real control was
   * elsewhere. The panel had the identical shape: a read-only `PRIORITY: HIGH`
   * tag and an avatar row in this grid. Now that the strip is mounted above,
   * repeating them here would rebuild that exact confusion.
   *
   * Derived from the SAME registry declarations the strip reads, so the grid
   * cannot fall out of step with it — a kind with no `assignControl` keeps its
   * read-only assignee row, because for that kind the row is the only truth
   * available and suppressing it would hide a fact rather than de-duplicate
   * one.
   */
  const controlled = new Set<string>(
    [
      ...(config.list.valueControls ?? []).map((c) => c.source),
      ...(config.list.assignControl ? [config.list.assignControl.source] : []),
    ],
  );

  const assignees = Array.isArray(state.assignees) ? (state.assignees as EntitySummary['createdBy'][]) : [];
  if (assignees.length > 0 && !controlled.has('assignees')) {
    cells.push({
      key: 'assignees',
      label: assignees.length > 1 ? 'Assignees' : 'Assignee',
      value: (
        <span className="sb-actors">
          {assignees.map((actor) => (
            <span className="sb-actor" key={actor.id}>
              {/* Shape IS provenance (kit law): humans round, agents rounded-
                  square. The oracle's ◯ is that same round mark for a human. */}
              <Avatar actorId={actor.id} provenance={actor.isAgent ? 'agent' : 'human'} label={actor.displayName} size={15} src={actor.avatar ?? null} />
              <span className="sb-grid__strong">@{actor.displayName}</span>
            </span>
          ))}
        </span>
      ),
    });
  }

  if (typeof state.priority === 'string' && state.priority.length > 0 && !controlled.has('priority')) {
    cells.push({
      key: 'priority',
      label: 'Priority',
      // T0-4 draws the abbreviation `MED`. We render the value uppercased in
      // full: an abbreviation is a WORD, and D22 puts words in the registry —
      // inventing one in a render path is how two surfaces come to disagree.
      value: <span className="sb-tag">{state.priority.toUpperCase()}</span>,
    });
  }

  // The estimate lives in CONTENT, not state — the same member-name read the
  // description does one region below, and the reason the grid was silent
  // about a field the create and patch inputs have always carried.
  if (typeof content.pointsEstimate === 'number') {
    cells.push({
      key: 'pointsEstimate',
      label: 'Points',
      value: <span className="sb-grid__strong">{content.pointsEstimate}</span>,
    });
  }

  if (parent) {
    cells.push({
      key: 'parent',
      label: getKind(parent.kind).label,
      value: (
        <button type="button" className="sb-grid__link" onClick={() => onOpenEntity?.(parent.id)}>
          <span aria-hidden>{getKind(parent.kind).chip.glyph}</span> {parent.title}
        </button>
      ),
    });
  }

  if (typeof state.dueDate === 'string' && state.dueDate.length > 0) {
    cells.push({ key: 'dueDate', label: 'Due', value: <span className="sb-grid__mono">{state.dueDate}</span> });
  }

  cells.push({ key: 'id', label: 'ID', value: <span className="sb-grid__mono">{detail.id}</span> });

  if (isRecord(state.axes)) {
    for (const [axis, value] of Object.entries(state.axes)) {
      const rendered = renderScalar(value);
      if (rendered != null) {
        cells.push({
          key: `axis:${axis}`,
          label: humanizeKey(axis),
          value: <span className="sb-grid__strong">{rendered}</span>,
        });
      }
    }
  }

  // Whatever else the state carries — a custom kind's scalars land here rather
  // than being silently dropped for not being on a list written before it.
  for (const [key, value] of Object.entries(state)) {
    if (COMPOSED_KEYS.has(key) || key === pillKey) continue;
    const rendered = renderScalar(value);
    if (rendered != null) {
      cells.push({ key, label: humanizeKey(key), value: <span className="sb-grid__strong">{rendered}</span> });
    }
  }

  if (cells.length === 0) return null;
  return (
    <div className="sb-grid" data-testid="subtree-grid">
      {cells.map((cell) => (
        <div className="sb-grid__cell" key={cell.key}>
          <span className="sb-grid__label">{cell.label}</span> {cell.value}
        </div>
      ))}
    </div>
  );
}

function DescriptionEditor({
  detail,
  draft,
  onChange,
  unavailableReason,
}: {
  detail: EntityDetail;
  draft?: string;
  onChange?: (description: string) => void;
  unavailableReason?: string;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const persisted =
    typeof content.description === 'string'
      ? content.description
      : typeof content.body === 'string'
        ? content.body
        : '';
  const value = draft ?? persisted;
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // The field has no internal scroll. Its box follows scrollHeight, which
  // pushes every later task region downward in the body's normal document flow.
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.max(node.scrollHeight, 72)}px`;
  }, [value]);

  return (
    <label className="sb-description" data-testid="task-description-editor">
      <span className="sb-description__label">Description</span>
      <textarea
        ref={textarea}
        className="sb-description__input"
        aria-label="Description"
        value={value}
        placeholder="Add a description…"
        readOnly={!onChange}
        title={unavailableReason}
        rows={1}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// ACCEPTANCE — the conditions that decide whether the work is finished
// ---------------------------------------------------------------------------

function AcceptanceSection({
  detail,
  draft,
  onChange,
  unavailableReason,
}: {
  detail: EntityDetail;
  draft?: readonly AcceptanceCriterion[];
  onChange?: (next: AcceptanceCriterion[]) => void;
  unavailableReason?: string;
}) {
  const content = detail.content as unknown as Record<string, unknown>;
  const persisted = content.acceptanceCriteria;
  /*
   * ABSENT MEMBER ⇒ NO REGION, and that is the archetype law rather than a
   * tidy-up: a content shape with no criteria member has no acceptance to be
   * silent about, so drawing an empty one would invent a concept for kinds
   * that do not have it. An EMPTY ARRAY is a different fact — the task has
   * none yet — and gets the region with its own quiet line.
   */
  if (!Array.isArray(persisted)) return null;
  const criteria = (draft ?? persisted) as readonly AcceptanceCriterion[];
  const completed = criteria.filter((c) => c.done).length;
  /*
   * A REASON WINS OVER A HANDLER. `disabled={!onChange}` alone left a caller
   * that passed BOTH with live, clickable boxes wearing a refusal tooltip —
   * the control saying one thing and doing another. Both arms of the refusal
   * are now the same decision.
   */
  const editable = onChange != null && unavailableReason == null;

  return (
    <section className="sb-section" data-testid="acceptance-section">
      <Eyebrow faint>
        ACCEPTANCE · {completed}/{criteria.length}
      </Eyebrow>
      {criteria.length === 0 ? (
        <p className="pn-section__empty">No acceptance criteria on this yet.</p>
      ) : (
        <div className="sb-rows">
          {criteria.map((criterion, index) => {
            const text = (
              <span
                className={
                  criterion.done ? 'sb-criterion__text sb-criterion__text--done' : 'sb-criterion__text'
                }
              >
                {criterion.text}
              </span>
            );
            const rowProps = {
              className: 'sb-criterion',
              'data-testid': 'acceptance-row',
              'data-done': criterion.done ? 'true' : 'false',
            } as const;
            const key = criterion.id || `criterion-${index}`;

            /*
             * REFUSAL USES THE HONESTY VOCABULARY, not a native `disabled`
             * plus a `title`. DisabledWithReason rules the native attribute
             * out in terms: a natively disabled input is removed from the tab
             * order, so a keyboard-only user can never reach it and therefore
             * can never learn WHY — which defeats the whole treatment. The
             * same file's `add child…` control two regions down already does
             * this correctly; this region was reusing its cause—remedy STRING
             * and dropping it into a tooltip.
             */
            if (!editable) {
              return (
                <div key={key} {...rowProps}>
                  <DisabledIconControl
                    label={criterion.text}
                    glyph={criterion.done ? '☑' : '☐'}
                    reason={unavailableReason ? toReason(unavailableReason) : NOT_WIRED_REASON}
                  />
                  {text}
                </div>
              );
            }

            return (
              <label key={key} {...rowProps}>
                <input
                  type="checkbox"
                  className="sb-criterion__box"
                  checked={criterion.done}
                  onChange={(event) =>
                    onChange(
                      criteria.map((c, i) => (i === index ? withDone(c, event.target.checked) : c)),
                    )
                  }
                />
                {text}
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * FLIPPING ONE CRITERION, with its PROVENANCE kept truthful.
 *
 * `{...criterion, done}` — what this did — is wrong at the un-tick edge:
 * `doneBy`/`doneAt` survive verbatim beside `done:false`, so the record reads
 * "not done, completed by forge at 09:14". The server normalizer
 * (`entities-commands-tracking.ts:acceptanceCriteria`) passes both through
 * verbatim too, so nothing downstream corrects it. Un-ticking therefore DROPS
 * the stamp here.
 *
 * SETTING it on a tick is deliberately NOT done here: this client knows
 * neither the acting member id at this depth nor a clock anyone should trust.
 * That stamp belongs to the server, which has both, and is applied there.
 */
function withDone(criterion: AcceptanceCriterion, done: boolean): AcceptanceCriterion {
  return done ? { ...criterion, done: true } : { id: criterion.id, text: criterion.text, done: false };
}

// ---------------------------------------------------------------------------
// SUBTREE
// ---------------------------------------------------------------------------

function SubtreeSection({
  detail,
  childWork,
  onOpenEntity,
  onAddChild,
}: {
  detail: EntityDetail;
  childWork: readonly EntitySummary[];
  onOpenEntity?: (id: string) => void;
  onAddChild?: () => void;
}) {
  const total = detail.hierarchy.children.total;
  const config = getKind(detail.kind);
  const addChildReason = detail.capabilities.canAddChild
    ? null
    : (config.panel.capabilityReasons?.canAddChild ??
      'This entity does not accept children for you — the server withheld the capability.');

  return (
    <section className="sb-section" data-testid="subtree-section">
      <Eyebrow faint>SUBTREE · {childWork.length}</Eyebrow>
      {childWork.length === 0 ? (
        <p className="pn-section__empty">No child work under this yet.</p>
      ) : (
        <div className="sb-rows">
          {childWork.map((child) => (
            <SubtreeRow key={child.id} child={child} onOpenEntity={onOpenEntity} />
          ))}
        </div>
      )}
      {/* An honest partial page. `total` counts the whole subtree; only the
          hydrated items can be listed, and saying so beats a count nobody can
          reconcile with the rows under it. */}
      {typeof total === 'number' && total > detail.hierarchy.children.items.length ? (
        <p className="pn-section__empty">
          {detail.hierarchy.children.items.length} of {total} loaded.
        </p>
      ) : null}
      {onAddChild && !addChildReason ? (
        <button type="button" className="sb-addchild" onClick={onAddChild}>
          ＋ add child…
        </button>
      ) : (
        <DisabledIconControl
          label="Add child"
          glyph="＋"
          reason={addChildReason ? toReason(addChildReason) : NOT_WIRED_REASON}
        >
          add child…
        </DisabledIconControl>
      )}
    </section>
  );
}

function SubtreeRow({ child, onOpenEntity }: { child: EntitySummary; onOpenEntity?: (id: string) => void }) {
  const config = getKind(child.kind);
  const value = statusValueOf(child);
  const done = value != null && closedStatusValues(config).includes(value);
  const tone = value == null ? 'idle' : (config.panel.statusPill?.tones[value] ?? config.chip.tones?.[value] ?? 'idle');
  const word = value == null ? null : (config.panel.statusPill?.labels?.[value] ?? value.replace(/_/g, ' '));

  return (
    <button
      type="button"
      className="sb-row"
      data-testid="subtree-row"
      data-done={done ? 'true' : 'false'}
      onClick={() => onOpenEntity?.(child.id)}
    >
      <span className={`sb-dot sb-dot--${tone}${done ? ' sb-dot--filled' : ''}`} aria-hidden />
      <span className={done ? 'sb-row__title sb-row__title--done' : 'sb-row__title'}>{child.title}</span>
      {word ? <span className={`sb-word sb-word--${tone}`}>{word}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RUNS — the two-source region (D6, brief §2.7)
// ---------------------------------------------------------------------------

function RunsSection({
  runs,
  livenessOf,
  onOpenEntity,
}: {
  runs: readonly EntitySummary[];
  livenessOf?: (sessionId: string) => SessionLiveness | undefined;
  onOpenEntity?: (id: string) => void;
}) {
  const verdicts = runs.map((run) => (livenessOf ? livenessOf(run.id) : undefined));
  const measured = verdicts.filter((v) => v != null).length;
  const live = verdicts.filter((v) => v === 'live').length;

  /*
   * "RUNS · 1 LIVE" is only sayable when somebody actually looked. With no
   * verdicts in hand, "0 LIVE" would claim a measurement that never ran —
   * the same lie of precision the hollow-value law forbids for viewer counts,
   * and the one the gate-evidence screenshot preserves in the other direction
   * ("1 live" above a row reading "not running").
   */
  const count =
    runs.length === 0
      ? `RUNS · ${runs.length}`
      : measured === 0
        ? `RUNS · ${runs.length} · LIVENESS UNVERIFIED`
        : `RUNS · ${runs.length} · ${live} LIVE`;

  return (
    <section className="sb-section" data-testid="runs-section">
      <Eyebrow faint>{count}</Eyebrow>
      {runs.length === 0 ? (
        <p className="pn-section__empty">No runs recorded against this.</p>
      ) : (
        runs.map((run, i) => (
          <RunRow key={run.id} run={run} verdict={verdicts[i]} onOpenEntity={onOpenEntity} />
        ))
      )}
    </section>
  );
}

function RunRow({
  run,
  verdict,
  onOpenEntity,
}: {
  run: EntitySummary;
  verdict: SessionLiveness | undefined;
  onOpenEntity?: (id: string) => void;
}) {
  const config = getKind(run.kind);
  const treatment = verdict != null ? config.list.liveTreatment?.(verdict) : undefined;
  const state = run.state as unknown as Record<string, unknown>;
  const model = typeof state.model === 'string' ? state.model : null;

  return (
    <button type="button" className="sb-run" data-testid="run-row" onClick={() => onOpenEntity?.(run.id)}>
      {/* The verdict dot is SOLID. The oracle draws it pulsing, but pulse
          belongs to the §9.2 activity signal (LiveTreatment.dot, F1/D6) and
          this body is handed no activity source — an animated dot here would
          be presenting a second fact nobody measured. */}
      <span
        className={`sb-run__dot${treatment?.dot === 'solid' ? ` sb-run__dot--${treatment.tone}` : ' sb-run__dot--none'}`}
        aria-hidden
      />
      <Avatar actorId={run.createdBy.id} provenance={run.createdBy.isAgent ? 'agent' : 'human'} label={run.createdBy.displayName} size={15} src={run.createdBy.avatar ?? null} />
      <span className="sb-run__name">{run.title}</span>
      {model ? <span className="sb-run__meta">{model}</span> : null}
      <span className="sb-run__spacer" />
      {treatment ? (
        <span className={`sb-word sb-word--${treatment.tone}`} title={treatment.reason ?? treatment.label}>
          {treatment.shortLabel ?? treatment.label}
        </span>
      ) : (
        <HollowInline caption="No liveness verdict reached this panel for this run — the row states that nothing was measured rather than guessing from the stored status.">
          — unverified
        </HollowInline>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// LINKED
// ---------------------------------------------------------------------------

function LinkedSection({
  linked,
  onOpenEntity,
}: {
  linked: readonly EntitySummary[];
  onOpenEntity?: (id: string) => void;
}) {
  return (
    <section className="sb-section" data-testid="linked-section">
      <Eyebrow faint>LINKED · {linked.length}</Eyebrow>
      {linked.length === 0 ? (
        <p className="pn-section__empty">Nothing linked to this yet.</p>
      ) : (
        <div className="pn-chiprow">
          {linked.map((peer) => (
            <Chip key={peer.id} glyph={getKind(peer.kind).chip.glyph} onClick={() => onOpenEntity?.(peer.id)}>
              {peer.title}
            </Chip>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Registry reads — every per-kind answer in this file comes through here
// ---------------------------------------------------------------------------

/**
 * `StatusSource` → the `EntityState` member it names.
 *
 * A VERBATIM TWIN of `chrome.tsx`'s private map, duplicated because that one
 * is not exported and this lane may not edit that file. Two copies of one
 * mapping can drift; the fix is an export from `detail/chrome.tsx`, proposed
 * to the coordinator rather than taken unilaterally.
 */
const STATUS_FIELD: Record<Exclude<StatusSource, 'none'>, string> = {
  workStatus: 'workStatus',
  sessionStatus: 'status',
  prState: 'state',
  profileStatus: 'status',
  memberRole: 'role',
  equipped: 'equipped',
};

function statusFieldOf(config: KindConfig): string | null {
  const source = config.panel.statusPill?.source ?? config.chip.tintBy;
  return source === 'none' ? null : STATUS_FIELD[source];
}

function statusValueOf(summary: EntitySummary): string | null {
  const field = statusFieldOf(getKind(summary.kind));
  if (!field) return null;
  const raw = (summary.state as unknown as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : null;
}

/**
 * The status values that count as DONE for a kind — read off its `done`
 * LIFECYCLE TIER, which since D56 carries a real contract-shaped filter. A
 * kind whose done tier is `unsupported` has no closed values, so none of its
 * children can be struck: the honest answer, and one nobody had to write.
 */
function closedStatusValues(config: KindConfig): readonly string[] {
  const done = config.list.lifecycle?.find((tier) => tier.id === 'done');
  if (!done || done.unsupported) return [];
  const out: string[] = [];
  for (const member of Object.values(done.filter as unknown as Record<string, unknown>)) {
    if (Array.isArray(member) && member.every((v) => typeof v === 'string')) out.push(...(member as string[]));
  }
  return out;
}

/**
 * A kind belongs in RUNS when its registry row PRESENTS A LIVENESS VERDICT.
 * That is the definition the region needs — "these are the rows a seam verdict
 * speaks about" — and it is a registry fact, so a future kind that gains a
 * `liveTreatment` appears here without this file being touched.
 */
function isRunKind(summary: EntitySummary): boolean {
  return getKind(summary.kind).list.liveTreatment != null;
}

function peersOf(detail: EntityDetail): EntitySummary[] {
  const out: EntitySummary[] = [];
  for (const group of [...detail.connections.outgoing, ...detail.connections.incoming]) {
    for (const edge of group.edges) {
      out.push(edge.source.id === detail.id ? edge.target : edge.source);
    }
  }
  return out;
}

function dedupe(items: readonly EntitySummary[]): EntitySummary[] {
  const seen = new Set<string>();
  const out: EntitySummary[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Scalars only; `null` skips the cell rather than printing the word "null". */
function renderScalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
