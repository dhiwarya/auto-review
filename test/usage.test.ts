import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeSteps, codexStep, parseClaudeStream, parseCodexEvents, shellCommand } from '../src/llm/agents.ts';

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

  it('turns Codex events into a live log: a command starts, then finishes with its output', () => {
    // Captured from codex exec --json in the container.
    const started = { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'cat a.txt'", aggregated_output: '', exit_code: null, status: 'in_progress' } };
    const done = { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'cat a.txt'", aggregated_output: 'hello\n', exit_code: 0, status: 'completed' } };
    assert.deepEqual(codexStep(started), { ref: 'item_1', kind: 'command', title: 'cat a.txt', detail: null, status: 'running' });
    assert.deepEqual(codexStep(done), { ref: 'item_1', kind: 'command', title: 'cat a.txt', detail: 'hello\n', status: 'ok' });
    assert.equal(codexStep({ ...done, item: { ...done.item, exit_code: 2 } })?.status, 'failed');
    assert.equal(codexStep({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run `cat a.txt` once.\n' } })?.kind, 'message');
    assert.equal(codexStep({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '{"findings":[]}' } })?.kind, 'output');
    const flagged = codexStep({ type: 'turn.failed', error: { message: 'This content was flagged for possible cybersecurity risk.' } });
    assert.equal(flagged?.kind, 'error');
    assert.equal(flagged?.status, 'failed');
    assert.equal(codexStep({ type: 'turn.completed', usage: {} }), null);
    assert.equal(shellCommand("/bin/bash -lc 'rg -n '\\''foo'\\'' src'"), "rg -n 'foo' src");
  });

  it("turns Claude's stream into a live log, pairing each tool call with its result", () => {
    // Captured from claude -p --output-format stream-json --verbose.
    const call = claudeSteps({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.txt' } }] } });
    assert.deepEqual(call, [{ ref: 'toolu_1', kind: 'tool', title: 'Read /repo/a.txt', status: 'running' }]);
    const result = claudeSteps({ type: 'user', message: { content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: '1\thello\n2\t' }] } });
    assert.deepEqual(result, [{ ref: 'toolu_1', kind: 'tool', detail: '1\thello\n2\t', status: 'ok' }]);
    const answer = claudeSteps({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'StructuredOutput', input: { ok: true } }, { type: 'text', text: 'Done.' }] } });
    assert.deepEqual(answer.map((s) => s.kind), ['output', 'message']);
    assert.deepEqual(claudeSteps({ type: 'rate_limit_event' }), []);
  });

  it('copes with no usage at all', () => {
    assert.equal(parseCodexEvents('').usage.inputTokens, null);
    assert.equal(parseClaudeStream('').result, null);
  });
});
