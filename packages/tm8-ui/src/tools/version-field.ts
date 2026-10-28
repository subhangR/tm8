import type { ToolRun, ToolView } from '@tm8/contract';

/**
 * Which number is "the tool version" wherever the tool page prints `v<N>`.
 *
 * Today it is `entities.version`: `ToolView.version`, the `toolVersion` a run
 * pins and an `entities.versions` row's `version` all count the same thing.
 * Tools PR-F (task 01a183cd-bf62-7272-a1c7-ee1f45cebf55) is settling whether
 * runs should pin `executionVersion` instead, which moves only on definition
 * edits where `entities.version` also moves on config and secret writes. Every
 * `v<N>` on the page (header, run history column, output drawer, versions list
 * and its resolution of a run's pin) reads through these three functions, so
 * that switch is a change here and nowhere else.
 */
export const toolVersionOf = (tool: Pick<ToolView, 'version' | 'executionVersion'>): number => tool.version;
export const runVersionOf = (run: Pick<ToolRun, 'toolVersion'>): number => run.toolVersion;
/** An `entities.versions` row: `version` is the entity version; `snapshot.content.execution_version` would be the definition's. */
export const snapshotVersionOf = (item: { version: number; snapshot: Record<string, unknown> | null }): number => item.version;
