/**
 * THE STORY'S MESSAGES, handed to the page by the panel (task 01a101c5).
 *
 * A story panel has no Messages tab: the conversation is a section under the
 * story's own sections. The panel owns that surface (`discussionSurface`, the
 * host-composed one every other kind shows in its tab) and the page is built
 * by the host as an opaque node (`storySurface`), so the panel cannot pass it
 * as a prop through the three hosts between them. A context carries it across
 * instead; absent ⇒ the page draws no messages section, as in the dev harness.
 */
import { createContext, type ReactNode } from 'react';

export const StoryMessagesSlot = createContext<ReactNode>(null);
