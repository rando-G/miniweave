/**
 * Token accounting accuracy benchmark.
 *
 *   npx tsx bench/token-accuracy.ts          # offline: heuristic vs real tokenizer
 *   npx tsx bench/token-accuracy.ts --live   # also calls Claude for ground truth
 *
 * The live mode sends a handful of tiny requests and reads the provider's
 * reported `usage.input_tokens`, which is the exact tokenizer output. It costs
 * a negligible amount and is opt-in.
 */
import { readFile } from 'node:fs/promises'
import type { ChatMessage } from '../src/types.js'
import {
  AnthropicTokenizerCounter,
  HeuristicTokenCounter,
  loadAnthropicCountTokens,
  messageTokenText,
} from '../src/token/index.js'

const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')
const authToken = process.env.ANTHROPIC_AUTH_TOKEN
const model = process.env.MINIWEAVE_BENCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514'
const isLive = process.argv.includes('--live')

const anthropicCountTokens = loadAnthropicCountTokens()
const heuristic = new HeuristicTokenCounter()
const tokenizer = anthropicCountTokens ? new AnthropicTokenizerCounter(anthropicCountTokens) : null

async function requestInputTokens(content: string): Promise<number> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content }] }),
  })
  if (!response.ok) {
    throw new Error(`count request failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  const data = (await response.json()) as { usage?: { input_tokens?: number } }
  return data.usage?.input_tokens ?? 0
}

/** Claude adds a small constant framing cost (role markers etc.) to input_tokens. */
async function measureFramingOverhead(): Promise<number> {
  const raw = await requestInputTokens('a')
  return Math.max(0, raw - 1)
}

async function buildSamples(): Promise<Array<{ label: string; message: ChatMessage }>> {
  const source = await readFile(new URL('../src/agent-loop.ts', import.meta.url), 'utf8')
  const sourceChunk = source.slice(0, 2000)

  const asUser = (label: string, content: string): { label: string; message: ChatMessage } => ({
    label,
    message: { role: 'user', content },
  })
  const asToolResult = (label: string, toolName: string, content: string): { label: string; message: ChatMessage } => ({
    label,
    message: { role: 'tool_result', toolUseId: `bench-${toolName}`, toolName, content, isError: false },
  })

  return [
    asUser('短英文', 'Fix the failing test.'),
    asUser(
      '英文散文',
      'The agent loop repeatedly calls the model, executes the requested tools, and feeds the results back into the conversation until the task is complete or a budget is exhausted.',
    ),
    asUser(
      'TypeScript 代码',
      'export async function resolveToolPath(context: ToolContext, targetPath: string, intent: "read" | "write" | "list" | "search"): Promise<string> { const resolved = path.resolve(context.cwd, targetPath); await context.permissions?.ensurePathAccess(resolved, intent); return resolved }',
    ),
    asUser(
      'Python 代码',
      'def compact(messages, model):\n    stats = compute_context_stats(messages, model)\n    if stats.utilization < THRESHOLD:\n        return messages\n    return snip(messages, keep_recent=12)',
    ),
    asUser(
      '中文',
      '这是一个基于插件化架构的编码智能体，支持依赖拓扑排序、循环依赖检测、逆序销毁以及初始化失败回滚。',
    ),
    asUser(
      '中英混合',
      '请把 resolveToolPath 改成 async 函数，并且增加 workspace 边界检查，避免路径逃逸（path traversal）问题。',
    ),
    asToolResult(
      'JSON 工具结果',
      'edit_file',
      JSON.stringify({ ok: true, output: 'Applied reviewed changes to src/agent-loop.ts', toolName: 'edit_file', isError: false, changedLines: 12 }),
    ),
    asToolResult('源码 2000 字符', 'read_file', `FILE: src/agent-loop.ts\n${sourceChunk}`),
  ]
}

type Row = {
  label: string
  heuristic: number
  tokenizer: number | null
  real: number | null
}

function formatError(value: number | null, reference: number | null): string {
  if (value === null || reference === null || reference === 0) return 'n/a'
  const error = ((value - reference) / reference) * 100
  return `${error >= 0 ? '+' : ''}${error.toFixed(1)}%`
}

function meanAbsolutePercentageError(rows: Row[], field: 'heuristic' | 'tokenizer'): number | null {
  const errors: number[] = []
  for (const row of rows) {
    const value = row[field]
    if (value === null || row.real === null || row.real === 0) continue
    errors.push(Math.abs((value - row.real) / row.real) * 100)
  }
  if (errors.length === 0) return null
  return errors.reduce((a, b) => a + b, 0) / errors.length
}

async function main(): Promise<void> {
  const samples = await buildSamples()
  const rows: Row[] = []

  let framingOverhead = 0
  if (isLive) {
    if (!authToken) throw new Error('ANTHROPIC_AUTH_TOKEN is required for --live')
    framingOverhead = await measureFramingOverhead()
    console.log(`基准: Claude ${model} 的真实 input_tokens (含约 ${framingOverhead} token 的请求固定开销)\n`)
  } else {
    console.log('离线模式: 以官方 tokenizer 作为参照（加 --live 可用 Claude 真实计数校准）\n')
  }

  for (const sample of samples) {
    const text = messageTokenText(sample.message)
    const row: Row = {
      label: sample.label,
      heuristic: heuristic.countMessage(sample.message),
      tokenizer: tokenizer ? tokenizer.countMessage(sample.message) : null,
      real: null,
    }

    if (isLive) {
      // Compare against the provider's raw input_tokens. It includes a small
      // amount of request framing, so the tokenizer error shown is a
      // conservative upper bound rather than a precise figure.
      row.real = await requestInputTokens(text)
    } else {
      row.real = row.tokenizer
    }

    rows.push(row)
  }

  const header = ['样本'.padEnd(18), '启发式'.padEnd(10), '真实tokenizer'.padEnd(15), '参照'.padEnd(8), '启发式误差'.padEnd(12), 'tokenizer误差']
  console.log(header.join(''))
  console.log('-'.repeat(90))
  for (const row of rows) {
    console.log(
      row.label.padEnd(18) +
        String(row.heuristic).padEnd(10) +
        String(row.tokenizer ?? 'n/a').padEnd(15) +
        String(row.real ?? 'n/a').padEnd(8) +
        formatError(row.heuristic, row.real).padEnd(12) +
        formatError(row.tokenizer, row.real),
    )
  }

  const heuristicMape = meanAbsolutePercentageError(rows, 'heuristic')
  const tokenizerMape = meanAbsolutePercentageError(rows, 'tokenizer')

  console.log('\n平均绝对百分比误差 (MAPE):')
  console.log(`  启发式          : ${heuristicMape === null ? 'n/a' : `${heuristicMape.toFixed(1)}%`}`)
  if (isLive) {
    console.log(`  真实 tokenizer  : ${tokenizerMape === null ? 'n/a' : `${tokenizerMape.toFixed(1)}%`}`)
    if (heuristicMape !== null && tokenizerMape !== null && heuristicMape > 0) {
      console.log(`  误差降低        : ${(100 - (tokenizerMape / heuristicMape) * 100).toFixed(1)}%`)
    }
    console.log(`\n注: 参照为 Claude 原始 input_tokens，包含少量请求固定开销，`)
    console.log(`    因此 tokenizer 误差是保守上界。`)
  } else {
    console.log(`  真实 tokenizer  : n/a (离线模式以它作为参照)`)
  }
  console.log(`\n注: 本基准只统计消息文本；真实请求还包含工具 JSON Schema 等，`)
  console.log(`    这部分仍以 provider 返回的 usage 为准。样本数 ${rows.length}。`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
