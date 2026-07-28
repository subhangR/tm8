/**
 * HomeScreen — T5-1, the space's landing view; the `dashboard` rail route.
 *
 * PLACEMENT is ruled by the oracle's own second frame ("Where Home lives,
 * three options"): **A · SHIPPED** is the menu destination — the HOME group's
 * first row, view ref `dashboard`, route `#/s/{space}/home`. B (a pinned first
 * tab) and C (the workspace's empty centre) are drawn REJECTED there, with
 * reasons, so they are not built and must not be revived: the tab bar
 * enumerates spaces, and the empty centre's live roster is already ruled.
 *
 * That makes the mount exactly the D65 pattern the ◉ Graph row already uses —
 * an activated menu view replaces the centre WHOLESALE. This component draws
 * the centre only; the tab bar, rail and account chrome the canvas frames
 * around it are the shell's and already exist.
 *
 * WHAT THE CANVAS RULES AND THIS FILE HONOURS
 *  · "no stat cards, no charts — Home is triage, not analytics" (geometry note).
 *    There is not a number on this screen that is not a count of visible rows.
 *  · Two columns 1.25 : 1, and BELOW THE FLOOR they concatenate in triage order
 *    — NEEDS YOU → live → tasks → mentions → activity. That order is defined
 *    once, in `composeMyWork`, so the two layouts cannot drift.
 *  · "My work = a T0-3 configuration … zero new primitives": every row is the
 *    same dot + glyph + title + word anatomy, and every one opens its Z3 panel.
 *
 * HONESTY POSTURE (charter R7, and the bar this screen was built to):
 * every control the canvas draws EXISTS here. The ones this build can perform
 * are wired to the real seam through the port; the ones it cannot —
 * "↓ load earlier", the activity scope filter, and any quick action whose
 * handler the host did not supply — render DISABLED-WITH-REASON, focusable,
 * with the reason in the accessibility tree. None is hidden, and none is a live
 * control that silently does nothing (the five-dead-verbs class).
 */
