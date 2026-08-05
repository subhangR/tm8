/**
 * The permission-gate hook bridge — the thing that actually blocks an agent
 * while a human answers in chat.
 *
 * WHAT RUNS THIS. A provider `PreToolUse` hook, as a subprocess of the agent,
 * with the hook payload on stdin. Whatever this process prints on stdout is the
 * provider's decision, and while it is alive the agent is stopped. That blocking
 * property is the entire mechanism and it was verified before this file existed:
 * a hook that slept returned after 8.01s with the agent still waiting, and its
 * `permissionDecision: "deny"` was honoured — the tool never ran and the agent
 * explained the denial in its own words.
 *
 * WHY A HOOK AND NOT KEYSTROKES. The obvious shortcut is to detect the dialog in
 * the terminal byte stream and send the answer as input. That is unsafe and
 * always will be: a TUI dialog opens with an option pre-highlighted, so a blind
 * Enter is a blind APPROVAL, and the direction of that mistake is always toward
 * granting permission nobody gave. It is worse for an unfamiliar provider, where
 * tm8 cannot know which option is highlighted. This path never writes a byte to
 * the terminal.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: EVERY FAILURE FALLS TOWARD THE TERMINAL.
 * An unreachable server, an expired window, a torn connection, a malformed
 * payload — all of them exit with NO decision, which returns the agent to its
 * own permission prompt, still sitting in the terminal where a human can answer
 * it directly. This process may cause a question to be asked twice. It must
 * never cause one to be answered without being asked.
 */

export interface PermissionGateEnv {
  TM8_BASE_URL?: string;
  TM8_SESSION_ID?: string;
  TM8_AGENT_TOKEN?: string;
  TM8_AGENT_TOOL?: string;
}

/** The subset of a provider hook payload this bridge understands. */
export interface HookPayload {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

export type GateDecision =
  | { kind: 'allow'; reason: string | null }
  | { kind: 'deny'; reason: string | null }
  /** No decision. The agent falls back to its own prompt. */
  | { kind: 'abstain'; why: string };

/**
 * 10 minutes, matching `session_prompts.expires_at`. Longer than a coffee break,
 * shorter than a forgotten tab. The two must agree: a bridge that gave up before
 * the row expired would abstain on a question still answerable in chat, and a
 * bridge that outlived the row would block on one that can no longer be answered.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How often to ask whether the question has been answered.
 *
 * 1s is a deliberate floor rather than a tuned value: the human is the slow part
 * of this loop, and the cost of a wrong choice is asymmetric — polling faster
 * wastes requests on a person who is reading, polling slower adds dead time to
 * an agent that is already stopped. A second is under the threshold at which a
 * person notices lag and far above the rate at which this could load the node.
 */
const POLL_INTERVAL_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Render the decision as the provider expects it on stdout.
 *
 * Abstaining prints NOTHING. That is the contract: a hook that exits 0 with no
 * output leaves the provider's own permission flow untouched, which is exactly
 * the fallback every failure path in this module wants.
 */
export function renderDecision(decision: GateDecision): string {
  if (decision.kind === 'abstain') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.kind,
      permissionDecisionReason:
        decision.reason ??
        (decision.kind === 'deny' ? 'Denied from tm8 chat' : 'Approved from tm8 chat'),
    },
  });
}

interface GateDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  sleepImpl: (ms: number) => Promise<void>;
}

/**
 * Open a gate for one tool call and wait for a human.
 *
 * Injected deps rather than reaching for globals so the timing behaviour is
 * testable without a real clock or a real node — this is a loop whose whole
 * purpose is waiting, and a test that waits ten real minutes is a test nobody
 * runs.
 */
