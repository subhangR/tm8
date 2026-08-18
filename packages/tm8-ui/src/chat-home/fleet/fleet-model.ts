/**
 * THE FLEET FOLD — what this conversation ORCHESTRATED, read out of the
 * transcript it already has.
 *
 * The Cockpit's premise is that chat is the human's orchestrating main thread:
 * it does not run parallel work itself (Task/native subagents are deliberately
 * absent from its tool surface), it hands work to real tm8 worker sessions
 * through `tm8_delegate`. Those sessions and the tasks they run are entities,
 * they are already named in the thread's tool-call payloads, and until now
 * nothing rendered them as a fleet. This module is the fold that finds them.
 *
 * NO NEW SOURCE OF TRUTH (the whole point). The seeds come from exactly the
 * walk the transcript chips and the entity graph already use —
 * `projectTurnParts` + `extractEntityRefs` — so the fleet can never name an
 * entity the chips do not show, and no server change, no schema column and no
 * second feed reader is involved. If a delegation is invisible here it is
 * invisible in the chips too, and that is one bug, not two.
 *
 * ORIGIN IS COMPUTED FROM THE CALL, NOT GUESSED FROM THE ENTITY. A fleet row
 * has to answer "did this conversation START this, or merely mention it?", and
 * the entity itself cannot answer that — a running session looks identical
 * whoever spawned it. So origin is derived from the tool call that named the
 * id, along two axes that are both cheap and honest:
 *
 *   - WHICH CALL. `tm8_delegate` carries the operation in its own args
 *     (`execution.spawn` | `execution.dispatch` | `execution.resume` |
 *     `execution.terminate` — see @tm8/mcp tools.ts DELEGATE_GUIDES), so the
 *     verb is read, never inferred from the tool name.
 *   - WHICH SIDE OF THE CALL. An id in the RESULT of a spawn is the thing the
 *     call PRODUCED; an id in its ARGS is the subject it was HANDED. That
 *     split is what separates "chat spawned this session" from "chat delegated
 *     this task", with no kind resolution required — which matters because
 *     kind arrives late (or never, for an unresolvable id) and a fold that
 *     needed it would have nothing to show on first paint.
 *
 * ORIGIN NEVER DOWNGRADES, and never upgrades either: the STRONGEST origin
 * seen wins (`ORIGIN_RANK`), because a session that was spawned here and later
 * merely mentioned is still a session this conversation spawned. Lifecycle
 * verbs are recorded ALONGSIDE rather than overwriting — a terminated session
 * is still one we spawned, and the row wants to say both.
 *
 * CONSERVATIVE, in the direction that understates. An unrecognised delegate
 * operation, a call whose args we cannot parse, a bare id under a key we do
 * not know: all fall to `referenced`. A false "chat spawned this" is a lie
 * about authorship; a false "referenced" is only an understatement, and the
 * row is still on screen either way.
 *
 * PURE. No React, no seam, no clock — the fold is a function of the turns, so
 * it is testable without a host and cheap to re-run under streaming.
 */
import { extractEntityRefs } from '../entity-refs';
import { projectTurnParts } from '../turn-model';
import type { ChatTurn } from '../types';

/**
 * How this conversation came to name an entity, strongest first.
 *
 * `spawned` / `dispatched` — a `tm8_delegate` call PRODUCED this id.
 *   The two are kept apart because they are different acts: spawn names the
 *   teammate, dispatch lets the resident dispatcher choose one, and a fleet
 *   view that flattened them would lose the only record of which happened.
 * `delegated` — this id was HANDED to a delegate call (the task a worker was
 *   pointed at, the session a resume/terminate acted on).
 * `created` — a write-shaped graph call produced it (a task the chat made).
 * `referenced` — the conversation named it. Nothing more is claimed.
 */
export type FleetOrigin = 'spawned' | 'dispatched' | 'delegated' | 'created' | 'referenced';

const ORIGIN_RANK: Record<FleetOrigin, number> = {
  spawned: 4,
  dispatched: 3,
  delegated: 2,
  created: 1,
  referenced: 0,
};

/** Lifecycle verbs the thread aimed at an entity, recorded but never used to
 *  overwrite origin — "spawned, then terminated" is two facts, not one. */
export type FleetLifecycleVerb = 'resumed' | 'terminated';

export interface FleetRef {
  id: string;
  /** From the payload, when it carried one. Usually absent until resolved. */
  kind?: string | undefined;
  title?: string | undefined;
  origin: FleetOrigin;
  /** Every lifecycle verb this thread aimed at the id, first-seen order. */
  lifecycle: readonly FleetLifecycleVerb[];
  /** True once any write-shaped call named it — the graph's own `mutated`. */
  mutated: boolean;
}

