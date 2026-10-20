import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseClaudeStream, parseCodexEvents } from '../src/llm/agents.ts';

// Shapes captured from the real CLIs (claude --output-format stream-json, codex exec --json).
describe('usage parsing', () => {
  it('reads Claude turns, tool calls, tokens and cost', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'hmm' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput' }] } }),
      'not json',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 5,
        total_cost_usd: 0.0044,
        structured_output: { ok: true },
        usage: { input_tokens: 10, cache_creation_input_tokens: 19389, cache_read_input_tokens: 28247, output_tokens: 435 },
      }),
    ].join('\n');
    const { result, usage } = parseClaudeStream(stdout);
    assert.deepEqual(result?.structured_output, { ok: true });
    assert.deepEqual(usage, { turns: 5, toolCalls: 2, inputTokens: 47646, cachedInputTokens: 28247, outputTokens: 435, costUsd: 0.0044 });
  });

  it('reads Codex commands and tokens', () => {
    const stdout = [
      { type: 'thread.started' },
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg foo' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'sed -n 1,20p a.js' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
      { type: 'turn.completed', usage: { input_tokens: 31511, cached_input_tokens: 27776, output_tokens: 73, reasoning_output_tokens: 20 } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const { lastMessage, usage } = parseCodexEvents(stdout);
    assert.equal(lastMessage, '{"ok":true}');
    assert.deepEqual(usage, { turns: null, toolCalls: 2, inputTokens: 31511, cachedInputTokens: 27776, outputTokens: 93, costUsd: null });
  });

  it('copes with no usage at all', () => {
    assert.equal(parseCodexEvents('').usage.inputTokens, null);
    assert.equal(parseClaudeStream('').result, null);
  });
});
