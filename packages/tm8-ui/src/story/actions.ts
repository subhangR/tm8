/**
 * Everything the story page can DO, as one optional-member seam.
 *
 * The page never calls the server itself. The host (EntityDetailPanel → the
 * story body) passes a `StoryActions`; every affordance whose member is absent
 * is NOT drawn (no dead controls). The integration lane wires the members to
 * the real ops: CRUD rides entities.create / entities.patch, add/remove ride
 * collection add/remove on a story container, messages ride messages.post,
 * spawn/dispatch ride session spawn.
 *
 * Every member resolves with the id of what it created (or void) and rejects
 * with an Error whose message is shown to the user as-is.
 */
import type { TeamMemberMode } from '@tm8/contract';

/** What the "Add anything" sheet / a node popover can make. */
export type StoryIntent = 'spawn' | 'dispatch' | 'task' | 'message' | 'coordinator' | 'child-story';

export interface StoryAddRequest {
  intent: StoryIntent;
  /** Plain-words title / body the user typed. */
  text: string;
  /** Where it goes: the story id, a root/child task id, or a live session id. */
  onId: string;
  /** Which teammate it runs as (spawn/dispatch/coordinator); null = a new teammate. */
  asTeammateId?: string | null;
  /** Mode for a new teammate. */
  mode?: TeamMemberMode | null;
  /** Who gets ONE message that the new thing exists (teammate or person ids). */
  tellIds: string[];
}

export interface StoryActions {
  /** The sheet and node popovers funnel here. */
  add?: (req: StoryAddRequest) => Promise<string | void>;
  /** Inline "+ task under this root". */
  createTask?: (parentId: string, title: string) => Promise<string | void>;
  /** Click-to-rename on any task title (and the story title). */
  rename?: (entityId: string, title: string) => Promise<void>;
  /** Mark a task done (popover). */
  markDone?: (entityId: string) => Promise<void>;
  /** Post a message on any anchor in the story (feed composer, popover). */
  sendMessage?: (anchorId: string, body: string) => Promise<string | void>;
  /** Put an existing entity into the story as a root / take one out. */
  addRoot?: (entityId: string) => Promise<void>;
  removeRoot?: (entityId: string) => Promise<void>;
  /** Change the story's own status. */
  setStatus?: (status: string) => Promise<void>;
  /** Navigate to any entity. */
  open?: (entityId: string) => void;
  /** Open a list filtered to this story (tasks / sessions / memories / messages, by kind). */
  filterBy?: (kind: string) => void;
}
