# W5 Duo B — archived reds

An archived red is only an **acceptance criterion** if it describes the fixture and the
assertions the fix was measured against. A red taken against a fixture that has since
changed is **evidence of discovery** and nothing more. The two look identical in a
directory listing, which is why they are named apart here.

## `B1-CLOSED-acceptance-red.run.txt` — sha256 prefix `8798198258aa438b`

**Was, and was honoured as, an acceptance criterion. B1 is closed.**

`inbox.list`'s teammate-inspection branch (`inbox-read-marks.ts:349` → the RPC at `:258`)
selected no `cursor_created_at`, while the shared mint at `:430` encoded it unconditionally.
`undefined` in a keyset serialises to JSON `null`, so the server minted a cursor it then
rejected itself at `:174` — page 2 unreachable.

Fixed by computing `MICROS('owned_row.created_at')` in the existing outer select. No
migration was required (the RPC's `returns setof` constrains what the FUNCTION emits, not
what an outer select may compute over its alias).

**The number that matters is not the 6/6 green.** It is that the test file's sha256 was
`99e30166da87a634` both before the fix and after it — *the red and the green were produced
by the same bytes of assertion*. The detector was not adjusted to meet the fix.

## `B4-ACCEPTANCE-CRITERION-red.run.txt` — sha256 prefix `40f4eca093d6a5c4`

**The live acceptance criterion for B4. Not yet fixed.**

Taken against the RESEEDED fixture. An earlier red for this same finding exists in the
session record but is NOT archived here and is NOT the criterion, because it was produced
by a fixture that no longer exists — it used `default now()`, which had two defects:

1. ~1 run in 1000 the shared transaction timestamp lands on an exact millisecond, `iso()`
   loses nothing, and the mechanism assertion passes with the defect fully present.
2. With every row identical, `distinct_ms < total` was `1 < 25` — always true, incapable
   of failing. The assertion's SHAPE was copied from the W2 precision fixture without its
   PREMISE.

The current fixture uses a frozen literal `.891823` incremented one microsecond per row, so
the red is deterministic: `'2026-07-25T14:59:01.891Z'` is that value with its microseconds
destroyed by `iso()`.

**Scope, stated narrowly:** `spaces.home` advertises a `nextCursor` no operation in the
catalog accepts, and that cursor is provably truncated. It is **not** data loss today —
nothing consumes the cursor. The honesty assertion can be satisfied by `nextCursor === null`.

⚠ **A KNOWN WEAKNESS IN THAT ASSERTION, RECORDED BEFORE THE FIX RATHER THAN DISCOVERED
AFTER:** it returns early when `nextCursor` is null, so a fix that WITHDRAWS the cursor
makes it assert nothing — a detector going quiet at exactly the transition it exists to
observe. The direct `loadActivity` round-trip check exists to cover that case and cannot be
satisfied by withdrawal.
