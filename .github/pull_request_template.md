<!--
Optional. Delete anything that does not apply — an empty section is worse than
no section, and nobody should be filling in ceremony to land a one-line fix.
-->

## What and why

<!-- What changes, and what made it necessary. -->

## Depends-on

<!--
ONLY if this PR's correctness or SAFETY relies on another PR being in main
first. Uncomment and list them:

Depends-on: #376

A stated dependency is ENFORCED — the `stated dependencies are merged` check
goes red until every PR you list is merged. Nothing to state? Delete this
section; the check passes instantly.

This exists because of a real near-miss. #389 moved the chat runtime to
`bypassPermissions` — a full-trust shell — and its safety rested entirely on
#376, which taught the secret redactor the tm8 token shape (the runtime writes
a live 24h `tm8s_` token into a per-thread mcp.json that a full-trust Bash can
read). NOTHING RECORDED THAT. It was found by reading the diff, and the two
landed in the safe order only because of the order they happened to go green.
Reversed, main would have briefly carried a full-trust shell over an
un-redacted token, and no one would have been warned.
-->

## How it was verified

<!--
What you actually ran, and what it said. "CI is green" is not a verification —
CI's coverage has holes and this repo has found several:

  * a `migrations apply clean` tick is computed against your PR's BASE, so it
    cannot see a migration-number collision with a migration merged since;
  * a suite can report every test passing AND fail, on unhandled rejections
    that carry no test name — check the exit code, not just the failing set;
  * before #379, CI did not run packages/tm8-ui AT ALL, so UI PRs were green
    about code that was never executed.

Naming the check you trusted lets the next person tell whether it could
actually have seen the thing you are claiming.
-->
