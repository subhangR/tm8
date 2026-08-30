import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AcceptanceCriterion, EdgeView, EntityDetail, EntitySummary } from '@tm8/contract';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import type { SessionLiveness } from '../../data/seam';
import type { ContentBlockRef, KindConfig, StatusSource } from '../../domain';
import { KindIcon, getKind } from '../../domain';
import { Avatar, Chip, Eyebrow, Markdown, Timestamp } from '../../kit';
import type { FileUploadTask } from '../../files/upload';
import { ProseField, type TriggerOption } from '../../rich-input';
import { DisabledIconControl, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import {
  CollapsibleSection,
  EmptySectionsToggle,
  useEmptySectionsRevealed,
  useRegisterEmptySection,
} from './CollapsibleSection';
import { MemorySetBlock, edgesOf, type MemoryAuthoring } from './MemorySetBlock';
import { MembershipBlock, type MembershipAuthoring } from './MembershipBlock';
import { PeerRowsBlock } from './PeerRowsBlock';
import './subtree-body.css';
/* Acceptance authoring geometry — its own file per the shared-css convention. */
import './subtree-acceptance.css';

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
   * Working-set authoring for the `memory-set` section. Absent ⇒ the set is
   * read-only rather than drawing dead controls. The body raises intent only;
   * the view performs the write, exactly as on the profile archetype.
   */
  memoryAuthoring?: MemoryAuthoring | null;
  /**
   * Collection-membership authoring for the `membership` section — the same
   * intent-only split as `memoryAuthoring`. Absent ⇒ the section is read-only.
   */
  membershipAuthoring?: MembershipAuthoring | null;
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
  /**
   * The task's GIT section (tracked PRs/commits, provenance, gate verdict) —
   * self-fetching, composed by the host like the panel's debug/git surfaces,
   * because this body is presentational and never reaches for the seam.
   */
  gitSection?: ReactNode;
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
  /**
   * Skills the description's `/` can REFERENCE (R1). Absent ⇒ `/` types plain
   * text, which is what it did before a host had a seam to read them from.
   */
  skillOptions?: readonly TriggerOption[];
  /**
   * Uploads a file against THIS task and writes its reference at the caret
   * (R4). Bound by the host, so this lane never learns the anchor. Absent ⇒
   * drop and paste in the description stay inert.
   */
  attach?: (file: File) => FileUploadTask;
  /** An upload landed — the host refetches so the attachment strip updates. */
  onAttached?: () => void;
  /**
   * The attachment tiles, BUILT by `EntityDetailPanel` (so the strip stays
   * kind-agnostic and no archetype can forget it) and PLACED here, at the
   * bottom of the description block — the 2026-08-16 addendum's position.
   * Never a fold, never part of the empty set.
   */
  attachmentSlot?: ReactNode;
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
  memoryAuthoring,
  membershipAuthoring,
  gitSection,
  skillOptions,
  attach,
  onAttached,
  attachmentSlot,
}: SubtreeBodyProps) {
  const children = [...detail.hierarchy.children.items];
  const childWork = children.filter((c) => !isRunKind(c));
  const runs = dedupe([...children.filter(isRunKind), ...peersOf(detail).filter(isRunKind)]);
  const linked = dedupe(peersOf(detail).filter((p) => !isRunKind(p)));
  const notices = (blocks ?? []).filter((b) => b.block === 'notice');
  /*
   * The memory working set, when the registry row declares it (085: a task
   * holds one exactly as a teammate does, and P2 injects it at spawn).
   *
   * ONE NAMED SECTION, not a generic block renderer. This body draws a fixed
   * anatomy on purpose and growing a `blocks.map` here would invite every
   * future block into a body that has no opinion about them — and a block it
   * did not know would then draw nothing, which is the failure this section
   * exists to fix, reintroduced one level up.
   */
  const memorySet = (blocks ?? []).find((b) => b.block === 'memory-set');
  /*
   * Provenance rows — today the loop that fired this task (`triggered_by`).
   * A SECOND named case, not a generic renderer: the body still knows every
   * block it draws by name, and `RENDERED_BLOCKS` in the test holds the two
   * lists together.
   */
  const peerRows = (blocks ?? []).filter((b) => b.block === 'peer-rows');
  /*
   * Collection membership — a THIRD named case, same rule as the two above:
   * the body knows every block it draws by name. Incoming `contains` edges
   * used to fall through `peersOf` into LINKED as anonymous chips (the exact
   * defect class the memory-set comment records); the section names them and
   * carries the add/remove intent.
   */
  const membership = (blocks ?? []).find((b) => b.block === 'membership');

  /*
   * EMPTINESS, per fold (approved design, 2026-08-16). A fold is empty when
   * it has NO DATA ROWS — a live, unused affordance ("＋ add child…") may hide
   * behind the reveal toggle, but a DISABLED-WITH-REASON affordance never
   * counts as empty: hiding a refusal hides its reason, the exact failure the
   * honesty rules exist to prevent. So each verdict below asks both "are there
   * rows?" and "would hiding this swallow a refusal?".
   */
  const memoryEdgeCount = memorySet ? edgesOf(detail, memorySet.params ?? {}).length : 0;
  const memoriesEmpty =
    memoryEdgeCount === 0 && (memoryAuthoring == null || !memoryAuthoring.refusal);
  const membershipEdgeCount = membership ? edgesOf(detail, membership.params ?? {}).length : 0;
  // MembershipBlock ALWAYS draws its add control — absent authoring renders it
  // disabled-with-reason — so only a LIVE authoring lane can leave the section
  // genuinely empty.
  const membershipEmpty =
    membershipEdgeCount === 0 && membershipAuthoring != null && !membershipAuthoring.refusal;

  return (
    <div
      className="pn-body pn-body--measured sb-body k-enter"
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
        skillOptions={skillOptions}
        attach={attach}
        onAttached={onAttached}
        attachmentSlot={attachmentSlot}
      />
      <AcceptanceSection
        detail={detail}
        draft={criteriaDraft}
        onChange={onCriteriaChange}
        unavailableReason={criteriaUnavailableReason}
      />
      {/* Definition precedes execution: the conditions for done stay directly
          below the brief, then the runs that are trying to satisfy them. The
          strip remains keyed so `+N more` cannot ride between task entities. */}
      <RunsStrip key={detail.id} runs={runs} livenessOf={livenessOf} onOpenEntity={onOpenEntity} />
      <SubtreeSection
        detail={detail}
        childWork={childWork}
        onOpenEntity={onOpenEntity}
        onAddChild={onAddChild}
      />
      {gitSection ? (
        /*
         * The git section is SELF-FETCHING and opaque here, so this body
         * cannot measure its emptiness or its tracked-PR count — it defaults
         * OPEN (the roster's "open when tracked PRs exist", approximated
         * upward) and never joins the empty set: a pr_merged gate refusal
         * lives inside it, and a fold that hid one would be hiding a refusal.
         */
        <CollapsibleSection id="git" label="GIT" empty={false} defaultOpen>
          {gitSection}
        </CollapsibleSection>
      ) : null}
      {memorySet ? (
        <CollapsibleSection
          id="memories"
          label={memorySet.label ?? 'MEMORIES'}
          count={memoryEdgeCount}
          empty={memoriesEmpty}
          testId="memory-set-section"
        >
          <MemorySetBlock
            detail={detail}
            params={memorySet.params ?? {}}
            onOpenEntity={onOpenEntity}
            authoring={memoryAuthoring}
          />
        </CollapsibleSection>
      ) : null}
      {peerRows.map((block, i) => (
        <CollapsibleSection
          id={i === 0 ? 'peers' : `peers-${i}`}
          label={block.label ?? 'RELATED'}
          count={edgesOf(detail, block.params ?? {}).length}
          empty={edgesOf(detail, block.params ?? {}).length === 0}
          testId="peer-rows-section"
          key={`${block.block}:${i}`}
        >
          <PeerRowsBlock detail={detail} params={block.params ?? {}} onOpenEntity={onOpenEntity} />
        </CollapsibleSection>
      ))}
      {membership ? (
        <CollapsibleSection
          id="collections"
          label={membership.label ?? 'COLLECTIONS'}
          count={membershipEdgeCount}
          empty={membershipEmpty}
          testId="membership-section"
        >
          <MembershipBlock
            detail={detail}
            params={membership.params ?? {}}
            onOpenEntity={onOpenEntity}
            authoring={membershipAuthoring}
          />
        </CollapsibleSection>
      ) : null}
      <DependenciesSection detail={detail} onOpenEntity={onOpenEntity} />
      <LinkedSection linked={linked} onOpenEntity={onOpenEntity} />
      {notices.length > 0 ? (
        /* NEVER folded — a folded notice is a notice that was not delivered. */
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
      <EmptySectionsToggle />
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
const COMPOSED_KEYS = new Set([
  'kind', 'acceptance', 'assignees', 'priority', 'dueDate', 'startDate', 'axes',
]);

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
      ...(config.list.dateControls ?? []).map((c) => c.source),
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
  //
  // SUPPRESSED where the strip now owns it, through the same `controlled` set
  // as priority and the dates (D67): the registry's `input:'number'` points
  // control is a live editor of this exact fact one band up, and a read-only
  // cell under a live control is the "buttons are broken" duplication that
  // set produced this suppression rule for. A kind that declares no such
  // control keeps the cell — for it, this is the only truth available.
  if (typeof content.pointsEstimate === 'number' && !controlled.has('pointsEstimate')) {
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
          <span aria-hidden><KindIcon kind={parent.kind} /></span> {parent.title}
        </button>
      ),
    });
  }

  /* Suppressed on a kind whose strip now OWNS the date (task, via
     `dateControls`) for the D67 reason the `controlled` note above gives: the
     read-only cell beside a live picker of the same fact is the confusion, not
     the redundancy. A kind that declares no date control keeps this cell,
     because for that kind it is the only truth available. */
  /* Start date, same shape and same suppression as `Due` below. It is on
     `COMPOSED_KEYS` for the reason the rest of that set is: without it the
     fallback loop at the foot of this function would draw a raw `Start Date`
     cell UNDER the live picker — the precise duplication the suppression above
     exists to prevent, arriving through the generic path instead of this one. */
  if (typeof state.startDate === 'string' && state.startDate.length > 0 && !controlled.has('startDate')) {
    cells.push({ key: 'startDate', label: 'Start', value: <span className="sb-grid__mono">{state.startDate}</span> });
  }

  if (typeof state.dueDate === 'string' && state.dueDate.length > 0 && !controlled.has('dueDate')) {
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

/**
 * THE DESCRIPTION HAS A STANCE — read by default, edit on request.
 *
 * A task description is markdown, like every other body in this app, and it
 * used to be a PERMANENTLY-MOUNTED textarea: there was no `<p>` to swap, so the
 * markdown pass that fixed the channel feed and the panel bodies could not
 * reach it. A reader therefore saw `## Plan` and `- step` as their own source,
 * in a field that looked like it was asking to be typed in even when the viewer
 * had no right to type.
 *
 * The stance is `ReaderSurface`'s, deliberately — same shape, one region
 * smaller: rendered markdown with an `Edit` entry, and the untouched textarea
 * behind it. THE EDITOR ITSELF IS UNCHANGED (user ruling): editing a task is
 * still plain markdown source in a growing field, not a rich-text surface.
 *
 * EXITING EDIT DISCARDS NOTHING, which is why there is no dirty refusal here
 * and there is one in `ReaderSurface`. The draft is held by the panel's save
 * bar, not by this component, so the preview renders the DRAFT and the save bar
 * keeps its unsaved-changes state exactly as before.
 */
function DescriptionEditor({
  detail,
  draft,
  onChange,
  unavailableReason,
  skillOptions,
  attach,
  onAttached,
  attachmentSlot,
}: {
  detail: EntityDetail;
  draft?: string;
  onChange?: (description: string) => void;
  unavailableReason?: string;
  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
  onAttached?: () => void;
  attachmentSlot?: ReactNode;
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
  const [editing, setEditing] = useState(false);

  // A different entity in the same panel slot is a different task, and its
  // description is a different text — the stance must not ride across.
  useEffect(() => {
    setEditing(false);
  }, [detail.id]);

  // An EMPTY description has nothing to preview, so it opens as the editor and
  // keeps its "Add a description…" invitation. Typing latches the stance, or
  // the field would snap shut under the cursor on the first keystroke.
  const empty = value.trim() === '';
  const showEditor = editing || empty;

  // The field has no internal scroll. Its box follows scrollHeight, which
  // pushes every later task region downward in the body's normal document flow.
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.max(node.scrollHeight, 72)}px`;
  }, [value, showEditor]);

  return (
    /* `data-attachment-drophost`: this body opts its description block in as
       the attachment strip's drop target — the strip finds the marker, never
       a body class name, so it stays agnostic of its host's anatomy. */
    /* NO `k-accent-top` HERE, and the reason is layout rather than taste.
       That utility sets `overflow: hidden`, and a flex item whose overflow is
       not `visible` loses its content-based automatic minimum size (Flexbox
       §4.5: `min-height: auto` resolves to zero). This card is a flex item in
       `.sb-body`, a fixed-height scrolling column, so it was free to shrink —
       and did: measured 2026-08-29 against prod `6423d07d`, the card rendered
       32px tall around 282px of description, clipping the ENTIRE brief with no
       way to scroll it back. The gradient hero went with it under the owner's
       "fewer colours" ruling. The shared `.sb-body` card rule in panels.css
       pins `flex-shrink: 0` so no future decoration can collapse it again. */
    <div
      className="sb-description"
      data-testid="task-description-editor"
      data-attachment-drophost=""
    >
      <div className="sb-description__head">
        <span className="sb-description__label k-label">Description</span>
        <StanceControl
          editing={showEditor}
          // Nothing to leave the editor FOR while the text is empty, so the
          // verb is withheld rather than offered as a no-op.
          onToggle={onChange && !(showEditor && empty) ? () => setEditing(!showEditor) : undefined}
          unavailableReason={unavailableReason}
        />
      </div>
      {showEditor ? (
        /* A task description reaches every agent that opens the task, so the
           editor is the shared prose input: `/` references a skill and a
           dropped or pasted file lands as a reference AT THE CARET (R4).
           THE STANCE IS UNCHANGED — this is still plain markdown source in a
           growing field, per the user ruling; what changed is what the field
           can take in. */
        <ProseField
          value={value}
          onChange={(next) => {
            setEditing(true);
            onChange?.(next);
          }}
          label="Description"
          className="sb-description__input"
          rows={1}
          placeholder="Add a description…"
          readOnly={!onChange}
          {...(unavailableReason ? { title: unavailableReason } : {})}
          inputRef={(element) => { textarea.current = element; }}
          {...(skillOptions ? { skillOptions } : {})}
          {...(attach ? { attach } : {})}
          {...(onAttached ? { onAttached } : {})}
        />
      ) : (
        <Markdown source={value} className="pn-prose" testId="task-description-view" />
      )}
      {/* The attachment tiles are the LAST thing inside the description block
          (2026-08-16 addendum) — the files sit with the prose they belong to,
          and the whole block is their drop target. */}
      {attachmentSlot ?? null}
    </div>
  );
}

function StanceControl({
  editing,
  onToggle,
  unavailableReason,
}: {
  editing: boolean;
  onToggle?: () => void;
  unavailableReason?: string;
}) {
  const label = editing ? 'Done' : 'Edit';
  if (!onToggle) {
    // Not offered is not the same as not there: the verb keeps its place and
    // says why it is refused, per L6.
    if (editing) return null;
    return (
      <DisabledIconControl
        label="Edit description"
        reason={unavailableReason ? toReason(unavailableReason) : NOT_WIRED_REASON}
      >
        {label}
      </DisabledIconControl>
    );
  }
  return (
    <button
      type="button"
      className="sb-description__stance k-btn k-btn--ghost k-btn--sm"
      data-testid="task-description-stance"
      onClick={onToggle}
    >
      {label}
    </button>
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
  /*
   * THE AUTHORING STANCE (wave 3) — read by default, restructure on request,
   * the same two-stance shape as the description one region up.
   *
   * Ticking is a RESTING gesture (the checkbox is the row); ADDING is a
   * resting gesture too (the quiet row at the foot — criteria are born one at
   * a time, and hiding birth behind a mode would re-create the "creating a
   * task, nothing works" report this section answers). REWORDING and
   * REMOVING are edit-stance gestures: destructive-adjacent, rare, and a
   * permanent ✕ beside every criterion would make the reading list read as a
   * form. Stance resets when the panel re-points at another entity.
   */
  const [editing, setEditing] = useState(false);
  const [addText, setAddText] = useState('');
  useEffect(() => {
    setEditing(false);
    setAddText('');
  }, [detail.id]);

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
  const remaining = criteria.length - completed;
  /* Only two states remain reachable: the summary is not rendered at all when
     the list is empty, so there is no longer an 'empty' progress state to
     name. Keeping a branch for it would describe a card that cannot exist. */
  const progressState = remaining === 0 ? 'completed' : 'in-progress';
  const progressCopy =
    progressState === 'completed'
      ? 'All criteria met'
      : `${remaining} ${remaining === 1 ? 'criterion' : 'criteria'} remaining`;
  const progressLabel = `Acceptance: ${completed} of ${criteria.length} criteria met`;
  /*
   * A REASON WINS OVER A HANDLER. `disabled={!onChange}` alone left a caller
   * that passed BOTH with live, clickable boxes wearing a refusal tooltip —
   * the control saying one thing and doing another. Both arms of the refusal
   * are now the same decision — and every affordance in this section (boxes,
   * add, remove, reword) reads the SAME verdict, so no gesture can stay live
   * while its siblings refuse.
   */
  const editable = onChange != null && unavailableReason == null;
  const refusal = unavailableReason ? toReason(unavailableReason) : NOT_WIRED_REASON;

  const commitAdd = () => {
    const text = addText.trim();
    if (!editable || text === '') return;
    onChange([...criteria, { id: newCriterionId(), text, done: false }]);
    setAddText('');
  };

  return (
    <CollapsibleSection
      id="acceptance"
      label="ACCEPTANCE"
      /* `0/0` is not a measurement, it is punctuation. The head carries the
         fraction once there is a denominator to divide by; until then the
         label stands alone and the line below says what is missing in words. */
      count={criteria.length === 0 ? undefined : `${completed}/${criteria.length}`}
      /* Acceptance is task-defining, not secondary disclosure. Its empty
         state is itself actionable, so it remains visible instead of hiding
         the one place a criterion can be added behind the empty-fold toggle. */
      empty={false}
      defaultOpen
      testId="acceptance-section"
    >
      {/* A METER ONLY WHERE THERE IS SOMETHING TO MEASURE. With no criteria
          this drew a tinted, accent-barred card reading "Ready to define" over
          a progress bar pinned at 0/0 — and the fold head one line above
          already said `ACCEPTANCE 0/0`, while the empty card below it said the
          same nothing in two more sentences. One state, four tellings, the
          count printed three times. The owner's ruling of 2026-08-29 is that
          the NAME of a thing beats its COUNT and that an element earns its
          slot or leaves, so the zero-state summary leaves and the worded line
          below carries the fact alone. */}
      {criteria.length === 0 ? null : (
        <div
          className="sb-acceptance__summary"
          data-testid="acceptance-progress"
          data-state={progressState}
          data-completed={completed}
          data-total={criteria.length}
        >
          <div className="sb-acceptance__summary-copy">
            <span className="k-label">Definition of done</span>
            {/* The WORDED state, not the fraction — "2 criteria remaining"
                answers what is left without making the reader do the
                subtraction. The fraction itself stays in the fold head, once. */}
            <strong>{progressCopy}</strong>
          </div>
          <div className="sb-acceptance__meter">
            <div className="sb-acceptance__bar">
              <ProgressBar
                value={completed}
                max={Math.max(criteria.length, 1)}
                label={progressLabel}
                isLabelHidden
              />
            </div>
          </div>
        </div>
      )}
      {criteria.length === 0 ? (
        <div className="sb-acceptance__empty" data-testid="acceptance-empty">
          <p className="pn-section__empty">
            No acceptance criteria yet — add the first observable outcome below.
          </p>
        </div>
      ) : (
        <>
          {editable ? (
            /* The stance flip, in the description's own control vocabulary —
               same class, same words, so the two regions read as one grammar. */
            <div className="sb-acceptance__head">
              <button
                type="button"
                className="sb-description__stance k-btn k-btn--ghost k-btn--sm"
                data-testid="acceptance-stance"
                onClick={() => setEditing(!editing)}
              >
                {editing ? 'Done' : 'Edit'}
              </button>
            </div>
          ) : null}
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
                    reason={refusal}
                  />
                  {text}
                </div>
              );
            }

            const box = (
              <input
                type="checkbox"
                className="sb-criterion__box"
                /* In the edit stance the box is not inside a <label>, so the
                   name must be explicit — the row's own text, as before. */
                {...(editing ? { 'aria-label': criterion.text } : {})}
                checked={criterion.done}
                onChange={(event) =>
                  onChange(
                    criteria.map((c, i) => (i === index ? withDone(c, event.target.checked) : c)),
                  )
                }
              />
            );

            if (editing) {
              /*
               * THE EDIT-STANCE ROW: reword in place, remove outright. The
               * text input STAGES through the same whole-array draft the
               * boxes use (`useTaskSave` — expectedVersion captured at first
               * edit, flushed by Save), so a reword and a tick ride one
               * patch and one conflict story. A DIV, not a <label>: three
               * controls in one label would give them all one name.
               */
              return (
                <div key={key} {...rowProps}>
                  {box}
                  <input
                    type="text"
                    className="sb-criterion__reword k-input k-input--sm"
                    data-testid="acceptance-reword"
                    aria-label={`Reword criterion: ${criterion.text}`}
                    value={criterion.text}
                    onChange={(event) =>
                      onChange(
                        criteria.map((c, i) =>
                          i === index ? { ...c, text: event.target.value } : c,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="sb-criterion__remove k-btn k-btn--ghost k-btn--sm"
                    data-testid="acceptance-remove"
                    aria-label={`Remove criterion: ${criterion.text}`}
                    title="Remove this criterion"
                    onClick={() => onChange(criteria.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </div>
              );
            }

            return (
              <label key={key} {...rowProps}>
                {box}
                {text}
              </label>
            );
          })}
          </div>
        </>
      )}
      {/*
        THE BIRTH ROW — the worst finding of the wave-3 census made flesh:
        `acceptanceCriteria` has ridden Create AND Patch since the task
        commands shipped, and NO surface in the product could append one. The
        quiet always-on row is the same posture as SUBTREE's `＋ add child…`,
        and it takes the same L6 arm when the save path is absent: visible,
        dead, and saying why — never hidden, never a live box that stages
        nothing.
      */}
      {editable ? (
        <div className="sb-addcriterion" data-testid="acceptance-add-row">
          <input
            type="text"
            className="sb-addcriterion__input k-input k-input--sm"
            data-testid="acceptance-add-input"
            aria-label="New acceptance criterion"
            /* ASCII ONLY. This read `＋ add criterion` with U+FF0B FULLWIDTH
               PLUS, which no latin/latin-ext subset of the self-hosted webfonts
               carries; on Linux it fell through to a system font that also
               lacked it and rendered as a literal `FF/0B` hex tofu box — seen
               in the panel screenshot of prod `6423d07d`. A UI affordance must
               not depend on a CJK-width codepoint. The word alone says it. */
            placeholder="Add criterion"
            value={addText}
            onChange={(event) => setAddText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitAdd();
            }}
          />
          {/* Plain `disabled` while empty is form-validity, not a refusal —
              the SaveControls/sheet-footer idiom, not the L6 one: there is
              nothing to explain about an empty box beyond its own emptiness. */}
          <button
            type="button"
            className="sb-addcriterion__commit k-btn k-btn--secondary k-btn--sm"
            data-testid="acceptance-add"
            disabled={addText.trim() === ''}
            onClick={commitAdd}
          >
            Add
          </button>
        </div>
      ) : (
        <DisabledIconControl label="Add criterion" glyph="+" reason={refusal}>
          add criterion…
        </DisabledIconControl>
      )}
    </CollapsibleSection>
  );
}

/**
 * A fresh criterion id, in the server's own family. The node backfills
 * `ac_${index+1}` onto id-less rows (`entities-commands-tracking.ts`
 * `acceptanceCriteria`) and the fixtures write `ac-N` — BOTH positional, so a
 * positional mint here would collide with a surviving row's id the first time
 * one was removed from the middle. The suffix is therefore entropy, not
 * position; `randomUUID` is secure-context-gated, hence the fallback (the
 * `commands.ts` mutation-id idiom).
 */
function newCriterionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `ac_${c.randomUUID()}`;
  return `ac_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  const addChildLive = onAddChild != null && addChildReason == null;

  return (
    <CollapsibleSection
      id="subtree"
      label="SUBTREE"
      count={childWork.length}
      /* No rows AND a live add affordance ⇒ empty (the affordance survives
         behind the reveal). A refused add affordance keeps the fold visible:
         hiding it would hide the refusal's reason. */
      empty={childWork.length === 0 && addChildLive}
      defaultOpen={childWork.length > 0}
      testId="subtree-section"
    >
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
      {addChildLive ? (
        <button type="button" className="sb-addchild" onClick={onAddChild}>
          + add child…
        </button>
      ) : (
        <DisabledIconControl
          label="Add child"
          glyph="+"
          reason={addChildReason ? toReason(addChildReason) : NOT_WIRED_REASON}
        >
          add child…
        </DisabledIconControl>
      )}
    </CollapsibleSection>
  );
}

function SubtreeRow({ child, onOpenEntity }: { child: EntitySummary; onOpenEntity?: (id: string) => void }) {
  const config = getKind(child.kind);
  const value = statusValueOf(child);
  /* PHASE 9/C3 — ONE definition of completed, the same one the list tile and
     the tab row use: `category === 'done'`. It used to scrape every string
     array out of the kind's `done` TIER filter and test the child's status
     word against it, which meant three different predicates on three kinds and
     none of them reachable for a status a space invented. `cancelled` is
     deliberately NOT struck: it stopped, it did not finish. */
  const done = child.category === 'done';
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
// RUNS — one always-visible execution region, still the two-source region
// (D6, brief §2.7). Measured live work, measured history and unresolved
// liveness are separate groups so visual hierarchy never overstates a stored
// session status. Six cards are shown, the rest behind `+N more`.
// ---------------------------------------------------------------------------

const RUN_CHIP_CAP = 6;

function RunsStrip({
  runs,
  livenessOf,
  onOpenEntity,
}: {
  runs: readonly EntitySummary[];
  livenessOf?: (sessionId: string) => SessionLiveness | undefined;
  onOpenEntity?: (id: string) => void;
}) {
  // The `+N more` chip expands the cluster IN PLACE, for this entity only
  // (the strip is keyed by entity id in the body above).
  const [expanded, setExpanded] = useState(false);
  const revealed = useEmptySectionsRevealed();
  useRegisterEmptySection(runs.length === 0);

  const verdictOf = (run: EntitySummary): SessionLiveness | undefined =>
    livenessOf ? livenessOf(run.id) : undefined;
  const measured = runs.filter((run) => verdictOf(run) != null).length;
  const liveCount = runs.filter((run) => verdictOf(run) === 'live').length;

  // Zero runs ⇒ the strip participates in the empty set.
  if (runs.length === 0 && !revealed) return null;

  /*
   * "RUNS · 1 LIVE" is only sayable when somebody actually looked. With no
   * verdicts in hand, "0 LIVE" would claim a measurement that never ran —
   * the same lie of precision the hollow-value law forbids for viewer counts.
   */
  const count =
    runs.length === 0
      ? `RUNS · ${runs.length}`
      : measured === 0
        ? `RUNS · ${runs.length} · LIVENESS UNVERIFIED`
        : `RUNS · ${runs.length} · ${liveCount} LIVE`;

  // Live first, then most recent (startedAt when the state carries one,
  // else the record's own createdAt).
  const stampOf = (run: EntitySummary): string => {
    const state = run.state as unknown as Record<string, unknown>;
    if (typeof state.startedAt === 'string') return state.startedAt;
    const summary = run as unknown as Record<string, unknown>;
    return typeof summary.createdAt === 'string' ? summary.createdAt : '';
  };
  const sorted = [...runs].sort((a, b) => {
    const rankOf = (run: EntitySummary): number => {
      const verdict = verdictOf(run);
      if (verdict === 'live') return 0;
      if (verdict === 'stale' || verdict === 'not-running') return 1;
      return 2;
    };
    const rank = rankOf(a) - rankOf(b);
    return rank !== 0 ? rank : stampOf(b).localeCompare(stampOf(a));
  });
  const shown = expanded ? sorted : sorted.slice(0, RUN_CHIP_CAP);
  const overflow = sorted.length - shown.length;
  const liveShown = shown.filter((run) => verdictOf(run) === 'live');
  const historyShown = shown.filter((run) => {
    const verdict = verdictOf(run);
    return verdict === 'stale' || verdict === 'not-running';
  });
  const unresolvedShown = shown.filter((run) => {
    const verdict = verdictOf(run);
    return verdict == null || verdict === 'unknown';
  });

  return (
    <section className="sb-section sb-runs" data-testid="runs-section">
      <Eyebrow faint>{count}</Eyebrow>
      {runs.length === 0 ? (
        <p className="pn-section__empty">No runs recorded against this.</p>
      ) : (
        <div className="sb-runs__groups">
          {liveShown.length > 0 ? (
            /* The MEASURED-LIVE group keeps its test seam and renders only on
               a live verdict — never from the stored status. */
            <div
              className="sb-runs__group sb-runs__group--live"
              data-testid="live-session-section"
            >
              <RunGroupHead label="Live now" count={liveShown.length} />
              <div className="sb-runs__cards" role="list" aria-label="Live runs">
                {liveShown.map((run) => (
                  <div role="listitem" key={run.id}>
                    <RunChip run={run} verdict="live" onOpenEntity={onOpenEntity} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {historyShown.length > 0 ? (
            <div className="sb-runs__group" data-testid="run-history-section">
              <RunGroupHead label="History" count={historyShown.length} />
              <div className="sb-runs__cards" role="list" aria-label="Run history">
                {historyShown.map((run) => (
                  <div role="listitem" key={run.id}>
                    <RunChip run={run} verdict={verdictOf(run)} onOpenEntity={onOpenEntity} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {unresolvedShown.length > 0 ? (
            <div className="sb-runs__group" data-testid="run-unresolved-section">
              <RunGroupHead label="Liveness unresolved" count={unresolvedShown.length} />
              <div className="sb-runs__cards" role="list" aria-label="Runs with unresolved liveness">
                {unresolvedShown.map((run) => (
                  <div role="listitem" key={run.id}>
                    <RunChip run={run} verdict={verdictOf(run)} onOpenEntity={onOpenEntity} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {overflow > 0 ? (
            <button
              type="button"
              className="sb-runchip sb-runchip--more k-press"
              onClick={() => setExpanded(true)}
            >
              +{overflow} more
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RunGroupHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="sb-runs__grouphead">
      <span className="k-label">{label}</span>
      <span className="sb-runs__groupcount">{count}</span>
    </div>
  );
}

function RunChip({
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
  const summary = run as unknown as Record<string, unknown>;
  const startedAt =
    typeof state.startedAt === 'string'
      ? state.startedAt
      : typeof summary.createdAt === 'string'
        ? summary.createdAt
        : null;
  const live = verdict === 'live';
  const word = treatment ? treatment.shortLabel ?? treatment.label : null;
  /* The accessible name carries what the narrow chip cannot: title, model and
     the liveness word — so the model string is never lost to the ellipsis. */
  const name = [run.title, model, word ?? 'liveness unverified'].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className={live ? 'sb-runchip sb-runchip--live k-press' : 'sb-runchip k-press'}
      data-testid={live ? 'live-session-card' : 'run-row'}
      title={name}
      aria-label={name}
      onClick={() => onOpenEntity?.(run.id)}
    >
      <span className="sb-runchip__top">
        {/* The verdict dot is SOLID when live and a hollow ring otherwise —
            pulse belongs to the §9.2 activity signal, which this body is not
            handed, so an animated dot would present a fact nobody measured. */}
        <span
          className={live ? 'sb-runchip__dot sb-run__dot--run' : 'sb-runchip__dot sb-runchip__dot--ring'}
          aria-hidden
        />
        <span className="sb-runchip__title">{run.title}</span>
      </span>
      {model || startedAt ? (
        <span className="sb-runchip__meta">
          {model ? <span className="sb-runchip__model">{model}</span> : null}
          {startedAt ? (
            <Timestamp className="sb-runchip__time" at={startedAt} prefix="started" />
          ) : null}
        </span>
      ) : null}
      {treatment ? (
        <span
          className={`sb-word sb-word--${treatment.tone} sb-runchip__word`}
          title={treatment.reason ?? treatment.label}
        >
          {word}
        </span>
      ) : (
        <span className="sb-runchip__word">
          <HollowInline caption="No liveness verdict reached this panel for this run — the chip states that nothing was measured rather than guessing from the stored status.">
            — unverified
          </HollowInline>
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DEPENDENCIES — the depends_on edges, with their facts kept on them
// ---------------------------------------------------------------------------

/**
 * WHY A NAMED SECTION AND NOT MORE LINKED CHIPS — the fourth recurrence of the
 * `OWN_SECTION_EDGES` failure class (see that docblock). A blocked task's ROW
 * says "blocked ×2" (`badges.blocked.unresolvedHardDependencyCount`), but its
 * own body used to render the edges behind that count as anonymous LINKED
 * chips — no direction, no hard/soft, no resolved state, i.e. none of the
 * facts that make the row's claim explainable.
 *
 * STRUCTURAL, NOT PER-KIND: like ACCEPTANCE one region up, this reads the
 * detail's own shape (`connections` groups typed `depends_on`) and never asks
 * "is this a task?" — any subtree-archetype entity that carries the edges gets
 * the section, so no registry declaration is needed and §15.2 stays intact.
 *
 * The VOCABULARY is borrowed, not invented (D22's spirit): direction words are
 * the session-graph's (`depends_on:out` → "depends on", `:in` → "blocks",
 * src/session-graph/model.ts), and hard-by-default is the graph model's ruling
 * (`e.hard === false ? soft : hard`, src/graph/model.ts:315) — the same edge
 * must not read soft on one surface and hard on another.
 */
function DependenciesSection({
  detail,
  onOpenEntity,
}: {
  detail: EntityDetail;
  onOpenEntity?: (id: string) => void;
}) {
  // Outgoing: THIS entity depends on the peer (the peer gates it).
  // Incoming: the peer depends on THIS entity (this entity gates the peer).
  const dependsOn = edgesOf(detail, { edgeType: 'depends_on', direction: 'outgoing' });
  const blocks = edgesOf(detail, { edgeType: 'depends_on', direction: 'incoming' });
  const count = dependsOn.length + blocks.length;

  return (
    <CollapsibleSection
      id="dependencies"
      label="DEPENDENCIES"
      count={count}
      empty={count === 0}
      defaultOpen={count > 0}
      testId="dependencies-section"
    >
      {count === 0 ? (
        /* The honest empty line: absence of dependencies is a fact about the
           work, not a blank to skip — this waits on nothing, on purpose. */
        <p className="pn-section__empty">No dependencies — this waits on nothing, and nothing waits on it.</p>
      ) : (
        <div className="sb-rows">
          {dependsOn.map((edge) => (
            <DependencyRow key={edge.id} detail={detail} edge={edge} direction="depends-on" onOpenEntity={onOpenEntity} />
          ))}
          {blocks.map((edge) => (
            <DependencyRow key={edge.id} detail={detail} edge={edge} direction="blocks" onOpenEntity={onOpenEntity} />
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

function DependencyRow({
  detail,
  edge,
  direction,
  onOpenEntity,
}: {
  detail: EntityDetail;
  edge: EdgeView;
  direction: 'depends-on' | 'blocks';
  onOpenEntity?: (id: string) => void;
}) {
  const peer = edge.source.id === detail.id ? edge.target : edge.source;
  /* Hard by DEFAULT — the graph model's reading of the same optional member
     (src/graph/model.ts:315): only an explicit `hard: false` is soft. */
  const hard = edge.hard !== false;
  /* Resolution is TRI-STATE and rendered as such: `undefined` means the edge
     carries no verdict, and printing "unresolved" for it would claim a fact
     nobody recorded — the hollow-value law, applied to an edge member. */
  const resolvedWord =
    edge.resolved === true ? 'resolved' : edge.resolved === false ? 'unresolved' : null;
  /* The BLOCKING predicate is the graph model's, verbatim (model.ts:320):
     hard and explicitly unresolved. Direction does not change the edge's own
     state — it changes who is gated, which the direction word already says. */
  const blocking = hard && edge.resolved === false;
  const tone = blocking ? 'block' : 'idle';
  const facts = [hard ? 'hard' : 'soft', resolvedWord].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className="sb-row"
      data-testid="dependency-row"
      data-direction={direction}
      data-blocking={blocking ? 'true' : 'false'}
      onClick={() => onOpenEntity?.(peer.id)}
    >
      {/* Filled when the dependency is RESOLVED — the same filled-means-done
          grammar as the SUBTREE dot above. */}
      <span
        className={`sb-dot sb-dot--${tone}${edge.resolved === true ? ' sb-dot--filled' : ''}`}
        aria-hidden
      />
      <span className={`sb-word sb-word--${tone}`}>
        {direction === 'depends-on' ? 'depends on' : 'blocks'}
      </span>
      <span className="sb-row__title">
        <span aria-hidden><KindIcon kind={peer.kind} /></span> {peer.title}
      </span>
      <span className={`sb-word sb-word--${tone}`}>{facts}</span>
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
    <CollapsibleSection
      id="linked"
      label="LINKED"
      count={linked.length}
      empty={linked.length === 0}
      testId="linked-section"
    >
      {linked.length === 0 ? (
        <p className="pn-section__empty">Nothing linked to this yet.</p>
      ) : (
        <div className="pn-chiprow">
          {linked.map((peer) => (
            <Chip key={peer.id} glyph={<KindIcon kind={peer.kind} />} onClick={() => onOpenEntity?.(peer.id)}>
              {peer.title}
            </Chip>
          ))}
        </div>
      )}
    </CollapsibleSection>
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
  status: 'status',
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
 * A kind belongs in RUNS when its registry row PRESENTS A LIVENESS VERDICT.
 * That is the definition the region needs — "these are the rows a seam verdict
 * speaks about" — and it is a registry fact, so a future kind that gains a
 * `liveTreatment` appears here without this file being touched.
 */
function isRunKind(summary: EntitySummary): boolean {
  return getKind(summary.kind).list.liveTreatment != null;
}

/**
 * THE EDGE TYPES THAT HAVE THEIR OWN SECTION, and therefore must not also be
 * swept into LINKED.
 *
 * THE FAILURE CLASS THIS SET EXISTS FOR — worth stating once, because it has
 * now recurred: `peersOf` pushes every endpoint of every group, which is
 * correct only while the edge registry is narrow. Twice a migration has widened
 * it underneath this function and given an edge BEHAVIOURAL semantics without
 * this file knowing:
 *
 *   · `remembers` (085 + P2) — a task's remembered memories are injected into
 *     every session spawned on it. It rendered as an anonymous LINKED chip.
 *   · `triggered_by` (086) — "this task exists because that loop fired". Run
 *     history and provenance, and it would have rendered the same way.
 *
 * A type-blind sweep cannot see either, and no declared-block guard can catch
 * it because nothing is declared. So each type that carries meaning gets a
 * NAMED SECTION and joins this set. Exactly these groups and nothing broader:
 * every other edge type still belongs in LINKED, which is what the test holds.
 *
 *   · `contains` (2026-08-12) — curated collection membership, the third
 *     recurrence of the class. It gets the COLLECTIONS section (the
 *     `membership` block) with add/remove, instead of an anonymous chip.
 *
 *   · `depends_on` (2026-08-29) — the FOURTH recurrence. The edge carries
 *     direction, hard/soft and a resolved verdict — the exact facts behind a
 *     row's "blocked ×N" badge — and a chip drops all three. It gets the
 *     DEPENDENCIES section, which is drawn structurally from the connections
 *     rather than from a declared block, so it joins this set unconditionally.
 */
const OWN_SECTION_EDGES: ReadonlySet<string> = new Set([
  'remembers', 'triggered_by', 'contains', 'depends_on',
]);

function peersOf(detail: EntityDetail): EntitySummary[] {
  const out: EntitySummary[] = [];
  for (const group of [...detail.connections.outgoing, ...detail.connections.incoming]) {
    if (OWN_SECTION_EDGES.has(group.type)) continue;
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