import { useMemo, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { DisabledAction, DisabledIconControl, type UnavailableReason } from '../panels';
import { Eyebrow, Kbd } from '../kit';
import { useMeasuredWidth } from '../shell';
import { homeActivityLoadEarlierReason } from '../fixtures';
import { assignableKinds, composeMyWork, type HomeRow, type HomeSection } from './home-model';
import { bucketActivity, recencyOf, ACTIVITY_WINDOW } from './home-activity';
import { useHomeData, type HomeScreenData } from './useHomeData';
import './home.css';

/**
 * The width at which the two columns concatenate. The canvas's floor specimen
 * is drawn at 320px wide and captioned "320 floor — one column, same order",
 * so the floor is the specimen; the breakpoint is where two 1.25:1 columns stop
 * being readable, which is comfortably above it.
 */
export const HOME_STACK_BREAKPOINT = 640;

/** Shape of the authoring lane's `NewTaskHandle`, named structurally. */
export interface HomeNewTask {
  /** Non-null ⇒ the control renders disabled with this reason. */
  unavailable: { cause: string; remedy: string } | null;
  create(): void | Promise<void>;
}

export interface HomeScreenProps {
  data: HomeScreenData;
  /** C1 — every row opens its Z3 panel. */
  onOpenEntity(id: EntityId): void;
  /** "Workspace ⌘" — the third quick action. Absent ⇒ disabled-with-reason. */
  onOpenWorkspace?(): void;
  /** "all tasks ↗" / the "g t" first-run row. Absent ⇒ disabled-with-reason. */
  onOpenKind?(kind: string): void;
  /**
   * "▸ Launch session" — raises the SHIPPED D44/D51 door (`useLaunchSheet.open`),
   * never a second launch surface. A session launches ON a task, so the subject
   * is passed and named in the control's accessible title.
   */
  onLaunch?(subjectId: EntityId): void;
  /** "＋ New task" — the authoring lane's handle. Absent ⇒ disabled-with-reason. */
  newTask?: HomeNewTask;
  /** The clock, injected so the dateline and recencies are testable. */
  now?: Date;
  /** Space label for the dateline; the shell knows it, this screen does not. */
  spaceLabel?: string;
  /** Forces the stacked floor layout (jsdom reports no width — see below). */
  forceNarrow?: boolean;
}

const NOT_WIRED: UnavailableReason = {
  cause: 'This action isn’t connected in this build',
  remedy: 'the screen exposes the handler and its host has not supplied one yet',
};

const ACTIVITY_SCOPE_REASON: UnavailableReason = {
  cause: 'Activity cannot be scoped yet',
  remedy:
    'the durable event stream this column reads takes no scope parameter — filtering would have to drop rows client-side and call that a filter',
};

export function HomeScreen(props: HomeScreenProps) {
  const { data, onOpenEntity } = props;
  const now = props.now ?? new Date();

  const home = useHomeData(data);

  // jsdom has no ResizeObserver and no layout engine, so this stays null there
  // and the wide layout renders — deliberately, because a shimmed width would
  // let a test "prove" a floor that never happened (the D10 line). `forceNarrow`
  // is how the stacked order is asserted instead: it exercises the same branch
  // without claiming a measurement.
  const [rootRef, width] = useMeasuredWidth<HTMLDivElement>();
  const narrow = props.forceNarrow ?? (width !== null && width <= HOME_STACK_BREAKPOINT);

  const work = useMemo(
    () =>
      composeMyWork({
        sessionPool: home.sessionPool,
        myTasks: home.myTasks,
        myReview: home.myReview,
        livenessOf: data.livenessOf,
        activity: data.activity,
        notifications: home.notifications,
        notificationsError: home.notificationsError,
        viewerKnown: home.viewer !== null,
        viewerError: home.viewerError,
        compact: narrow,
      }),
    [home, data.livenessOf, data.activity, narrow],
  );

  const hasAnything = work.sections.some((s) => s.rows.length > 0);

  /**
   * The launch subject. A session launches ON a task (T5-5), so the door needs
   * one; the top row of MY TASKS is the subject and the control's title NAMES
   * it, because a primary that silently picks its own object is a worse
   * surprise than one that is refused.
   */
  const tasksSection = work.sections.find((s) => s.id === 'tasks');
  const launchSubject = tasksSection?.rows[0] ?? null;

  // The collection "all tasks ↗" points at, resolved from the REGISTRY rather
  // than named here (§15.2): the assignable kind is the one MY TASKS is made of.
  const taskKind = assignableKinds()[0] ?? null;
  const allLabel = taskKind ? `all ${taskKind.labelPlural.toLowerCase()} ↗` : null;

  const create = props.newTask;
  const createReason: UnavailableReason | null = !create
    ? NOT_WIRED
    : (create.unavailable ?? null);

  const launchReason: UnavailableReason | null = !props.onLaunch
    ? NOT_WIRED
    : !launchSubject
      ? {
          cause: 'There is no task to launch a session on',
          remedy: 'a session runs against a task — create or pull one first',
        }
      : null;

  const dateline = [
    now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase(),
    props.spaceLabel ?? null,
    home.viewer ? `you are @${home.viewer.username}` : home.viewerError ? 'identity unavailable' : 'identifying you…',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="hm-root"
      data-testid="home-screen"
      data-narrow={narrow ? 'true' : undefined}
      ref={rootRef}
    >
      <header className="hm-head">
        <span className="hm-head__id">
          <span className="hm-head__title">Home</span>
          <span className="hm-head__meta">{dateline}</span>
        </span>
        <span className="hm-head__spacer" />

        {/* EXACTLY THREE quick actions (annotation 2). At the floor they keep
            their glyphs and lose their labels — never their existence. */}
        <QuickAction
          glyph="＋"
          label="New task"
          tone="primary"
          narrow={narrow}
          reason={createReason}
          onClick={() => void create?.create()}
        />
        <QuickAction
          glyph="▸"
          label="Launch session"
          narrow={narrow}
          reason={launchReason}
          title={launchSubject ? `Launch a session on “${launchSubject.title}”` : undefined}
          onClick={() => launchSubject && props.onLaunch?.(launchSubject.id as EntityId)}
        />
        <QuickAction
          glyph="⌗"
          label="Workspace"
          narrow={narrow}
          reason={props.onOpenWorkspace ? null : NOT_WIRED}
          onClick={() => props.onOpenWorkspace?.()}
        />
      </header>

      <div className="hm-columns">
        <section className="hm-tile hm-tile--work" aria-label="My work">
          <div className="hm-tile__head">
            <span className="hm-tile__name">
              <span aria-hidden className="hm-tile__glyph">
                ⌂
              </span>
              My work
            </span>
            <span className="hm-tile__spacer" />
            {/* `● N live` — the count is the LIVE SET's, and its wording is
                registry data, not a format string invented here. */}
            <span className="hm-live" data-testid="home-live-count">
              {work.liveCountLabel}
            </span>
          </div>

          <div className="hm-tile__body">
            {hasAnything || home.viewer === null ? (
              work.sections.map((section) => (
                <SectionBlock key={section.id} section={section} onOpenEntity={onOpenEntity} />
              ))
            ) : (
              <FirstRun
                createReason={createReason}
                onCreate={() => void create?.create()}
                launchReason={launchReason}
                onLaunch={() => launchSubject && props.onLaunch?.(launchSubject.id as EntityId)}
                allLabel={taskKind?.labelPlural.toLowerCase() ?? null}
                onOpenKind={taskKind && props.onOpenKind ? () => props.onOpenKind?.(taskKind.kind) : null}
              />
            )}
          </div>

          <div className="hm-tile__foot">
            <span className="hm-foot__note">every row opens its panel</span>
            <span className="hm-tile__spacer" />
            {allLabel ? (
              props.onOpenKind && taskKind ? (
                <button
                  type="button"
                  className="hm-foot__link"
                  onClick={() => props.onOpenKind?.(taskKind.kind)}
                >
                  {allLabel}
                </button>
              ) : (
                <DisabledIconControl label={allLabel} reason={NOT_WIRED}>
                  <span className="hm-foot__link hm-foot__link--off">{allLabel}</span>
                </DisabledIconControl>
              )
            ) : null}
          </div>
        </section>

        <section className="hm-tile hm-tile--activity" aria-label="Space activity">
          <div className="hm-tile__head">
            <span className="hm-tile__name">
              <span aria-hidden className="hm-tile__glyph">
                ◷
              </span>
              Space activity
            </span>
            <span className="hm-tile__spacer" />
            <DisabledIconControl label="Scope activity" reason={ACTIVITY_SCOPE_REASON}>
              <span className="hm-scope">all ▾</span>
            </DisabledIconControl>
          </div>

          <div className="hm-tile__body">
            {home.activityRows.length === 0 ? (
              <p className="hm-empty" data-testid="home-activity-empty">
                Quiet since you opened Home. When work happens — status changes, links, runs — it
                lands here as it happens.
              </p>
            ) : (
              bucketActivity(home.activityRows, now).map((bucket) => (
                <div className="hm-day" key={bucket.label}>
                  <Eyebrow faint>{bucket.label}</Eyebrow>
                  {bucket.rows.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      className="hm-act"
                      disabled={row.objectId === null}
                      onClick={() => row.objectId && onOpenEntity(row.objectId as EntityId)}
                    >
                      <span aria-hidden className="hm-act__dot" data-tone={row.tone} />
                      <span className="hm-act__text">
                        {row.actor ? (
                          <>
                            <span className="hm-act__actor">{row.actor}</span>
                            {row.isAgent ? <span className="hm-act__agent">agent</span> : null}{' '}
                          </>
                        ) : null}
                        {row.verb}
                        {row.objectTitle ? (
                          <>
                            {' '}
                            {row.objectGlyph ? (
                              <span aria-hidden className="hm-act__glyph">
                                {row.objectGlyph}
                              </span>
                            ) : null}{' '}
                            <span className="hm-act__object">{row.objectTitle}</span>
                          </>
                        ) : null}
                      </span>
                      <span className="hm-act__age">{recencyOf(row.at, now)}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="hm-tile__foot hm-tile__foot--stack">
            <DisabledAction reason={LOAD_EARLIER_REASON} label="Load earlier activity">
              <span className="hm-foot__link">↓ load earlier</span>
            </DisabledAction>
            <span className="hm-foot__scope">
              live stream · last {ACTIVITY_WINDOW} events since this screen opened
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * D7.1 is the ruling that reserved this control, and `homeActivityLoadEarlierReason`
 * is the measured backend fact it parked (GateApp has been holding the constant
 * with the comment "consumed by HomeView at fan-out" — this is that consumer).
 *
 * BOTH facts are stated, because they are different: the CAUSE is what is true
 * of this build (the column is a live stream and there is no space-scoped
 * history read behind the seam to page), the REMEDY line carries the measured
 * node-side gap that would still block paging if there were one.
 */
const LOAD_EARLIER_REASON: UnavailableReason = {
  cause: 'There is no earlier activity to load into this column',
  remedy: homeActivityLoadEarlierReason,
};

function SectionBlock({
  section,
  onOpenEntity,
}: {
  section: HomeSection;
  onOpenEntity(id: EntityId): void;
}) {
  return (
    <div
      className="hm-section"
      data-section={section.id}
      data-emphasis={section.emphasis ?? undefined}
    >
      <div className="hm-section__head">
        <Eyebrow faint={section.emphasis === null}>
          {section.label} · {section.rows.length}
        </Eyebrow>
      </div>
      {section.rows.length === 0 ? (
        /* AN ABSENCE IS STATED, NOT SHOUTED (R5 #10, generalised): the note is
           one quiet line, never an expanded empty panel stealing the height the
           populated sections need. It is never omitted — a section that renders
           nothing and says nothing is the silent void this screen is graded on. */
        <p className="hm-empty" data-testid={`home-empty-${section.id}`}>
          {section.emptyNote}
        </p>
      ) : (
        section.rows.map((row) => <Row key={row.id} row={row} onOpen={onOpenEntity} />)
      )}
    </div>
  );
}

function Row({ row, onOpen }: { row: HomeRow; onOpen(id: EntityId): void }) {
  return (
    <button
      type="button"
      className="hm-row"
      data-testid="home-row"
      title={row.detail ?? row.title}
      onClick={() => onOpen(row.id as EntityId)}
    >
      <span aria-hidden className="hm-row__dot" data-dot={row.dot ?? 'none'} data-tone={row.tone} />
      <span aria-hidden className="hm-row__glyph">
        {row.glyph}
      </span>
      <span className="hm-row__title">{row.title}</span>
      {row.word ? (
        <span className="hm-row__word" data-tone={row.tone}>
          {row.word}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The oracle's first-run frame. Its three rows are not decoration — they are
 * the SAME three verbs as the quick actions above, so a build that can perform
 * them here can perform them there, and one that cannot refuses in both places
 * with the same reason.
 */
function FirstRun({
  createReason,
  onCreate,
  launchReason,
  onLaunch,
  allLabel,
  onOpenKind,
}: {
  createReason: UnavailableReason | null;
  onCreate(): void;
  launchReason: UnavailableReason | null;
  onLaunch(): void;
  allLabel: string | null;
  onOpenKind: (() => void) | null;
}) {
  return (
    <div className="hm-firstrun" data-testid="home-first-run">
      <p className="hm-firstrun__lede">Nothing pulled yet.</p>
      <div className="hm-firstrun__rows">
        <HintRow keys="c" label="create your first task" reason={createReason} onClick={onCreate} />
        <HintRow
          keys="▸"
          label="launch a session on it — a teammate does the work"
          reason={launchReason}
          onClick={onLaunch}
        />
        <HintRow
          keys="g t"
          label={allLabel ? `see every ${allLabel.replace(/s$/, '')} in the workspace` : 'see the workspace'}
          reason={onOpenKind ? null : NOT_WIRED}
          onClick={() => onOpenKind?.()}
        />
      </div>
      <p className="hm-firstrun__grammar">
        tasks · sessions · docs are entities — click one anywhere and its panel opens on the stack.
        that is the whole grammar.
      </p>
    </div>
  );
}

function HintRow({
  keys,
  label,
  reason,
  onClick,
}: {
  keys: string;
  label: string;
  reason: UnavailableReason | null;
  onClick(): void;
}) {
  const body = (
    <>
      <Kbd>{keys}</Kbd>
      <span className="hm-hint__label">{label}</span>
      <span aria-hidden className="hm-hint__chev">
        ›
      </span>
    </>
  );
  if (reason) {
    return (
      <DisabledIconControl label={label} reason={reason}>
        <span className="hm-hint hm-hint--off">{body}</span>
      </DisabledIconControl>
    );
  }
  return (
    <button type="button" className="hm-hint" onClick={onClick}>
      {body}
    </button>
  );
}

/**
 * A header quick action. `reason` non-null is the whole switch: the control
 * keeps its glyph, its label and its place in the row, and becomes a focusable
 * `aria-disabled` affordance whose reason is announced (D28 — a natively
 * disabled button leaves the tab order, so the keyboard user can never learn
 * WHY, which defeats the treatment).
 */
function QuickAction({
  glyph,
  label,
  narrow,
  reason,
  onClick,
  title,
  tone,
}: {
  glyph: string;
  label: string;
  narrow: boolean;
  reason: UnavailableReason | null;
  onClick(): void;
  title?: string;
  tone?: 'primary';
}) {
  const inner: ReactNode = (
    <>
      <span aria-hidden>{glyph}</span>
      {narrow ? null : <span className="hm-qa__label">{label}</span>}
    </>
  );
  const cls = `hm-qa${tone === 'primary' ? ' hm-qa--primary' : ''}`;
  if (reason) {
    return (
      <DisabledIconControl label={label} reason={reason}>
        <span className={`${cls} hm-qa--off`}>{inner}</span>
      </DisabledIconControl>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} title={title ?? label} aria-label={label}>
      {inner}
    </button>
  );
}
