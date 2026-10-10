import type { ToolDefinition, ToolJsonValue, ToolRun, ToolRunInput, ToolView } from '@tm8/contract';

export interface ToolPermissions {
  edit: boolean;
  configure: boolean;
  setSecret: boolean;
  run: boolean;
}
export interface ToolSourceChange { changedBy: string }
/** Stored tool operations; a run request contains values only. */
export interface ToolPort {
  get(toolId: string): Promise<ToolView>;
  permissions(toolId: string): Promise<ToolPermissions>;
  update(tool: ToolView, definition: ToolDefinition): Promise<unknown>;
  setConfig(tool: ToolView, inputName: string, value: ToolJsonValue): Promise<unknown>;
  unsetConfig(tool: ToolView, inputName: string): Promise<unknown>;
  setSecret(tool: ToolView, inputName: string, secret: string): Promise<unknown>;
  unsetSecret(tool: ToolView, inputName: string): Promise<unknown>;
  history(toolId: string, cursor?: string): Promise<{ items: ToolRun[]; nextCursor: string | null }>;
  sourceChange(tool: ToolView): Promise<ToolSourceChange | null>;
  run(input: ToolRunInput): Promise<{ sessionId: string }>;
  runGet(sessionId: string): Promise<ToolRun>;
}
