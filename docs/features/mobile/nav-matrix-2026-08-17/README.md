# Cold-open navigation matrix — 2026-08-17

Recorded by `packages/tm8-ui/e2e/nav-matrix.mjs` (Lane N's instrument) in a real
Chrome (`channel: 'chrome'`) over the fixture composition (`mobile-audit.html`,
space `sp-atelier`), on main + Lane 0's harness. Raw data: `cold-open-matrix.json`
(parts A–C, ref `1e7ddb52`-era tree) and `back-walks.json` (part D, ref `67d311b5`).

## A. Cold open — 16 addresses × {phone-390, desktop-1440}

**32/32 land.** Right shell every time, hash settles to the canonical form with
no drift, no blank screens, no page errors, and no history entry spent on
arrival. On the phone, ten destinations render the designed honest refusal
(`mobile-not-on-phone` card) — workspace, feed, graph, files, git, messages,
board, craft, settings, settings/projects — exactly the set `MobileShell`
declares. The entity link (`e/{id}?origin=tasks`) renders the linked entity's
title on both shells.

## B. Share round trip — every settled hash reopened on the other shell

**32/32 hash-stable, both directions.** A link taken from the phone address bar
lands the desktop on the same destination, and vice versa. The address bar IS
the share link (CopyLinkControl builds from the same codec with empty panels).

## C. Links that name nothing — each must fail with a sentence

| Link | Result | Honest? |
|---|---|---|
| `e/{id}` (no origin) | phone: unrouted card ("This link doesn't name a screen…"); desktop: kept-address card ("The full view for a single entity isn't built yet… the link has been kept") | **yes**, both |
| `e/{missing-id}?origin=tasks` | desktop: tasks list + **eternal loading skeleton** in the detail pane; phone: bare list, no message | **NO — defect N-1** (`nav-fail__desktop-1440__entity-nonexistent.png`) |
| `k/{unknown-slug}` | refusal card, address kept | yes |
| `#/s/{unknown-space}/…` | toast on BOTH shells: "That link points at another Space… You are where you left off." (`nav-fail__phone-390__unknown-space.png`) | yes |
| bare legacy `#/tasks`, no last-active space | lands Home; the "tasks" intent is dropped **silently** | recorded — minor (N-2) |

**N-1 is the open defect:** a shared link to a deleted/unshared/nonexistent
entity looks like it is loading forever. The failure the recipient actually hits
on the product's viral surface, and it says nothing. (The fixture seam cannot
distinguish deleted from no-access — the live-server nuance still needs a
live-node drive — but the *absence of any terminal state* reproduces regardless.)

## D. Back, driven for real — `page.goBack()` on real history

**4/4 PASS** on both shells (BACK-CONTRACT §6 walks A and C):

- Drill by a real row click pushes exactly one entry (`e/{id}?origin=tasks`).
- Back lands on `k/tasks` and **holds** — re-read 1.2 s later, no bounce-back
  (the two-item trap PR #229 fixed stays fixed, now proven in Chrome).
- Forward rebuilds the drill exactly.
- A cold entity arrival has **zero** entries behind it (`goBack()` refuses):
  back belongs to the browser, per Q4.

Concession recorded in the JSON: the phone row click needed `force: true`
because the pre-Lane-2 layout defect (desktop detail pane drawn over the
clipped 320px list — on Lane 0's baseline) fails Playwright's actionability
check. Layout defect, Lane 2's; the router semantics underneath are correct.
