// Kept as a named module so callers can import the port without importing a
// vendor adapter. The actual declarations live together in `types.ts`, where
// the discriminated union can be reviewed as one contract.
export type {
  AgentRuntime,
  AgentThread,
  AgentThreadExit,
  AgentTurnInput,
  StartAgentThreadInput,
  TurnItem,
} from './types.js';
export { AgentRuntimeError } from './types.js';
