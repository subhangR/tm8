import type { ToolRun, ToolView } from '@tm8/contract';

/**
 * Which number is "the tool version" wherever the tool page prints `v<N>`.
 *
 * It is the EXECUTION version (Tools PR-F ruling, migration 381): the entity
 * version at which what runs (source, runtime, inputs, tm8 access, timeout)
 * last changed. A run pins it as `toolVersion`, the launcher header prints it,
 * and an `entities.versions` row is a definition version iff its
 * `content.execution_version` equals its `version`. `ToolView.version` stays
 * the concurrency token: it also moves on configuration, secret, help and
 * description writes and is what `expectedVersion` carries, so it is never
 * printed as the version. Every `v<N>` on the page (header, list tile, run
 * history column, output drawer, versions list and its resolution of a run's
 * pin) reads through these three functions, so a change is made here only.
 */
export const toolVersionOf = (tool: Pick<ToolView, 'version' | 'executionVersion'>): number => tool.executionVersion;
export const runVersionOf = (run: Pick<ToolRun, 'toolVersion'>): number => run.toolVersion;
/** An `entities.versions` row's own number: the entity version the row was stored at. */
export const snapshotVersionOf = (item: { version: number; snapshot: Record<string, unknown> | null }): number => item.version;
