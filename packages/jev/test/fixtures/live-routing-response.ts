// RECORDED FROM THE LIVE API. Do not hand-edit.
//
// One verbatim jev-1.13.0 response, captured 2026-09-22 by asking
// ROUTING_QUESTIONS about a real tm8 task. It exists because every test written
// before this call invented its own response shape, and the invented shape was
// wrong: the wire names the mass `probabilities`, not `distribution`. A fixture
// that agrees with the code proves nothing; this one disagrees with what the
// code used to assume, which is the point.
//
// The `legend` on scores and the `type` on every answer are also real, and also
// absent from every hand-written fixture.

import type { JevResponse } from '../../src/primitives.js';

export const LIVE_ROUTING_RESPONSE = {
  "model": "jev-1.13.0",
  "answers": {
    "work_kind": {
      "type": "choice",
      "choice": "implement",
      "confidence": 0.92,
      "probabilities": {
        "design": 0.02,
        "coordinate": 0.03,
        "review": 0.01,
        "unclear": 0,
        "implement": 0.93,
        "investigate": 0,
        "operate": 0
      }
    },
    "reasoning_depth": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.69,
      "legend": {
        "0": "Mechanical: the steps are fully written out; following them is the whole job.",
        "1": "Routine: a known pattern applied to a named place; the agent decides details, not approach.",
        "2": "Analytical: the agent must work out the cause or the approach itself from evidence it gathers.",
        "3": "Novel design: the agent must invent an approach and defend trade-offs nobody has settled yet."
      },
      "probabilities": {
        "0": 0,
        "1": 0.15,
        "2": 0.7,
        "3": 0.15
      }
    },
    "context_breadth": {
      "type": "score",
      "score": 1.95,
      "confidence": 0.82,
      "legend": {
        "0": "One file or one named diff.",
        "1": "A handful of files inside one package.",
        "2": "Several packages, or a whole subsystem and its tests.",
        "3": "The whole repository, or a long transcript history, held at once."
      },
      "probabilities": {
        "0": 0.01,
        "1": 0.09,
        "2": 0.83,
        "3": 0.07
      }
    },
    "blast_radius": {
      "type": "score",
      "score": 1.64,
      "confidence": 0.64,
      "legend": {
        "0": "Local and reversible: a bad edit in a branch nobody has merged.",
        "1": "Visible but recoverable: a wrong review, a failing CI run, a reverted commit.",
        "2": "Production-affecting: a live deploy, a migration, a credential or auth change.",
        "3": "Irreversible: data loss, a leaked secret, or a published artifact that cannot be withdrawn."
      },
      "probabilities": {
        "0": 0.05,
        "1": 0.26,
        "2": 0.69,
        "3": 0
      }
    },
    "needs_long_context": {
      "type": "noul",
      "noul": 0.12
    },
    "spec_complete": {
      "type": "noul",
      "noul": 0.26
    },
    "human_named_model": {
      "type": "noul",
      "noul": 0.07
    },
    "harness_fit": {
      "type": "choice",
      "choice": "claude_code",
      "confidence": 0.29,
      "probabilities": {
        "claude_code": 0.53,
        "either": 0.11,
        "codex": 0.36
      }
    }
  },
  "usage": {
    "input_tokens": 1289,
    "output_tokens": 213
  }
} as unknown as JevResponse;
