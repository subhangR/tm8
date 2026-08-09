# 10 — Open decisions

> Design document, exported from the tm8 graph at entity `019fdc8d-5ca4-7009-b9a0-b7495e5687b2` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 10 — Open decisions

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## Part 5 — Decisions needed before build

1. **Storage: A or B?** Recommend **B** (node-local, DB holds metadata). The Claude OAuth
   refresh-in-place constraint effectively forces it. Confirm S15 stays as written.
2. **Default policy: `node-fallback` or `own`?** Recommend `node-fallback` (nothing breaks),
   with the resolved policy visible in the session header.
3. **Is T0 acceptable to ship?** It gives per-user credentials with **no** cross-user isolation on
   one OS uid. Recommend yes, with S12-style honest UI copy — but this is a product call, not a
   technical one.
4. **Scope of "whatever apps they have."** Recommend a **closed, server-owned provider registry**
   (anthropic / openai / github / gemini) at first. Arbitrary user-named env vars are local code
   execution; if generic credentials are wanted later they need their own value-shape and
   name-shape rules.
5. **Does per-user credential imply per-user project?** C4 (shared `projects.working_dir`, no
   owner column) is untouched by this plan and is a much larger change. Recommend explicitly
   out of scope, and say so, rather than letting "per-user" imply it.


## 6.8 Decisions this adds to Part 5

6. **Register a tm8 GitHub OAuth App?** Tier A is the good UX and cannot exist without it.
   Who owns it, and is it per-node or one shared client? (Device flow needs no client secret,
   which makes a shared client viable.)
7. **Per provider: env var or config file?** Measured — `gh` refuses to log in when `GH_TOKEN`
   is set, so the two modes cannot both be on. Recommend **file-based for GitHub** (survives
   `gh` and `git` both), **env-var for API keys**, and record the mode in `credential_refs`.
8. **Are credential sessions spawnable by agents?** Recommend **no** — human-initiated only,
   never via `execution.spawn`, never inherited by a child. An agent that can open a login
   terminal can phish its own operator.
