// @tm8/execution — Codex native-session capture (the resume feature's only
// genuinely new machinery; everything else is plumbing).
//
// Codex cannot be pre-seeded with a session id the way Claude can
// (`--session-id`): its CLI mints its own rollout id at boot and writes the
// conversation to `~/.codex/sessions/**/*.jsonl`. So tm8 recovers the id the
// way maestro's LogDigestService proved out:
//
//   1. Every Codex spawn's FIRST USER TURN carries a
//      `<tm8_session_id>…</tm8_session_id>` marker (appended by SpawnService),
//      because env vars never appear in a rollout and the system prompt travels
//      on `-c developer_instructions=`, not as a message.
//   2. A rollout belongs to a tm8 session iff that marker appears in one of its
//      USER messages. Ownership is NEVER inferred from a raw substring match
//      across the whole file: coordinator tool output routinely mentions other
//      sessions' ids inside unrelated rollouts (maestro measured exactly this
//      false-positive class).
//   3. The native id is the `session_meta` record's `payload.id` at the head of
//      the owning file.
//
// Fail-closed by construction: no candidate → null → the caller refuses the
// resume. There is deliberately no `--last` fallback anywhere downstream.

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** How much of a rollout head is read. The marker rides the END of the first
 *  user turn (the task prompt), so the window must hold session_meta + that
 *  whole turn; 256 KiB is far beyond any composed task prompt. */
const HEAD_WINDOW_BYTES = 256 * 1024;

export interface CodexRolloutIdentity {
  nativeSessionId: string;
  cwd: string | null;
  timestamp: string | null;
}

/** A located rollout: its identity plus the file it was proven from. Resume
 *  needs only the id; the transcript reader needs the path, and re-running the
 *  scan to recover it would be the same walk twice. */
export interface CodexRollout extends CodexRolloutIdentity {
  path: string;
}

/**
 * Parse one rollout head: the `session_meta` identity plus proof of ownership
 * by `tm8SessionId`. Returns null unless BOTH are present.
 *
 * Tolerant of a truncated final line (the read window cuts mid-record) and of
 * unknown record shapes — anything unparseable is skipped, never fatal.
 */
export function extractCodexRolloutIdentity(
  head: string,
  tm8SessionId: string,
): CodexRolloutIdentity | null {
  const marker = `<tm8_session_id>${tm8SessionId}</tm8_session_id>`;
  let meta: CodexRolloutIdentity | null = null;
  let owned = false;

  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as { type?: unknown; timestamp?: unknown; payload?: unknown };
    const payload = record.payload as
      | { id?: unknown; cwd?: unknown; timestamp?: unknown; role?: unknown; type?: unknown }
      | undefined;

    if (record.type === 'session_meta' && typeof payload?.id === 'string' && payload.id.trim() !== '') {
      meta = {
        nativeSessionId: payload.id.trim(),
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        timestamp:
          typeof record.timestamp === 'string'
            ? record.timestamp
            : typeof payload.timestamp === 'string'
              ? payload.timestamp
              : null,
      };
    } else if (payload !== undefined && (payload.role === 'user' || payload.type === 'user_message')) {
      // Ownership ONLY from a user message — see the header for why.
      if (JSON.stringify(payload).includes(marker)) owned = true;
    }
    if (meta !== null && owned) break;
  }
  return meta !== null && owned ? meta : null;
}

/**
 * Locate the rollout belonging to `tm8SessionId` under `<home>/.codex/sessions`
 * and return its native session id, or null when none can be proven.
 *
 * When several rollouts carry the marker (a session resumed before — each
 * `codex resume` writes a NEW rollout continuing the same conversation), the
 * candidate whose recorded cwd matches wins, then the newest timestamp: the
 * newest continuation is the one holding the full history.
 */
export async function resolveCodexNativeSessionId(opts: {
  home: string;
  tm8SessionId: string;
  cwd?: string | null;
}): Promise<string | null> {
  return (await resolveCodexRollout(opts))?.nativeSessionId ?? null;
}

/**
 * The scan behind {@link resolveCodexNativeSessionId}, returning the winning
 * rollout WITH its path.
 *
 * Separate public entry point rather than a widened return type on the resume
 * helper: resume must keep answering `string | null`, because a caller that
 * can accidentally treat an object as truthy is exactly how a fail-closed
 * refusal turns into a resume of the wrong conversation.
 */
export async function resolveCodexRollout(opts: {
  home: string;
  tm8SessionId: string;
  cwd?: string | null;
}): Promise<CodexRollout | null> {
  const root = join(opts.home, '.codex', 'sessions');
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return null; // no ~/.codex/sessions — nothing to prove, refuse upstream
  }

  const candidates: CodexRollout[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(root, entry);
    const head = await readHead(path, HEAD_WINDOW_BYTES);
    if (head === null) continue;
    const identity = extractCodexRolloutIdentity(head, opts.tm8SessionId);
    if (identity !== null) candidates.push({ ...identity, path });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aCwd = opts.cwd != null && a.cwd === opts.cwd ? 1 : 0;
    const bCwd = opts.cwd != null && b.cwd === opts.cwd ? 1 : 0;
    if (aCwd !== bCwd) return bCwd - aCwd;
    return (b.timestamp ?? '').localeCompare(a.timestamp ?? '');
  });
  return candidates[0] ?? null;
}

/** First `bytes` of a file as utf8, or null when unreadable. */
async function readHead(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
