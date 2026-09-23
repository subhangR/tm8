# tm8

## Answer structural questions from the code graph, not from grep

A pre-built graph of this repository sits at `graphify-out/merged-graph.json` (every file
and symbol from an AST pass, plus recent tm8 tasks, sessions and commits, joined by
`commit -> file` edges extracted from `git show`). It costs no model tokens to build or query.

It is not committed (`/graphify-out` is gitignored). `scripts/graphify-refresh.sh` writes it
into the **launch project** — the checkout worker lanes are cut from — and worktree
provisioning **symlinks** each new lane's `graphify-out` to that directory, so a lane needs
no copy step and always sees the latest refresh. A lane provisioned before the link step
existed has no `graphify-out`; `ln -s <launch-project>/graphify-out graphify-out` fixes it.

**Ask it first for anything structural:**

```
graphify affected "<symbol>"  --graph graphify-out/merged-graph.json --depth 2
graphify path    "<A>" "<B>"  --graph graphify-out/merged-graph.json
graphify explain "<symbol|sha>" --graph graphify-out/merged-graph.json
graphify query   "<question>" --graph graphify-out/merged-graph.json --budget 1500
```

Structural means: what calls this, what breaks if I change it, where does this path lead,
which files did this commit or task touch.

**Why.** Everything a tool returns stays in the conversation and is re-sent on every later
turn. Measured across the 59 largest sessions on this node, **tool results are 93.8% of all
re-read context** — 232MB against 5MB of everything else. Grepping and opening candidate
files to answer one structural question measured **40% more expensive and half as complete**
as one graph call, and the graph run named fourteen transitive dependents the file-reading
run never reached.

**When the graph answers, that IS the answer. Stop.** Do not re-check it by grepping. It is
an AST index built from the same files you would have opened, not a guess, and every edge it
reports is extracted rather than inferred. Measured: agents that queried the graph and then
grepped anyway paid for both and saved nothing, while the one run that let the graph finish
the job used 3 tool calls instead of 14 and cost 63% less.

**One or two queries should settle a structural question.** If three have not, the question
is not structural — stop querying and read the file.

**Where it does not help.** Reading code to understand or change it. The graph answers
structure, not intent. Open the file for that.

**If the graph is stale or missing**, rebuild it in the launch project — never from inside
a lane, where `graphify-out` is the shared symlink (the script refuses) — with
`scripts/graphify-refresh.sh <launch-project> <space-id> origin/main`: one AST pass of a
clean `origin/main`, no model call. With no arguments it targets the prod host. Or fall back
to grep and say that you did.
