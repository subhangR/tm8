# Shared-link refusal wiring

These components are deliberately presentational. The router lane owns the files that decide when they render.

## WIRED — where the decisions now live

The two production paths are mounted. This section records where, so the next
reader does not have to find them; everything below it is the original note and
is unchanged.

- `SpaceAccessRefusal` — `views/useGateData.ts` decides. Its boot read opens the
  Space the ADDRESS named or opens nothing, and holds `linkSpaceUnavailable`.
  `views/GateApp.tsx` renders the card from that flag, above the shell fork.
  The note's central prohibition is now a property of the machine rather than a
  rule the caller has to remember: there is no `setSpaceId` fallback left to
  reach for, which is why `spaceId` is empty while the card is up.
- `EntityUnavailableRefusal` — `views/useLinkedEntity.ts` decides, from the
  canonical `seam.entity` read. `not_found` and `forbidden` mean gone; every
  other failure means the node could not answer, and draws no tombstone.
  Recovery is `GateApp`'s `recoverFromDeadEntity`: the Space's `defaultRoute`,
  written as a history REPLACEMENT, with the screen stacks cleared alongside it
  (the address↔stack sync runs both ways, so a seeded dead id would otherwise
  re-derive the same route on the next visit to that screen).
- `WrongNodeRefusal` / `NotSpaceMemberRefusal` — still unused, still on purpose.
  The R4 reasoning is written out at `GateApp`'s `addressedSpace`, which is
  where the fact that separates the two audiences (arrival by address vs by
  memory) is read.

Pinned by `views/link-refusal-wiring.test.tsx`, whose negative assertions are
the load-bearing half: that no other Space is opened, and that neither specific
card appears on the link-arrival path.

- Render `SpaceAccessRefusal` when the requested `spaceId` cannot be opened and the API returns one privacy-preserving refusal. This is the recommended production path for both an unknown Space on this node and a known Space whose membership read is refused.
- Render `WrongNodeRefusal` only if a future API contract explicitly and safely establishes that the requested Space does not exist on this node.
- Render `NotSpaceMemberRefusal` only if a future API contract explicitly chooses to disclose that the Space exists and establishes that the viewer is not a member.
- Render `EntityUnavailableRefusal` after the requested Space has opened successfully but the canonical `e/{id}` read returns not found. Keep it standalone: do not resolve or render an origin companion. Its recovery action should navigate to the already-open Space's safe default view with a history replacement, so the dead entity URL is not restored by Back.

For every Space refusal, do not call `setSpaceId` with the first available Space as an implicit fallback. If a recovery callback is supplied, it is an explicit user action. If no safe action is wired, omit the button; the shared card never draws a control that cannot perform.

R4 recommendation: keep wrong-node and non-member indistinguishable at the API surface. A link holder should not be able to probe whether a Space id exists. The combined card gives the recipient both honest next steps without disclosing which condition occurred.
