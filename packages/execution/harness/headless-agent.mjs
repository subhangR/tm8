#!/usr/bin/env node
// Deterministic stand-in for Claude's stream-json protocol. This is a process
// harness (not a mock): adapter tests exercise real pipes, signals, exits and
// argv construction without spending subscription tokens.

import { writeFileSync } from 'node:fs';
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
  setTimeout(() => process.exit(19), 180);
}

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
let hanging = false;

process.on('SIGINT', () => {
  if (!hanging) {
    process.exit(0);
    return;
  }
  hanging = false;
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
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      'fake-model': {
        inputTokens: 532,
        outputTokens: 17,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUSD: 999,
      },
    },
    total_cost_usd: 0.000617,
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
    send({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'synthetic provider failure',
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'fake-model': {
          inputTokens: 3,
          outputTokens: 1,
        },
      },
    });
    return;
  }

  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    // These zeroes reproduce the misleading top-level abort shape. The
    // adapter must take tokens from modelUsage and cost from total_cost_usd.
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      'fake-model': {
        inputTokens: 11,
        outputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 7,
        costUSD: 999,
      },
    },
  };
  if (text !== 'no-cost') result.total_cost_usd = 0;
  if (text === 'cost-only') {
    delete result.modelUsage;
    result.total_cost_usd = 0.25;
  }
  send(result);
});
