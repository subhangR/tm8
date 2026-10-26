# Reading and curating stories from the CLI

Open this guide when creating, reading, discovering or adding roots to stories. It describes the bounded reader modes and their continuation commands, search filters, membership receipts, and direct session launches. `tm8 help story` provides the same workflow at the terminal.

## Create and find

```sh
tm8 entity create story "Release" --content '{"description":"Ship the release"}' --when-to-use "Open when planning the release" --summary "Release work and evidence"
tm8 entity query --kind story --title-contains "Release" --limit 20
tm8 entity query --words "release plan" --limit 20
tm8 graph query --focus <entity-id> --hops 1 --limit 20
```

`--title-contains` matches a literal title substring without regard to case. `--words` requires every word across the title and short description, including a story description. Queries obey access controls. Follow a returned cursor with the same filters and `--cursor <cursor>`.

## Read a bounded page

```sh
tm8 entity context <story-id> --format json
tm8 entity context <story-id> --sections story --format json
tm8 entity get <story-id> --full --format json
```

Context defaults to a 16 KiB budget. Its `omitted` and `notLoaded` entries carry exact continuation commands. A story list continues with `entity context <story-id> --sections story --cursor <cursor>`; follow the supplied cursor because each story list pages independently. Body text continues with `--sections assignment --offset <bytes>`.

The CLI requests `entities.get?story=context`. A story detail includes its description, `page: null`, and `content.context`, using the same bounded story section and cursor pointers as `entity context`. `--full` retains the detail envelope and complete description while keeping the embedded story graph bounded. An explicit `--story-page --full` loads the browser page; browser callers that omit the reader query retain their existing page payload. The bounded context budget applies to the embedded context, not to the rest of the full detail envelope.

`entity get` and `entity context` accept unique readable UUID prefixes of at least eight hexadecimal digits, with canonical hyphens or without them. Ambiguous prefixes return readable candidate IDs; extend the prefix and retry. Mutations require full IDs. Use full IDs in durable instructions when available.

## Curate roots

```sh
tm8 collection add <story-id> <entity-id> <entity-id>
tm8 collection add <story-id> --from-file roots.txt
tm8 collection remove <story-id> <entity-id> --yes
```

The file contains whitespace-separated IDs; `--from-file -` reads stdin. Bulk add removes repeated IDs and appends in input order. `--position` is available only for a single ID. Each ID is an independent membership write, so a batch can partially succeed. Its one `tm8.receipt.v1` receipt reports per-ID results, `ok`, and a batch `mutationId`. Any failed ID makes the exit code nonzero. The receipt's `next` command replays the whole batch with the same IDs and batch mutation ID; it includes IDs read from files or stdin so the source need not be read again.

To retry just one failed item, use that result's `next` command, which supplies its derived per-ID `mutationId`. **Do not use the batch mutation ID for a one-item subset:** single add passes its mutation ID through unchanged. A transport failure, malformed successful response, or retryable server failure can mean the write already committed; these results carry `outcome: "unknown"`. Human output also prints the batch ID, whole-batch replay command, unknown outcomes, and safe per-item retry commands. Replaying with the same identity recovers the original result without repositioning a member that was already added.

Single add and remove use the standard compact receipt for agent callers. `--full` preserves the server result. Removing membership leaves the entity intact.

## Status and sessions

```sh
tm8 entity update <story-id> --status in_progress --expect-version <version>
tm8 session spawn --story <story-id> --teammate <teammate-id>
tm8 session spawn --task <task-id> --teammate <teammate-id>
```

Story status is set by hand; task progress and child-story rollup describe the work separately. Read the current version before changing status. `--story` anchors a session directly to a story without creating a task. It is exclusive with `--task` and `--force-new-task`; at the API, `storyId` also excludes `newTask`. Authenticated child sessions inherit the durable story anchor and story context. A session working on a root task appears in the story trail.

The launch manifest captures one bounded story snapshot. An explicit `--story` uses that story. A task launch selects the nearest readable story containing its primary task: the fewest traversal hops from a story root wins, with ties broken by story ID. A task that is itself a root has depth zero; a task reached through a root has positive depth. The selected story contributes its description, task progress, roots, live sessions, and blocked work. The snapshot can be clipped or unavailable; use `entity context <story-id>` for current state and continuation commands.

This is the selected containing story's scope, not automatically the top-level story's scope. For example, a task directly rooted in child story C can receive C's snapshot even when C belongs to parent story P. Further containing stories are listed as ID/title references only; the manifest does not inline the full parent or sibling story context. Read P separately when that broader context is needed. Direct `--story P` instead selects P, and authenticated child sessions inherit that direct anchor.
