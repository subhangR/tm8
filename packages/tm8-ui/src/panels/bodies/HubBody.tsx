import type { EntityDetail, EntitySummary, MessageView } from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { getKind } from '../../domain';
import { Avatar, Chip, Eyebrow } from '../../kit';
import { DisabledIconControl, NOT_WIRED_REASON } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
import './hub-body.css';

/**
 * THE HUB ARCHETYPE — the front door of a container that has a live feed
 * somewhere else (T0-4 frame 2, the `channel` region, oracle lines 248–271).
 *
 * THE THESIS THE ORACLE STATES IN ITS OWN COPY: "Content is the front door,
 * never the feed." So the hub BODY is not a message list. It is a standing
 * description, the pins, the shape of what lives here (the auto-tabs), one
 * line of what happened last, and a note pointing at the surface that does
 * render the feed. Everything that scrolls lives in the hub proper.
 *
 * ARCHETYPE, NOT KIND (L2 / §15.2). Nothing here names a kind. Three regions
 * read the entity STRUCTURALLY — "does this content carry a description-ish
 * scalar / a summary array / auto-tabs?" — exactly as GenericBody reads its
 * blocks, and two are registry DATA: the `items` block names which content
 * member holds the pins and what the eyebrow says, and the `notice` block
 * carries the redirect sentence. A kind whose row declares
 * `archetype: 'hub'` with no blocks still gets its description, its pins and
 * its tabs; it gets no redirect note, because the sentence names a specific
 * surface and inventing one would be kind knowledge living in a component.
 *
 * Colours are tokens only (§14). Every geometry and micro-type literal below
 * cites its oracle line and is kept verbatim per D5 — the single zoom lever on
 * `.cv2-root` is what scales this family, never a per-element bump.
 */

/** The block-declared source for the pins, when the registry names none. */
const DEFAULT_PINNED_SOURCE = 'pinned';
/** The eyebrow the oracle draws over the chip row (line 251). */
const DEFAULT_PINNED_LABEL = 'PINNED';