export async function runPermissionGate(
  payload: HookPayload,
  env: PermissionGateEnv,
  deps: Partial<GateDeps> = {},
  timeoutMs: number = DEFAULT_GATE_TIMEOUT_MS,
): Promise<GateDecision> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleepImpl = deps.sleepImpl ?? sleep;

  const baseUrl = env.TM8_BASE_URL;
  const sessionId = env.TM8_SESSION_ID;
  const token = env.TM8_AGENT_TOKEN;
  // Not an error worth shouting about: a session spawned before this feature, or
  // an agent a human is running by hand, simply has no gate. Abstain quietly.
  if (!baseUrl || !sessionId || !token) {
    return { kind: 'abstain', why: 'no tm8 session credential in the environment' };
  }
  const toolUseId = payload.tool_use_id;
  const toolName = payload.tool_name;
  if (!toolUseId || !toolName) {
    return { kind: 'abstain', why: 'hook payload carried no tool identity' };
  }

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  let promptId: string;
  try {
    const res = await fetchImpl(`${baseUrl}/v2/entities/${sessionId}/commands/prompt-gate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientMutationId: `gate-${toolUseId}`,
        workSessionId: sessionId,
        toolUseId,
        toolName,
        toolInput: payload.tool_input ?? {},
        agentTool: env.TM8_AGENT_TOOL ?? null,
      }),
    });
    if (!res.ok) return { kind: 'abstain', why: `open failed: HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { promptId?: string } };
    const id = body?.data?.promptId;
    if (!id) return { kind: 'abstain', why: 'open returned no promptId' };
    promptId = id;
  } catch (err) {
    // The node being unreachable must never become an allow. It becomes the
    // agent's own prompt, in the terminal, unanswered until a person gets there.
    return { kind: 'abstain', why: `open unreachable: ${String(err)}` };
  }

  const deadline = now() + timeoutMs;
  let consecutiveReadFailures = 0;
  while (now() < deadline) {
    await sleepImpl(POLL_INTERVAL_MS);
    try {
      const res = await fetchImpl(`${baseUrl}/v2/entities/${sessionId}/session-prompts`, {
        method: 'GET',
        headers,
      });
      if (!res.ok) {
        // A blip is not a decision. Keep waiting; only sustained failure abstains.
        if (++consecutiveReadFailures >= 10) {
          return { kind: 'abstain', why: `poll failing: HTTP ${res.status}` };
        }
        continue;
      }
      consecutiveReadFailures = 0;
      const body = (await res.json()) as {
        data?: { items?: Array<{ promptId: string; status: string; decisionReason: string | null }> };
      };
      const mine = body?.data?.items?.find((p) => p.promptId === promptId);
      // A prompt that vanished cannot be waited on, and must not be assumed
      // allowed. Hand it back to the terminal.
      if (!mine) return { kind: 'abstain', why: 'prompt disappeared' };
      if (mine.status === 'allowed') return { kind: 'allow', reason: mine.decisionReason };
      if (mine.status === 'denied') return { kind: 'deny', reason: mine.decisionReason };
      if (mine.status === 'expired') {
        return { kind: 'abstain', why: 'nobody answered in time' };
      }
    } catch (err) {
      if (++consecutiveReadFailures >= 10) {
        return { kind: 'abstain', why: `poll unreachable: ${String(err)}` };
      }
    }
  }
  return { kind: 'abstain', why: 'gate timed out' };
}

/** Read all of stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Entry point when this module is run as the hook command.
 *
 * ALWAYS exits 0. A non-zero exit from a hook is itself a signal to the
 * provider, and this bridge must never signal anything it did not mean — an
 * unparseable payload is a reason to stay out of the way, not to fail the tool
 * call.
 */
export async function main(): Promise<void> {
  let decision: GateDecision;
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as HookPayload;
    decision = await runPermissionGate(payload, process.env as PermissionGateEnv);
  } catch (err) {
    decision = { kind: 'abstain', why: `bridge error: ${String(err)}` };
  }
  const out = renderDecision(decision);
  if (out) process.stdout.write(out);
  process.exit(0);
}
