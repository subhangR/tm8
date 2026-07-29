/**
 * THE GATE'S CONTEXT — a LEAF module, and it has to be one.
 *
 * This started life inside `AuthGate.tsx` and produced a cycle the first time
 * the gate suite ran: `AuthGate` imports `AuthFlow`, `AuthFlow` imports the
 * frames, and the frames import `useAuthActions` back from `AuthGate`. Under
 * that cycle the frames evaluated before `AuthGate`'s exports existed, so
 * every frame component resolved to `undefined` and React reported "Element
 * type is invalid" twenty-four times with no mention of a cycle. The symptom
 * names the consumer; the cause is always the import graph.
 *
 * So the context lives here, imports nothing from either side, and both ends
 * depend on it instead of on each other. Keep it that way: adding an import of
 * `AuthFlow` or `AuthGate` to this file re-creates the cycle.
 *
 * WHY THE CONTEXT IS THE HONESTY MECHANISM. Frames read their executors from
 * here. Inside the gate the value is real and the verbs are live; on the
 * review board there is no provider, the value is `null`, and the identical
 * component renders disabled-with-reason. A frame therefore CANNOT render an
 * enabled verb it has no executor for — the enabled branch requires a value
 * only the gate supplies. The law is structural rather than remembered.
 */
import { createContext, useContext } from 'react';
import type { AuthSessionState } from './useAuthSession';

/** The subset of the session the frames dispatch through. */
export type AuthActions = Pick<
  AuthSessionState,
  | 'createAccount'
  | 'signIn'
  | 'signOut'
  | 'failure'
  | 'busy'
  | 'clearFailure'
  | 'account'
  | 'accounts'
>;

export const AuthActionsContext = createContext<AuthActions | null>(null);
export const AuthSessionContext = createContext<AuthSessionState | null>(null);

/**
 * Frames call this. `null` means "rendered outside a gate" — not an
 * oversight, the discriminator. See the docblock above.
 */
export function useAuthActions(): AuthActions | null {
  return useContext(AuthActionsContext);
}

/**
 * The host's view of the session. THROWS outside a gate rather than returning
 * a hollow object: a menu whose sign-out silently did nothing is the
 * enabled-inert defect this package already ripped out once.
 */
export function useGateSession(): AuthSessionState {
  const value = useContext(AuthSessionContext);
  if (!value) {
    throw new Error(
      'useGateSession() was called outside <AuthGate>. Wrap the app in AuthGate, or use the exported signOut() if you are outside its React tree.',
    );
  }
  return value;
}