/**
 * The delegate operations, as the MCP group actually spells them. Kept as a
 * literal map rather than a regex on the tool name because the tool is one
 * name (`tm8_delegate`) for four verbs — the name tells you nothing and the
 * operation tells you everything.
 */
const DELEGATE_PRODUCES: Readonly<Record<string, FleetOrigin>> = {
  'execution.spawn': 'spawned',
  'execution.dispatch': 'dispatched',
};
const DELEGATE_LIFECYCLE: Readonly<Record<string, FleetLifecycleVerb>> = {
  'execution.resume': 'resumed',
  'execution.terminate': 'terminated',
};

/**
 * Verbs that name a mutation — the SAME vocabulary the graph's seed fold uses
 * (`graph-seeds.ts`), so a seed the graph calls mutated and the fleet calls
 * read can never disagree.
 *
 * BUT IT IS MATCHED AGAINST THE OPERATION FIRST, AND THAT IS A FIX, NOT A
 * STYLE CHOICE. `graph-seeds.ts` matches this regex against the TOOL NAME
 * only, and chat's entire write path is two GROUP tools — `tm8_act` and
 * `tm8_delegate` — whose names contain no verb at all ("act" and "delegate"
 * are both absent from the list; "dispatch" is in it, but the tool is not
 * called `tm8_dispatch`). So on Chat Home every graph mutation the agent makes
 * currently folds as a READ, and the induced graph's "edited here" marker is
 * dead on the one surface it was built for. Verified against the shipped
 * `foldGraphSeeds`, not inferred.
 *
 * The group schema puts the real verb in `args.operation` (`entities.create`,
 * `execution.spawn`, …), so that is what gets classified when it is there. The
 * tool name remains the fallback for direct tools (`Edit`, `Bash`, the
 * `tm8_*` direct set), whose names DO carry their verb.
 */
const WRITE_VERB =
  /(create|update|delete|remove|patch|send|post|complete|assign|unlink|link|move|write|edit|spawn|terminate|attach|upload|cancel|start|stop|rename|archive|restore|grant|revoke|dispatch|launch|set_|_set\b)/i;

/** Strip any MCP server prefix: `mcp__tm8__tm8_delegate` → `tm8_delegate`. */
function bareToolName(name: string): string {
  return name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
}

/** An unrecognised verb counts as a READ, in both branches: a false "edited
 *  here" is a lie about authorship, while a false "read" is an understatement
 *  the row survives. */
function isWriteCall(name: string, operation: string | null): boolean {
  if (operation !== null) return WRITE_VERB.test(operation);
  return WRITE_VERB.test(bareToolName(name));
}

function isDelegateTool(name: string): boolean {
  return bareToolName(name) === 'tm8_delegate';
}

/**
 * The `operation` a group tool was called with. The MCP group schema puts it
 * at the top level of args (`{operation, params, query, body}`), but a call
 * that never settled has `args: undefined` and a malformed one can have
 * anything at all — so this reads defensively and returns null rather than
 * throwing a render away.
 */
function operationOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const operation = (args as { operation?: unknown }).operation;
  return typeof operation === 'string' ? operation : null;
}

export interface FleetFold {
  /** Every distinct entity the thread named, first-reference order, nothing
   *  discarded — the counts a facet renders are computed over THIS. */
  refs: readonly FleetRef[];
  /** The first `limit` refs — the only set a pane draws or reads details for. */
  drawn: readonly FleetRef[];
  /** `refs.length - drawn.length`. Rendered, never swallowed: a pane that
   *  silently truncated would report "3 sessions" about a thread with 40. */
  overflow: number;
}

/** The draw cap. Matches the entity graph's `MAX_GRAPH_SEEDS` on purpose —
 *  the two surfaces fold the same thread and a different cap would make them
 *  disagree about how much there is. */
export const MAX_FLEET_REFS = 64;

/**
 * Per-turn extraction cache, keyed on the turn OBJECT. `mergeChatTurnFrame`
 * mints a new object for the turn a delta touched and leaves every other turn
 * referentially identical, so identity is exactly the right key and a
 * streaming thread re-walks one turn per frame rather than all of them.
 */
const perTurn = new WeakMap<ChatTurn, readonly FleetRef[]>();

