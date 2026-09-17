Mobile task and session lists, captured in Playwright 1.58.2 Chromium.

The fixture uses the real EntityListPanel with long titles, two PR chips,
message counts, and long worktree branches. It performs no server writes.

Validation:
- 320, 390 and 430 CSS pixels, light and dark: 12 scenarios passed.
- Collapsed rows expose only their disclosure, including while hovered.
- Disclosures and expanded actions are at least 44 × 44; actions never overlap titles.
- Expanding details does not open launch options; empty dates use Add dates.
- Branches and controls stay within the viewport; collapse restores row height.
- Desktop task and session hosts still expose their hover actions.
- UI typecheck, 182 targeted unit tests and production build passed.

Reproduce from packages/tm8-ui with Vite running:

```sh
bun run dev
# in another terminal (Playwright Chromium must be installed):
bun run test:mobile-lists
```

MOBILE_LIST_BASE_URL overrides the default http://127.0.0.1:4612.
MOBILE_LIST_OUTPUT overrides /tmp/tm8-mobile-list-evidence. The four checked-in
screens show the 390px dark theme; the runner captures every scenario.
This workspace used the Playwright v1.58.2-noble container and
MOBILE_LIST_SINGLE_PROCESS=1 because its host Chromium subprocesses crashed.

Prior PR #618 added collapsed-session CSS but explicitly lacked browser
verification. Remaining problems included desktop hover transforms overriding
mobile static task actions, expanded session actions consuming title width,
and content-box title height. This change also gates closed phone actions in
React so their visibility does not depend on CSS order.
