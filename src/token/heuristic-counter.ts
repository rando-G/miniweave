import type { ChatMessage } from '../types.js'
import type { TokenCounter } from './types.js'

/**
 * Per-role characters-per-token ratios. Code and JSON (tool calls/results) are
 * denser than prose, so they use a smaller ratio and therefore more tokens.
 */
export const CHARS_PER_TOKEN: Record<string, number> = {
  system: 3.5,
  user: 3.0,
  assistant_thinking: 3.0,
  assistant: 3.5,
  assistant_progress: 3.5,
  assistant_tool_call: 2.5,
  tool_result: 2.0,
  context_summary: 3.5,
  snip_boundary: 3.5,
}

const DEFAULT_CHARS_PER_TOKEN = 3.0

/** Character length used by the heuristic for a message. */
export function messageContentLength(message: ChatMessage): number {
  switch (message.role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'assistant_progress':
      return message.content.length
    case 'assistant_thinking':
      try {
        return JSON.stringify(message.blocks).length
      } catch {
        return 0
      }
    case 'assistant_tool_call':
      try {
        return JSON.stringify(message.input).length
      } catch {
        return 0
      }
    case 'tool_result':
      return message.content.length
    case 'context_summary':
      return message.content.length
    case 'snip_boundary':
      return message.content.length
    default:
      return 0
  }
}

/**
 * The dependency-free default: divides character length by a per-role constant.
 * Cheap and deterministic, but only roughly proportional to real token counts —
 * it underestimates CJK text badly and drifts on code.
 */
export class HeuristicTokenCounter implements TokenCounter {
  readonly name = 'heuristic'

  countText(text: string): number {
    if (text.length === 0) return 0
    return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN)
  }

  countMessage(message: ChatMessage): number {
    const ratio = CHARS_PER_TOKEN[message.role] ?? DEFAULT_CHARS_PER_TOKEN
    const length = messageContentLength(message)
    if (length === 0) return 0
    return Math.ceil(length / ratio)
  }
}
