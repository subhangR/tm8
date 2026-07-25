/**
 * Simulation driver — a toggleable, scripted replay of the golden narrative,
 * expressed entirely as facade commands so every WorkspaceEvent, notification,
 * counter, staleness flip, and unblock ripple is the real mock semantics:
 *
 *   1. Mira starts typing in #v2-build (presence pulse)
 *   2. Forge posts progress in the T-104 thread
 *   3. Mira bumps the spec doc to v5 → Forge's pinned pull goes STALE on every
 *      surface at once (stale notification fires)
 *   4. Scout requests review on T-106 (mention of Subhang → inbox)
 *   5. Subhang checks off T-104's last acceptance criterion
 *   6. Subhang completes T-104 → award fires (20-point bounty to Forge) →
 *      leaderboard moves → unblock ripple clears T-105's blocked badge
 *   7. Forge announces the ship in #v2-build; presence quiets down
 *
 * Steps are resilient: each re-reads current versions before writing, and a
 * failed step is skipped rather than wedging the loop.
 */
import type { MockFacade } from './MockFacade';

export interface SimulationOptions {
  /** Milliseconds between auto-steps when running. Default 4000. */
  intervalMs?: number;
  /** Called after each executed step (UI toggles, tests). */
  onStep?: (name: string, index: number, total: number) => void;
}

interface SimStep { name: string; run: () => Promise<void> }

export class Simulation {
  private readonly steps: SimStep[];
  private index = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly onStep?: SimulationOptions['onStep'];

  constructor(private readonly facade: MockFacade, opts: SimulationOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 4000;
    this.onStep = opts.onStep;
    const ids = facade.ids;
    const versionOf = (id: string): number =>
      facade.withWorld((w) => w.summaryById(id, { allowDeleted: true }).version);

    this.steps = [
      {
        name: 'mira-typing',
        run: async () => {
          facade.withWorld((w) => w.setPresence(ids.chBuild, [ids.mira, ids.forge], [ids.mira]));
        },
      },
      {
        name: 'forge-posts-progress',
        run: async () => {
          await facade.postMessage({
            anchorId: ids.t104,
            body: 'Discussion tab virtualization is in; wiring the connections rail to live edge groups next.',
            actorId: ids.forge,
          });
        },
      },
      {
        name: 'mira-bumps-spec-to-v5',
        run: async () => {
          await facade.patchEntity(ids.docSpec, {
            expectedVersion: versionOf(ids.docSpec),
            actorId: ids.mira,
            content: {
              body: '# Collab V2 Spec (v5)\n\nNEW: channel auto-tabs are a projection of attached_to edges — non-empty kinds only, pin lives in edge props. Staleness stays two-signal (content vs discussion).',
            },
          });
        },
      },
      {
        name: 'scout-requests-review',
        run: async () => {
          await facade.postMessage({
            anchorId: ids.t106,
            body: 'Docs reader is ready for review — margin threads anchor correctly, chapter tree walks the doc hierarchy. Requesting eyes.',
            mentions: [{ entityId: ids.subhang, kind: 'member', display: 'Subhang' }],
            actorId: ids.scout,
          });
        },
      },
      {
        name: 'subhang-checks-last-criterion',
        run: async () => {
          const criteria = this.facade.withWorld((w) => {
            const detail = w.detail(ids.t104);
            return detail.content.kind === 'task' ? detail.content.acceptanceCriteria : [];
          });
          await facade.patchTask(ids.t104, {
            expectedVersion: versionOf(ids.t104),
            acceptanceCriteria: criteria.map((c) => ({ ...c, done: true, doneBy: c.done ? c.doneBy : ids.subhang })),
            actorId: ids.subhang,
          });
        },
      },
      {
        name: 'complete-t104-award-unblock',
        run: async () => {
          await facade.completeTask(ids.t104, {
            expectedVersion: versionOf(ids.t104),
            completerIds: [ids.forge],
            actorId: ids.subhang,
          });
        },
      },
      {
        name: 'forge-announces-ship',
        run: async () => {
          await facade.postMessage({
            anchorId: ids.chBuild,
            body: `T-104 shipped — entity panel is live and T-105 is unblocked. {{embed:${ids.t104}}}`,
            actorId: ids.forge,
          });
          facade.withWorld((w) => w.setPresence(ids.chBuild, [ids.forge], []));
        },
      },
    ];
  }

  get isRunning(): boolean { return this.timer != null; }
  get stepIndex(): number { return this.index; }
  get totalSteps(): number { return this.steps.length; }
  get done(): boolean { return this.index >= this.steps.length; }

  /** Execute the next scripted step; returns its name, or null when done. */
  async step(): Promise<string | null> {
    if (this.done) { this.stop(); return null; }
    const step = this.steps[this.index];
    this.index += 1;
    try {
      await step.run();
    } catch {
      // A user interaction may have raced the script (e.g. version moved on);
      // skip rather than wedge the narrative.
    }
    this.onStep?.(step.name, this.index, this.steps.length);
    if (this.done) this.stop();
    return step.name;
  }

  /** Run every remaining step back-to-back (tests, "fast-forward" toggle). */
  async runAll(): Promise<string[]> {
    const executed: string[] = [];
    while (!this.done) {
      const name = await this.step();
      if (name) executed.push(name);
    }
    return executed;
  }

  start(): void {
    if (this.timer || this.done) return;
    this.timer = setInterval(() => { void this.step(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

export function createSimulation(facade: MockFacade, opts?: SimulationOptions): Simulation {
  return new Simulation(facade, opts);
}
