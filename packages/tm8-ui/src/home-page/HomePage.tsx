/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * ONE canvas: the CHAT is the full-bleed hero, with main's root list, resizer
 * and focus mode left intact. (The beside-it detail column, region C, retired
 * with the right trail — task 01a0c864 U2.)
 *
 * NO ATTENTION SECTION (Subhang, 2026-09-27). A NEEDS YOU strip used to ride
 * above the chat. It pushed the conversation down to repeat what the tab bar
 * already carries: `AttentionTopSegment` (desktop, `! N mine · M all`, whose
 * popover is the same `AttentionList`) and `AttentionHeaderButton` +
 * `AttentionSheet` (phone). The tab bar is attention's only entry on Home, so
 * the chat starts directly under it.
 *
 * WHAT IS NO LONGER HERE, AND WHY (Subhang, 2026-09-05). This page used to
 * stack two credential sections above the chat — the full
 * `CredentialsProviderBlock` and the compact `ProviderRail`. Both are gone.
 *
 * They were wrong in two independent ways. STRUCTURALLY: a card grid is a flex
 * item with `min-height: auto`, so it could not shrink; on any ordinary window
 * the two sections plus the chat exceeded `.hp-page`, and with no `overflow` on
 * the column the grid painted straight over the conversation underneath.
 * EDITORIALLY: they were shown to every member on every visit, finished or not,
 * which is a permanent region of the screen spent on a task that has an end.
 *
 * Credentials now live in exactly two places: `CredentialsSetupDialog` (the
 * guided flow, opened for a member who has not finished) and Settings → Agent
 * credentials (the management surface). Home is the rail, the list and the
 * view — nothing stacked on top of them.
 */
import type { ReactNode } from 'react';
import './home-page.css';

export interface HomePageProps {
  /** The chat surface — the host mounts it (seam wiring is its business). */
  chat: ReactNode;
  /**
   * The icon rail (task 01a00932 R4) — the host builds it (its state is the
   * host's root selection); this page only seats it leftmost in the row.
   */
  rail?: ReactNode;
  /**
   * Column A's separator — the drag handle when A is open, the reveal button
   * when it is collapsed (task 01a00ac2). It seats INSIDE the chat section
   * rather than beside the rail because A is not a child of this page at all:
   * it is `.tch-sidebar`, a grid track inside the chat surface the host hands
   * down. The section is the nearest box that starts and ends exactly where A
   * does, which is what lets the handle line up with the edge it moves
   * without this page having to know anything about that grid.
   */
  listRail?: ReactNode;
  /** Rail + column A collapsed as one. Read by CSS off `data-focus`. */
  focus?: boolean;
}

export function HomePage(props: HomePageProps) {
  /* R4 (2026-08-15): Home IS the chat view. The chat surface — with its
     merged conversation column — fills the canvas.
     The glance rails, the presence row and the per-kind counts strip retired
     to the Work tab, where the inventory framing lives. */
  return (
    <div
      className="hp-root hp-root--chat"
      data-testid="home-page"
      data-focus={props.focus ? 'true' : undefined}
    >
      {props.rail ?? null}
      <div className="hp-page">
        <section className="hp-chat hp-chat--full" aria-label="Chat">
          {props.chat}
          {props.listRail ?? null}
        </section>
      </div>
    </div>
  );
}
