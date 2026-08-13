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
const nativeSessionId = valueAfter('--session-id');

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
    send({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'turn-started' }] },
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
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    return;
  }

  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: {
      input_tokens: 11,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 7,
    },
  };
  if (text !== 'no-cost') result.total_cost_usd = 0;
  send(result);
});
