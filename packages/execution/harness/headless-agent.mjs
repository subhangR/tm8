#!/usr/bin/env node
// Deterministic stand-in for Claude's stream-json protocol. This is a process
// harness (not a mock): adapter tests exercise real pipes, signals, exits and
// argv construction without spending subscription tokens.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const nativeSessionId = valueAfter('--session-id') ?? valueAfter('--resume');

if (process.env.TM8_FAKE_ARGV_FILE) {
  writeFileSync(
    process.env.TM8_FAKE_ARGV_FILE,
    JSON.stringify({
      args,
      home: process.env.HOME ?? null,
      marker: process.env.TM8_FAKE_MARKER ?? null,
    }),
  );
}

if (process.env.TM8_FAKE_HEADLESS_MODE === 'boot-crash') {
  process.stderr.write('synthetic boot failure\n');
  process.exit(23);
}

if (process.env.TM8_FAKE_HEADLESS_MODE === 'idle-crash') {
  // AFTER boot, never during it — that ordering IS the subject of the case this
  // mode exists for ("reports an IDLE process death"). The delay is therefore
  // coupled to the adapter's boot-settlement window, and the caller must set
  // both together: a crash that lands INSIDE the window is a boot failure,
  // `startThread` rejects, and the exit callback under test never fires at all.
  // 180 ms stays the default only because it is what this file has always used.
  setTimeout(() => process.exit(19), Number(process.env.TM8_FAKE_IDLE_CRASH_MS ?? 180));
}

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
let hanging = false;

// Recorded stream shapes, keyed by turn text: `{ "<text>": [event, ...] }`.
// A matching turn replays its events verbatim after `init` (see test/fixtures).
const fixture = process.env.TM8_FAKE_STREAM_FIXTURE
  ? JSON.parse(readFileSync(process.env.TM8_FAKE_STREAM_FIXTURE, 'utf8'))
  : {};

// Real Claude's `modelUsage` and `total_cost_usd` are RUNNING TOTALS for the
// process (measured, 2.1.280), and a `--resume`d process starts from the
// session's earlier totals. TM8_FAKE_RESUMED_TOTALS seeds that restore.
const running = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cost: 0,
  ...(process.env.TM8_FAKE_RESUMED_TOTALS ? JSON.parse(process.env.TM8_FAKE_RESUMED_TOTALS) : {}),
};
const spend = (turnUsage, cost) => {
  running.inputTokens += turnUsage.inputTokens ?? 0;
  running.outputTokens += turnUsage.outputTokens ?? 0;
  running.cacheCreationInputTokens += turnUsage.cacheCreationInputTokens ?? 0;
  running.cacheReadInputTokens += turnUsage.cacheReadInputTokens ?? 0;
  running.cost = Math.round((running.cost + cost) * 1e9) / 1e9;
};
const modelUsage = () => ({
  'fake-model': {
    inputTokens: running.inputTokens,
    outputTokens: running.outputTokens,
    cacheCreationInputTokens: running.cacheCreationInputTokens,
    cacheReadInputTokens: running.cacheReadInputTokens,
    costUSD: 999,
  },
});

process.on('SIGINT', () => {
  if (!hanging) {
    process.exit(0);
    return;
  }
  hanging = false;
  spend({ inputTokens: 532, outputTokens: 17 }, 0.000617);
  send({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'interrupt-tool',
          content: 'User rejected tool use',
          is_error: true,
        },
      ],
    },
  });
  send({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Request interrupted by user',
    terminal_reason: 'aborted_streaming',
    // The misleading abort shape: top-level usage zeroed, running totals real.
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: modelUsage(),
    total_cost_usd: running.cost,
  });
  // Real Claude drains for a short period after its terminal result, during
  // which stdin can misleadingly accept a write, then exits cleanly.
  setTimeout(() => process.exit(0), 150);
});

input.on('line', (line) => {
  turn += 1;
  const envelope = JSON.parse(line);
  const text = envelope?.message?.content;
  send({
    type: 'system',
    subtype: 'init',
    session_id: text === 'session-mismatch' ? '00000000-0000-4000-8000-000000000000' : nativeSessionId,
  });

  if (Object.hasOwn(fixture, text)) {
    for (const event of fixture[text]) send(event);
    return;
  }

  if (text === 'crash') {
    setTimeout(() => process.exit(7), 5);
    return;
  }
  if (text === 'invalid-json') {
    process.stdout.write('this is not json\n');
    return;
  }
  if (text === 'hang') {
    hanging = true;
    send({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'interrupt-tool',
            name: 'mcp__tm8__slow_read',
            input: { entityId: 'probe-1' },
          },
        ],
      },
    });
    return;
  }

  if (text === 'tool') {
    send({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'I should inspect the graph.' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'mcp__tm8__tm8_read',
            input: { entityId: 'entity-1' },
          },
        ],
      },
    });
    send({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: { title: 'Runtime task' },
            is_error: false,
          },
        ],
      },
    });
    send({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The graph answered.' }] },
    });
  } else {
    send({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `echo:${String(text)}:${String(turn)}` }] },
    });
  }

  if (text === 'failed') {
    spend({ inputTokens: 3, outputTokens: 1 }, 0);
    send({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'synthetic provider failure',
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'fake-model': {
          inputTokens: running.inputTokens,
          outputTokens: running.outputTokens,
        },
      },
    });
    return;
  }

  // Every other turn spends the same, so a test can tell a per-turn figure
  // (always these) from a running total (these times the turn count).
  const turnUsage = { inputTokens: 11, outputTokens: 5, cacheCreationInputTokens: 2, cacheReadInputTokens: 7 };
  spend(turnUsage, text === 'cost-only' ? 0.25 : 0.01);
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: {
      input_tokens: turnUsage.inputTokens,
      output_tokens: turnUsage.outputTokens,
      cache_creation_input_tokens: turnUsage.cacheCreationInputTokens,
      cache_read_input_tokens: turnUsage.cacheReadInputTokens,
    },
    modelUsage: modelUsage(),
  };
  if (text !== 'no-cost') result.total_cost_usd = running.cost;
  if (text === 'cost-only') delete result.modelUsage;
  send(result);
});
