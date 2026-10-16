import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgentTurnWithOutcome } from '../src/agent-loop.js'
import { abortableDelay } from '../src/abort.js'
import { ToolRegistry } from '../src/tool.js'
import {
  MAX_INTERACTIVE_TURN_STEPS,
  MAX_TURN_STEPS,
  MAX_TURN_TOOL_CALLS,
  RunBudget,
  RunBudgetLimitError,
  TURN_TIMEOUT_MS,
  turnBudgetFor,
} from '../src/run-budget.js'
import type { AgentStep } from '../src/types.js'

function stubTool(name: string, output = `${name} result`) {
  return {
    name,
    description: '',
    schema: z.object({}),
    inputSchema: {},
    async run() { return { ok: true, output } },
  }
}

describe('RunBudget', () => {
  it('counts model rounds and refuses to start one past the limit', () => {
    const budget = new RunBudget({ maxSteps: 2 }, 0, () => 0)
    assert.equal(budget.stopBeforeStep(), undefined)
    assert.equal(budget.beginStep(), 1)
    assert.equal(budget.stepCount, 1)
    assert.equal(budget.beginStep(), 2)
    assert.equal(budget.stopBeforeStep(), 'max_steps')
    assert.throws(() => budget.beginStep(), RunBudgetLimitError)
  })

  it('does not let the round limit veto tools inside the round it paid for', () => {
    const budget = new RunBudget({ maxSteps: 1, maxToolCalls: 2 }, 0, () => 0)
    budget.beginStep()
    assert.equal(budget.stopBeforeStep(), 'max_steps')
    assert.equal(budget.stopBeforeToolCall(), undefined)
    assert.equal(budget.spendToolCall(), 1)
    assert.equal(budget.spendToolCall(), 2)
    assert.equal(budget.stopBeforeToolCall(), 'max_tool_calls')
    assert.throws(() => budget.spendToolCall(), RunBudgetLimitError)
  })

  it('caps tool calls independently of model rounds', () => {
    const budget = new RunBudget({ maxSteps: 5, maxToolCalls: 2 }, 0, () => 0)
    budget.beginStep()
    assert.equal(budget.spendToolCall(), 1)
    assert.equal(budget.spendToolCall(), 2)
    assert.equal(budget.toolCallCount, 2)
    assert.equal(budget.stopBeforeToolCall(), 'max_tool_calls')
    assert.equal(budget.stopBeforeStep(), 'max_tool_calls')
    assert.throws(() => budget.spendToolCall(), RunBudgetLimitError)
  })

  it('enforces the deadline against an injected clock', () => {
    let now = 0
    const budget = new RunBudget({ timeoutMs: 1_000 }, 0, () => now)
    assert.equal(budget.hasDeadline, true)
    assert.equal(budget.deadlineExceeded(), false)
    assert.equal(budget.remainingMs, 1_000)
    now = 999
    assert.equal(budget.stopBeforeStep(), undefined)
    now = 1_000
    assert.equal(budget.deadlineExceeded(), true)
    assert.equal(budget.remainingMs, 0)
    assert.equal(budget.stopBeforeStep(), 'timeout')
    assert.equal(budget.stopBeforeToolCall(), 'timeout')
  })

  it('reports no limit when nothing is configured', () => {
    const budget = new RunBudget({}, 0, () => 1_000_000)
    assert.equal(budget.hasDeadline, false)
    assert.equal(budget.remainingMs, undefined)
    assert.equal(budget.deadlineExceeded(), false)
    assert.equal(budget.stopBeforeStep(), undefined)
    assert.equal(budget.stopBeforeToolCall(), undefined)
  })

  it('gives autonomous modes a wall clock and interactive turns none', () => {
    const autonomous = { maxSteps: MAX_TURN_STEPS, maxToolCalls: MAX_TURN_TOOL_CALLS, timeoutMs: TURN_TIMEOUT_MS }
    assert.deepEqual(turnBudgetFor('goal'), autonomous)
    assert.deepEqual(turnBudgetFor('loop'), autonomous)
    assert.deepEqual(turnBudgetFor(undefined), {
      maxSteps: MAX_INTERACTIVE_TURN_STEPS,
      maxToolCalls: MAX_TURN_TOOL_CALLS,
    })
  })
})

