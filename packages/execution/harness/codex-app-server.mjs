// Deterministic pinned-v2 process fixture; no inference or tool execution.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let seq = 0,
  active = null,
  total = 0;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const notify = (method, params) => send({ method, params });
const result = (id, value) => send({ id, result: value });
const native = 'native-codex/opaque:returned';
const turn = (id, status, items = []) => ({
  id,
  status,
  items,
  itemsView: { type: 'full' },
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (process.env.TM8_FAKE_CODEX_RECORD)
    appendFileSync(process.env.TM8_FAKE_CODEX_RECORD, line + '\n');
  if (frame.method === 'initialize')
    result(frame.id, {
      userAgent: process.env.TM8_FAKE_CODEX_VERSION ?? 'codex/0.161.0',
      codexHome: '/private',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
  else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
    if (frame.method === 'thread/resume' && process.env.TM8_FAKE_CODEX_RESUME === 'missing')
      send({ id: frame.id, error: { code: -32000, message: 'missing' } });
    else
      result(frame.id, {
        thread: {
          id:
            frame.method === 'thread/resume' && process.env.TM8_FAKE_CODEX_RESUME !== 'mismatch'
              ? frame.params.threadId
              : native,
        },
        model: frame.params.model,
        modelProvider: frame.params.modelProvider,
        reasoningEffort: frame.params.config?.model_reasoning_effort ?? null,
      });
    if (process.env.TM8_FAKE_CODEX_IDLE_EXIT) setTimeout(() => process.exit(7), 100);
  } else if (frame.method === 'turn/start') {
    const text = frame.params.input[0].text,
      id = 'codex-turn-' + ++seq,
      params = { threadId: native, turnId: id };
    active = { id, text };
    // Notifications deliberately precede the dispatch response.
    notify('turn/started', { threadId: native, turn: turn(id, 'inProgress') });
    if (text === 'hang' || text === 'cancel-success') {
      notify('item/started', {
        ...params,
        item: {
          type: 'commandExecution',
          id: 'shell-1',
          command: 'inert',
          cwd: '/tmp',
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
        },
      });
      result(frame.id, { turn: turn(id, 'inProgress') });
      return;
    }
    if (text === 'crash') {
      notify('item/agentMessage/delta', { ...params, itemId: 'partial', delta: 'partial' });
      process.exit(9);
    }
    if (text === 'bad-frame') {
      process.stdout.write('broken json\n');
      return;
    }
    if (text === 'timeout') return;
    const item = {
      type: 'agentMessage',
      id: 'answer',
      text: 'Hello world!',
      phase: 'final_answer',
    };
    notify('item/agentMessage/delta', { ...params, itemId: 'answer', delta: 'Hello ' });
    notify('item/agentMessage/delta', { ...params, itemId: 'answer', delta: 'world' });
    notify('error', { ...params, error: { message: 'transient' }, willRetry: true });
    const tool = {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'tm8',
      tool: 'read',
      arguments: { id: 'x' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'inert result' }] },
      error: null,
    };
    notify('item/completed', { ...params, item: tool });
    notify('item/completed', { ...params, item: tool });
    total += 100;
    const usage = {
      total: {
        inputTokens: total,
        outputTokens: seq * 10,
        cachedInputTokens: seq * 20,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: seq * 3,
        totalTokens: total + seq * 10,
      },
      last: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      },
      modelContextWindow: 200000,
    };
    notify('thread/tokenUsage/updated', { ...params, tokenUsage: usage });
    notify('thread/tokenUsage/updated', { ...params, tokenUsage: usage });
    send({
      id: 900 + seq,
      method: 'item/commandExecution/requestApproval',
      params: { ...params, itemId: 'req' },
    });
    notify('item/completed', { ...params, item });
    notify('turn/completed', {
      threadId: native,
      turn: turn(id, text === 'failed' ? 'failed' : 'completed', [tool, item]),
    });
    result(frame.id, { turn: turn(id, 'inProgress') });
    active = null;
  } else if (frame.method === 'turn/interrupt') {
    result(frame.id, {});
    const saved = active;
    setTimeout(() => {
      if (saved)
        notify('turn/completed', {
          threadId: native,
          turn: turn(saved.id, saved.text === 'cancel-success' ? 'completed' : 'interrupted'),
        });
      active = null;
    }, 20);
  }
});
lines.on('close', () => process.exit(0));
