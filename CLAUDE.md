# tm8

## Answer structural questions from the code graph, not from grep

This repository carries a pre-built graph of itself at `graphify-out/merged-graph.json`
(46,924 nodes: every file and symbol from an AST pass, plus every tm8 task, session and
commit, joined by 1,633 `commit -> file` edges extracted from `git show`). It is rebuilt
nightly by `scripts/graphify-refresh.sh` and costs no model tokens to build or query.

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

**Where it does not help.** Reading code to understand or change it. The graph answers
structure, not intent. Open the file for that.

**If the graph is stale or missing**, rebuild it with `scripts/graphify-refresh.sh` — one
AST pass, no model call — or fall back to grep and say that you did.
