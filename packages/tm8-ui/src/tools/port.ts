import type { HeaderTextInput, ToolDefinition, ToolJsonValue, ToolRun, ToolRunInput, ToolView } from '@tm8/contract';
import type { ToolVersionsPage } from './versions-model';

export interface ToolPermissions {
  edit: boolean;
  configure: boolean;
  setSecret: boolean;
  run: boolean;
}
export interface ToolSourceChange { changedBy: string }
/** What became of a selection header sent after a create; a node that stores none says why. */
export type ToolHeaderOutcome = { stored: true } | { stored: false; reason: string };
/** Stored tool operations; a run request contains values only. */
export interface ToolPort {
  /** `tools.create`: the new tool's view. */
  create(spaceId: string, definition: ToolDefinition): Promise<ToolView>;
  /** `entities.header.set` for a tool's selection header (when-to-use, summary, keywords). */
  setHeader(toolId: string, header: HeaderTextInput): Promise<ToolHeaderOutcome>;
  /** Every tool in the space, all `tools.list` pages. */
  list(spaceId: string): Promise<ToolView[]>;
  get(toolId: string): Promise<ToolView>;
  permissions(toolId: string): Promise<ToolPermissions>;
  update(tool: ToolView, definition: ToolDefinition): Promise<unknown>;
  setConfig(tool: ToolView, inputName: string, value: ToolJsonValue): Promise<unknown>;
  unsetConfig(tool: ToolView, inputName: string): Promise<unknown>;
  setSecret(tool: ToolView, inputName: string, secret: string): Promise<unknown>;
  unsetSecret(tool: ToolView, inputName: string): Promise<unknown>;
  history(toolId: string, cursor?: string): Promise<{ items: ToolRun[]; nextCursor: string | null }>;
  sourceChange(tool: ToolView): Promise<ToolSourceChange | null>;
  run(input: ToolRunInput & { toolId: string; expectedVersion: number }): Promise<{ sessionId: string }>;
  runGet(sessionId: string): Promise<ToolRun>;
  /** Stored snapshots (`entities.versions`), newest first; version numbers may have gaps. */
  versions(toolId: string, cursor?: string | null): Promise<ToolVersionsPage>;
}
