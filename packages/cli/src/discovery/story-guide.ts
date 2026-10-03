import type { GuideSection } from './form-guide.js';

/** Stories reuse existing entity and membership operations; there is no story command. */
export function storyGuide(): GuideSection[] {
  return [
    { title: 'Create and describe', lines: [
      `tm8 entity create story "Release" --content '{"description":"Ship the release"}' --when-to-use "Open when planning the release" --summary "Release work and evidence"`,
      'Add --parent <story-id> to create a child story. Stories are durable context; tasks are actionable work.',
    ] },
    { title: 'Curate roots', lines: [
      'tm8 collection add <story-id> <entity-id>...',
      'tm8 collection remove <story-id> <entity-id> --yes',
      'Roots are put in by hand. The story follows their connected work at read time; removing a root leaves the entity intact.',
    ] },
    { title: 'Read and page', lines: [
      'tm8 entity context <story-id> --format json',
      'tm8 entity context <story-id> --sections story',
      'tm8 entity context <story-id> --sections assignment --offset <bytes>',
      'Follow omitted[].expand and notLoaded[].expand for exact continuation commands. Story lists page independently with --sections story --cursor <cursor>.',
      'tm8 entity get <story-id> --full --format json returns the description and bounded story context, with cursor continuation commands; add --story-page only for the full browser page.',
    ] },
    { title: 'Status and work', lines: [
      'tm8 entity update <story-id> --status <status> --expect-version <version>',
      'Story status is set by hand; task progress and child-story rollup describe the work separately. Use the version returned by entity context.',
      'tm8 session spawn --story <story-id> --teammate <teammate-id>',
      '--story anchors work directly to the story without creating a task; exclusive with --task and --force-new-task.',
      'tm8 session spawn --task <task-id> --teammate <teammate-id>',
      'Use tm8 help session spawn for the available launch options. A session working on a root task appears in the story trail.',
    ] },
    { title: 'Understand progress', lines: [
      "progress counts contained tasks and stories; taskProgress counts only this story's contained tasks. rollup is the union of own and descendant-story tasks, deduplicated by entity ID.",
      'A root itself counts, so a task root plus its task subtree is one more than the subtree alone. Parented child stories contribute themselves to progress and their tasks to rollup; an edge-only story contributes itself but not its tasks. These differences explain apparent off-by-one totals.',
      'Overlapping roots and child stories are deduplicated by ID; do not sum their individual counts. Sideways trail links, docs, sessions and teammates never add progress work.',
      'done + inProgress + toDo + blocked = work; cancelled is outside work. Unfinished work is blocked by an explicit task blocked status or an unresolved hard dependency.',
      'Optional staleInProgress is a subset of inProgress: tasks without a direct visible, nondeleted spawning/running/idle session linked by working_on. Never add it to the bands; absent means unavailable, not zero.',
      'Definitions and a worked example: docs/features/stories/STORY-PROGRESS.md.',
    ] },
    { title: 'Find candidate roots', lines: [
      'tm8 entity query --words "release plan" --limit 20',
      'tm8 entity query --kind story --title-contains "Release" --limit 20',
      'tm8 graph query --focus <entity-id> --hops 1 --limit 20',
      'Use --cursor <cursor> to continue a query; add selected entity ids with collection add.',
    ] },
  ];
}
