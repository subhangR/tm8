# Shared-link refusal wiring

These components are deliberately presentational. The router lane owns the files that decide when they render.

- Render `SpaceAccessRefusal` when the requested `spaceId` cannot be opened and the API returns one privacy-preserving refusal. This is the recommended production path for both an unknown Space on this node and a known Space whose membership read is refused.
- Render `WrongNodeRefusal` only if a future API contract explicitly and safely establishes that the requested Space does not exist on this node.
- Render `NotSpaceMemberRefusal` only if a future API contract explicitly chooses to disclose that the Space exists and establishes that the viewer is not a member.
- Render `EntityUnavailableRefusal` after the requested Space has opened successfully but the canonical `e/{id}` read returns not found. Keep it standalone: do not resolve or render an origin companion. Its recovery action should navigate to the already-open Space's safe default view with a history replacement, so the dead entity URL is not restored by Back.

For every Space refusal, do not call `setSpaceId` with the first available Space as an implicit fallback. If a recovery callback is supplied, it is an explicit user action. If no safe action is wired, omit the button; the shared card never draws a control that cannot perform.

R4 recommendation: keep wrong-node and non-member indistinguishable at the API surface. A link holder should not be able to probe whether a Space id exists. The combined card gives the recipient both honest next steps without disclosing which condition occurred.
