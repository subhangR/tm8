# Upstream agent-tooling integrations (handoff v3, 2026-11-28)

Nine upstream repos (superpowers, ponytail, mattpocock/skills, flutter/agent-plugins,
harness-engineering-playbook, diagram-design, impeccable, graphify, headroom), each pinned
to a commit. The goal: every function they ship (skills, slash commands, agents, hooks,
MCP servers, scripts and CLIs) works inside tm8 through tm8's own surfaces.

## Coverage manifest

`function-coverage-2026-11-28.json` has one row per function surface. It is generated from
`git ls-files` at each pin by `scripts/integrations/gen-function-coverage.py`:

    python3 -I scripts/integrations/gen-function-coverage.py <dir-of-pinned-clones> ~/.claude/skills out.json

States: `IMPLEMENTED` (executed evidence linked), `PROVISIONED-UNTESTED`, `UNIMPLEMENTED`,
`OUT-OF-SCOPE` (reason required). The generator never sets IMPLEMENTED. Only a recorded
test run does. Any UNIMPLEMENTED row without an OUT-OF-SCOPE reason blocks that repo's "done".

Skeleton state at generation: 344 rows: 34 PROVISIONED-UNTESTED, 310 UNIMPLEMENTED.
Skill counts reconcile with the inventories: mattpocock 39 (20 engineering, 7 productivity,
4 misc, 8 in-progress), flutter 25, superpowers 15, ponytail 6, and one each for harness,
diagram-design, impeccable, graphify and headroom.

## Which tm8 surface carries which function (checked against this tree)

| Surface | tm8 mechanism | Where |
|---|---|---|
| Skills | skill entities from `~/.claude/skills/<name>/`; **supporting files must be on disk**, because tm8 never injects bodies | `packages/server/src/skills/discovery.ts` |
| Slash commands, agents, hooks | **Claude plugins**: installed plugins are set `false` in minimal lanes and `true` when a persona lists them or an equipped skill belongs to the plugin | `packages/execution/src/spawn/harness-surface.ts` |
| MCP servers | **tm8 connectors** only (`tm8 mcp server create`, admin approve, per-session selection); stdio needs `stdioTrusted` | `packages/server/src/mcp/proxy.ts`, `docs/mcp-connectors.md` |
| Scripts / CLIs | TOOL entities: typed inputs, argv only, PTY-recorded runs | `db/migrations/318_tools.sql` |
| Model-path proxies (headroom) | per-credential backend at the API-key routing seam, opt-in flag, default off | `packages/execution/src/credentials/api-key-credentials.ts` |

### Corrections to the handoff plan

1. **`launch.mcpServers` is not a provisioning path.** `asMcpServers`
   (`packages/execution/src/spawn/manifest.ts`) accepts only `{}` and throws on anything else.
   Every lane runs `--strict-mcp-config` with only connector bridges. So the Dart MCP server
   (`dart mcp-server`, declared in flutter's `.claude-plugin/plugin.json` at the pin), the
   browser MCP server and impeccable's MCP crate become stdio connectors.
2. **Hooks should arrive as plugin hooks**, not hand-registered entries in per-session
   provider settings. Eight of the nine repos ship `.claude-plugin/plugin.json`; graphify and
   the harness playbook do not.
3. **The supporting-file gap is wider than "16 skills".** That count covered skills whose
   SKILL.md *names* a missing file. Comparing file sets shows 54 host skill dirs that lack
   files present at the pin: mattpocock 39, superpowers 9, flutter 3, and one each for
   harness, diagram-design and impeccable. For 23 of the 39 mattpocock skills the only
   missing file is `agents/openai.yaml`, a Codex agent definition that Claude lanes don't
   need.
4. `mattpocock-skills` plugin.json lists only 27 skills. The 8 in-progress and 4 misc skills
   exist only as host skills, never through the plugin.