describe('Agent loop run budgets', () => {
  it('stops a batch at the tool-call limit and keeps every call paired with a result', async () => {
    let batch = 0
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), maxToolCalls: 3,
      tools: new ToolRegistry([stubTool('read')]),
      model: {
        async next() {
          batch += 1
          return { type: 'tool_calls', calls: [
            { id: `a${batch}`, toolName: 'read', input: {} },
            { id: `b${batch}`, toolName: 'read', input: {} },
          ] }
        },
      },
    })

    assert.equal(result.outcome, 'max_tool_calls')
    // 2 calls in the first batch, 1 in the second; the 4th call is refused.
    assert.equal(result.toolCalls, 3)
    assert.equal(batch, 2)
    const calls = result.messages.filter(message => message.role === 'assistant_tool_call')
    const toolResults = result.messages.filter(message => message.role === 'tool_result')
    assert.equal(calls.length, 4)
    assert.equal(toolResults.length, 4)
    assert.deepEqual(toolResults.map(message => message.content), [
      'read result', 'read result', 'read result', 'Cancelled before execution.',
    ])
    assert.equal(result.messages.at(-1)?.role, 'assistant')
    assert.equal(result.messages.at(-1)?.content, '达到工具调用数上限（3 次），已停止当前回合。')
  })

  it('still stops at the model-round limit', async () => {
    let requests = 0
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), maxSteps: 2,
      tools: new ToolRegistry([stubTool('read')]),
      model: {
        async next() {
          requests += 1
          return { type: 'tool_calls', calls: [{ id: `c${requests}`, toolName: 'read', input: {} }] }
        },
      },
    })

    assert.equal(requests, 2)
    assert.equal(result.toolCalls, 2)
    assert.equal(result.outcome, 'max_steps')
    assert.equal(result.messages.at(-1)?.content, '达到模型轮次上限（2 轮），已停止当前回合。')
  })

  it('checks the deadline before starting each round (injected clock)', async () => {
    let now = 0
    let requests = 0
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), timeoutMs: 1_000, now: () => now,
      tools: new ToolRegistry([stubTool('read')]),
      model: {
        async next() {
          requests += 1
          now += 600
          return { type: 'tool_calls', calls: [{ id: `d${requests}`, toolName: 'read', input: {} }] }
        },
      },
    })

    assert.equal(requests, 2)
    assert.equal(result.outcome, 'timeout')
    // The second round starts before the deadline and is then cut inside its batch,
    // so its tool call is refused and only the first round's call ran.
    assert.equal(result.toolCalls, 1)
    assert.equal(result.messages.at(-1)?.content, '整轮运行超时（1 秒，已用 2 轮 / 1 次工具调用），已停止当前回合。')
  })

  it('cuts a model request that outlives the deadline, even without signal support', async () => {
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), timeoutMs: 25,
      tools: new ToolRegistry([]),
      model: { async next() { return new Promise<AgentStep>(() => {}) } },
    })

    assert.equal(result.outcome, 'timeout')
    assert.equal(result.toolCalls, 0)
    assert.ok(result.messages.some(message => message.role === 'assistant' && message.content.includes('整轮运行超时')))
  })

  it('lets an already-started tool finish after the deadline and keeps its result', async () => {
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), timeoutMs: 20,
      tools: new ToolRegistry([{
        ...stubTool('slow', 'slow result'),
        async run() {
          await new Promise(resolve => setTimeout(resolve, 60))
          return { ok: true, output: 'slow result' }
        },
      }]),
      model: { async next() { return { type: 'tool_calls', calls: [{ id: 'slow-1', toolName: 'slow', input: {} }] } } },
    })

    assert.equal(result.outcome, 'timeout')
    assert.equal(result.toolCalls, 1)
    assert.ok(result.messages.some(message => message.role === 'tool_result' && message.content === 'slow result'))
  })

  it('stops a signal-honouring tool at the deadline', async () => {
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), timeoutMs: 20,
      tools: new ToolRegistry([{
        ...stubTool('wait'),
        async run(_input, context) {
          await abortableDelay(10_000, context.signal)
          return { ok: true, output: 'waited' }
        },
      }]),
      model: { async next() { return { type: 'tool_calls', calls: [{ id: 'wait-1', toolName: 'wait', input: {} }] } } },
    })

    assert.equal(result.outcome, 'timeout')
    assert.equal(result.toolCalls, 1)
    assert.ok(result.messages.some(message => message.role === 'tool_result' && message.isError))
  })

  it('reports a deadline stop, not a tool failure, in autonomous mode', async () => {
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), timeoutMs: 30, stopOnFatalToolError: true,
      tools: new ToolRegistry([{
        ...stubTool('wait'),
        async run(_input, context) {
          await abortableDelay(10_000, context.signal)
          return { ok: true, output: 'waited' }
        },
      }]),
      model: { async next() { return { type: 'tool_calls', calls: [{ id: 'wait-1', toolName: 'wait', input: {} }] } } },
    })

    // The abort surfaces as `fatal: true` from ToolRegistry; goal/loop turns
    // must still report the budget, not an implementation crash.
    assert.equal(result.outcome, 'timeout')
    assert.equal(result.toolCalls, 1)
    assert.equal(result.messages.at(-1)?.content, '整轮运行超时（30 毫秒，已用 1 轮 / 1 次工具调用），已停止当前回合。')
  })

  it('keeps a user stop distinct from a deadline stop', async () => {
    const controller = new AbortController()
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), signal: controller.signal, timeoutMs: 60_000,
      tools: new ToolRegistry([]),
      model: {
        async next() {
          controller.abort(new Error('User paused'))
          return new Promise<AgentStep>(() => {})
        },
      },
    })

    assert.equal(result.outcome, 'aborted')
  })

  it('bounds an interactive turn that only ever reports progress', async () => {
    let requests = 0
    const result = await runAgentTurnWithOutcome({
      messages: [], cwd: process.cwd(), ...turnBudgetFor(undefined),
      tools: new ToolRegistry([]),
      model: {
        async next() {
          requests += 1
          return { type: 'assistant', content: 'still working', kind: 'progress' }
        },
      },
    })

    assert.equal(requests, MAX_INTERACTIVE_TURN_STEPS)
    assert.equal(result.outcome, 'max_steps')
  })
})
