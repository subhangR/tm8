/**
 * THE MESSAGES DOOR, for a phone page whose body owns the whole screen.
 *
 * Task, doc and session pages get the Messages section below the body
 * (CONTRACT §5 ruling 8). The session page is a terminal down to its composer
 * dock, so a section "below the body" sits under the dock, off a short screen.
 * That page draws a door in its own surface row instead: the thread's count,
 * and a press that opens the same Discussion sheet "View all" opens.
 * Provided by `EntityView` beside the section it replaces; `null` elsewhere.
 */
import { createContext, useContext } from 'react';

export interface MessagesDoor {
  readonly count: number;
  readonly open: () => void;
}

const MessagesDoorContext = createContext<MessagesDoor | null>(null);

export const MessagesDoorProvider = MessagesDoorContext.Provider;

export function useMessagesDoor(): MessagesDoor | null {
  return useContext(MessagesDoorContext);
}