function refsOfTurn(turn: ChatTurn): readonly FleetRef[] {
  const cached = perTurn.get(turn);
  if (cached) return cached;

  const out: FleetRef[] = [];
  for (const part of projectTurnParts(turn.parts)) {
    if (part.kind !== 'tool') continue;
    const operation = operationOf(part.args);
    const mutated = isWriteCall(part.name, operation);

    if (isDelegateTool(part.name)) {
      const produces = operation ? DELEGATE_PRODUCES[operation] : undefined;
      const verb = operation ? DELEGATE_LIFECYCLE[operation] : undefined;

      /* THE SIDE SPLIT. Extracted separately so the result's ids can carry a
         different origin from the args' ids — one combined walk would collapse
         "the session we spawned" and "the task we pointed it at" into one
         indistinguishable set. */
      for (const ref of extractEntityRefs(part.result)) {
        out.push({
          id: ref.id,
          kind: ref.kind,
          title: ref.title,
          /* A delegate call with no recognised operation still produced
             SOMETHING, but we cannot say what act it was — `delegated` is the
             honest floor, never an invented `spawned`. */
          origin: produces ?? 'delegated',
          lifecycle: verb ? [verb] : [],
          mutated,
        });
      }
      for (const ref of extractEntityRefs(part.args)) {
        out.push({
          id: ref.id,
          kind: ref.kind,
          title: ref.title,
          origin: 'delegated',
          lifecycle: verb ? [verb] : [],
          mutated,
        });
      }
      continue;
    }

    for (const ref of extractEntityRefs(part.args, part.result)) {
      out.push({
        id: ref.id,
        kind: ref.kind,
        title: ref.title,
        origin: mutated ? 'created' : 'referenced',
        lifecycle: [],
        mutated,
      });
    }
  }

  perTurn.set(turn, out);
  return out;
}

/**
 * Fold a thread into its fleet.
 *
 * `suppressEntityIds` is applied AT MERGE and not at extraction, exactly as
 * the graph's seed fold does it: the own-message id set grows as the thread
 * does, and filtering inside the cached per-turn walk would invalidate settled
 * turns every time the viewer sent a message.
 */
export function foldFleet(
  turns: readonly ChatTurn[],
  suppressEntityIds?: ReadonlySet<string>,
  opts?: { limit?: number },
): FleetFold {
  const limit = opts?.limit ?? MAX_FLEET_REFS;
  const byId = new Map<string, FleetRef>();

  for (const turn of turns) {
    for (const ref of refsOfTurn(turn)) {
      if (suppressEntityIds?.has(ref.id)) continue;
      const existing = byId.get(ref.id);
      if (!existing) {
        byId.set(ref.id, { ...ref, lifecycle: [...ref.lifecycle] });
        continue;
      }
      /* Richer fields win when they finally arrive; write-ness and origin
         accumulate upward only. */
      byId.set(ref.id, {
        id: existing.id,
        kind: existing.kind ?? ref.kind,
        title: existing.title ?? ref.title,
        origin: ORIGIN_RANK[ref.origin] > ORIGIN_RANK[existing.origin] ? ref.origin : existing.origin,
        lifecycle: mergeLifecycle(existing.lifecycle, ref.lifecycle),
        mutated: existing.mutated || ref.mutated,
      });
    }
  }

  const refs = [...byId.values()];
  const drawn = refs.slice(0, limit);
  return { refs, drawn, overflow: refs.length - drawn.length };
}

function mergeLifecycle(
  a: readonly FleetLifecycleVerb[],
  b: readonly FleetLifecycleVerb[],
): readonly FleetLifecycleVerb[] {
  if (b.length === 0) return a;
  const out = [...a];
  for (const verb of b) if (!out.includes(verb)) out.push(verb);
  return out;
}

/**
 * The sentence a row's origin makes, for the row's `title=`. Short because the
 * row already shows the kind mark and the status pill; this exists so "spawned
 * from this conversation" is READABLE somewhere rather than encoded in a
 * position on screen.
 */
export function originSentence(ref: FleetRef): string {
  const base =
    ref.origin === 'spawned'
      ? 'Spawned from this conversation'
      : ref.origin === 'dispatched'
        ? 'Dispatched from this conversation — the dispatcher chose the teammate'
        : ref.origin === 'delegated'
          ? 'Handed to a worker from this conversation'
          : ref.origin === 'created'
            ? 'Created by this conversation'
            : 'Referenced by this conversation';
  if (ref.lifecycle.length === 0) return base;
  return `${base} · ${ref.lifecycle.join(' · ')} here`;
}