export function HubBody({
  detail,
  blocks,
  messages,
  hasFeed,
  now,
  onOpenEntity,
}: {
  detail: EntityDetail;
  /** The registry row's content blocks — `items` and `notice` are consumed. */
  blocks: readonly ContentBlockRef[];
  /**
   * The panel's own discussion list, the ONLY source of the latest-message
   * card. `undefined` and `[]` are different facts here and stay different
   * (see LatestMessage): nothing was read vs. a read that found nothing.
   */
  messages?: readonly MessageView[];
  /**
   * The host is rendering the entity's LIVE FEED directly beneath this body
   * (user ruling 2026-08-01 — channels open in the panel now). Two regions
   * stop being true when it does, and both are suppressed rather than left to
   * contradict what is on screen a few pixels below:
   *
   *   · the latest-message card — a one-line summary of a feed the reader can
   *     already see in full, including its hollow and empty states, which
   *     would claim nothing was read while the feed shows the messages;
   *   · the redirect note — it names the surface that renders the feed, and
   *     that surface IS this panel now.
   */
  hasFeed?: boolean;
  /** Injected so the age on the card is deterministic under test. */
  now?: string;
  onOpenEntity?: (id: string) => void;
}) {
  const content = detail.content as unknown as Record<string, unknown>;

  const itemsBlock = blocks.find((b) => b.block === 'items');
  const pinnedSource =
    typeof itemsBlock?.params?.source === 'string' ? itemsBlock.params.source : DEFAULT_PINNED_SOURCE;
  const pinnedLabel = itemsBlock?.label ?? DEFAULT_PINNED_LABEL;
  const pinned = summaryArray(content[pinnedSource]);

  const noticeBlock = blocks.find((b) => b.block === 'notice');
  const redirect = typeof noticeBlock?.params?.text === 'string' ? noticeBlock.params.text : null;

  const description = firstString(content.description, content.topic, content.body);
  const tabs = tabArray(content.autoTabs);

  return (
    <div
      className="pn-body hub-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
      data-testid="hub-body"
    >
      {/* `pn-prose` is byte-identical to the oracle's description line
          (12.5px / 1.55 / ink-2 / text-wrap:pretty, line 249) — the generic
          body already owns that treatment, so this reuses it rather than
          declaring a second one that could drift from it. */}
      {description ? (
        <p className="pn-prose" data-testid="hub-description">
          {description}
        </p>
      ) : null}

      {pinned.length > 0 ? (
        <section className="hub-group" data-testid="hub-pinned">
          <Eyebrow faint>{`${pinnedLabel} · ${pinned.length}`}</Eyebrow>
          <div className="pn-chiprow">
            {pinned.map((item) => (
              <PinnedChip key={item.id} item={item} onOpenEntity={onOpenEntity} />
            ))}
          </div>
        </section>
      ) : null}

      {tabs.length > 0 ? (
        <section className="hub-group" data-testid="hub-tabs">
          <Eyebrow faint>HUB TABS</Eyebrow>
          <div className="hub-tabrow">
            {tabs.map((tab) => (
              /*
               * STATIC TEXT, NOT CONTROLS — and deliberately so. The oracle
               * gives the pinned chips `cursor:pointer` (line 253) and these
               * pills none (line 260): they describe what lives in this
               * container, and switching to one of those views is the hub's
               * own job, which the redirect note below points at. There is no
               * verb here, so there is no unwired verb to disable (R7).
               *
               * The count is always shown, including a literal 0 — the same
               * law as the panel tab strip: a zero a read produced is an
               * answer, and hiding it makes it indistinguishable from a count
               * nobody measured.
               */
              <span key={tab.key} className="hub-tab">
                {`${tab.label} · ${tab.count}`}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {hasFeed ? null : <LatestMessage messages={messages} now={now} />}

      {/* The redirect NOTE, not the generic `pn-notice`: the oracle draws this
          one in the 11.5px UI face at ink-4 (line 270), where pn-notice is the
          9.5px mono voice. Different treatment, so it gets its own class. */}
      {redirect && !hasFeed ? (
        <p className="hub-redirect" data-testid="hub-redirect">
          {redirect}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A pin is a real navigation, so it renders as a real control — WHEN one is
 * wired. With no `onOpenEntity` the chip would be enabled-inert, the R5 #9
 * class the user met as "I click and nothing happens" five times in one
 * screen. The check is structural (is there a handler?), so it can never drift
 * away from what the host actually dispatches.
 */
function PinnedChip({
  item,
  onOpenEntity,
}: {
  item: EntitySummary;
  onOpenEntity?: (id: string) => void;
}) {
  const glyph = getKind(item.kind).chip.glyph;
  if (!onOpenEntity) {
    return (
      <DisabledIconControl label={item.title} glyph={glyph} reason={NOT_WIRED_REASON}>
        {item.title}
      </DisabledIconControl>
    );
  }
  return (
    <Chip glyph={glyph} onClick={() => onOpenEntity(item.id)}>
      {item.title}
    </Chip>
  );
}

/**
 * ONE LINE OF FEED, AND TWO HONEST ABSENCES.
 *
 * The oracle draws only the populated card (lines 266–268). The other two
 * states are the ones that reach a real screen, and they are DIFFERENT FACTS
 * that must not collapse into one grey sentence:
 *
 *   · `messages === undefined` — nothing read the discussion for this panel.
 *     Renders HOLLOW (a dash plus its reason), because "no messages" would
 *     claim a measurement that never ran.
 *   · `messages === []` — a read ran and the channel is empty. That is a real
 *     zero and says so plainly.
 *
 * Both are one quiet line. An expanded empty region here would spend the
 * body's height on an absence, which is the economy R5 #10 inverted.
 */
function LatestMessage({ messages, now }: { messages?: readonly MessageView[]; now?: string }) {
  if (!messages) {
    return (
      <p className="pn-section__empty" data-testid="hub-latest-hollow">
        <HollowInline caption="No message read has run for this panel — the discussion list was never passed to this body.">
          — latest message
        </HollowInline>
      </p>
    );
  }
  if (messages.length === 0) {
    return (
      <p className="pn-section__empty" data-testid="hub-latest-empty">
        No messages yet.
      </p>
    );
  }

  const latest = messages.reduce((a, b) => (Date.parse(b.createdAt) >= Date.parse(a.createdAt) ? b : a));
  const author = latest.state.author ?? latest.createdBy;

  return (
    <div className="hub-latest" data-testid="hub-latest">
      <Avatar provenance={author.isAgent ? 'agent' : 'human'} label={author.displayName} size={22} />
      <div className="hub-latest__col">
        <div className="hub-latest__line">
          <span className="hub-latest__who">{author.displayName}</span> {latest.content.body}
        </div>
        <div className="hub-latest__meta">{`latest · ${timeAgo(latest.createdAt, now)}`}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Structural: the first scalar that reads as prose, whatever it is called. */
function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/** Structural: a summary array, or none. An absent member is not an error. */
function summaryArray(raw: unknown): EntitySummary[] {
  return Array.isArray(raw) ? (raw as EntitySummary[]) : [];
}

/** Structural: the auto-tab shape — a label and a count, whoever supplied it. */
function tabArray(raw: unknown): { key: string; label: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is { key: string; label: string; count: number } =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as { label?: unknown }).label === 'string' &&
      typeof (t as { count?: unknown }).count === 'number',
  );
}

/**
 * The oracle's "12m ago" (line 268). `now` is a parameter rather than a call
 * to the clock so the value is testable; the render instant is the default.
 *
 * A twin of this function lives in `graph/GraphView.tsx` (private there, so it
 * cannot be imported). Not measured whether the two should be one helper —
 * that is a shared-utility question for whoever owns the third copy.
 */
function timeAgo(iso: string, now?: string): string {
  const end = now ? Date.parse(now) : Date.now();
  const mins = Math.max(0, Math.round((end - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
