/**
 * Shared, frozen scoring material for the token-counter RSI target.
 *
 * The samples and the MAPE math live in the bench (outside the mutable scope),
 * so a candidate can only influence the score through the counter it implements
 * — never through the measurement itself.
 */
import { messageTokenText } from '../src/token/render.js'
import type { ChatMessage } from '../src/types.js'
import type { TokenCounter } from '../src/token/types.js'

/** One sample per role the heuristic claims to model, with mixed content density. */
export function buildFitSamples(): ChatMessage[] {
  const user = (content: string): ChatMessage => ({ role: 'user', content })
  const toolResult = (toolName: string, content: string): ChatMessage => ({
    role: 'tool_result',
    toolUseId: `fit-${toolName}`,
    toolName,
    content,
    isError: false,
  })

  return [
    { role: 'system', content: 'You are a coding agent. Follow the user instructions and keep changes minimal.' },
    { role: 'system', content: '你是一个编码智能体。请遵守用户指令，保持改动最小化，并在修改前先阅读相关文件。' },
    user('Fix the failing test in src/agent-loop.ts.'),
    user('这是一个基于插件化架构的编码智能体，支持依赖拓扑排序、循环依赖检测、逆序销毁以及初始化失败回滚。'),
    { role: 'assistant', content: 'I will read the failing test first, then trace the loop that produces the wrong outcome.' },
    { role: 'assistant', content: '我先读取失败的测试，然后沿着产生错误结果的循环逐步排查，最后再修改实现。' },
    { role: 'assistant_progress', content: 'Checking the tool registry for duplicate names before adding the new tool.' },
    {
      role: 'assistant_thinking',
      blocks: [{ type: 'thinking', thinking: 'The permission check happens inside the tool, so the loop does not need to know about it.' }],
    },
    {
      role: 'assistant_tool_call',
      toolUseId: 'fit-1',
      toolName: 'edit_file',
      input: { path: 'src/agent-loop.ts', oldString: 'const calls = next.calls', newString: 'const calls = [...next.calls]' },
    },
    toolResult('read_file', `FILE: src/agent-loop.ts\nexport function runAgentTurn() {\n  return next.calls.map(call => call.toolName)\n}\n`),
    toolResult('run_command', 'npm test\n> 323 passing\n> 0 failing\n'),
    toolResult('grep_files', JSON.stringify({ matches: [{ file: 'src/tool.ts', line: 119 }, { file: 'src/agent-loop.ts', line: 435 }] })),
    { role: 'context_summary', content: 'Earlier the agent explored the tool registry and identified the duplicate-name check.', compressedCount: 6, timestamp: 0 },
    { role: 'snip_boundary', content: 'Removed 4 middle-history messages that only repeated the plan.', removedMessageIds: ['a', 'b', 'c', 'd'], removedCount: 4, tokensFreed: 120, timestamp: 0 },
  ]
}

/** Reference token counts from the official tokenizer; the ground truth for MAPE. */
export function referenceTokens(countTokens: (text: string) => number): number[] {
  return buildFitSamples().map(message => countTokens(messageTokenText(message)))
}

/** Mean absolute percentage error of a counter against the reference counts. */
export function mapeFor(counter: TokenCounter, samples: ChatMessage[], references: readonly number[]): number {
  const errors: number[] = []
  for (let index = 0; index < samples.length; index += 1) {
    const reference = references[index]
    if (!reference) continue
    const counted = counter.countMessage(samples[index]!)
    errors.push(Math.abs((counted - reference) / reference) * 100)
  }
  if (errors.length === 0) return Number.POSITIVE_INFINITY
  return errors.reduce((sum, value) => sum + value, 0) / errors.length
}
