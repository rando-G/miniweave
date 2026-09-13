import type { ChatMessage } from '../types.js'

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Renders a message to the text that a tokenizer should count.
 *
 * This mirrors what actually travels to the provider closely enough to be
 * useful: text roles contribute their content, tool calls contribute the tool
 * name plus serialized input, tool results contribute their payload.
 */
export function messageTokenText(message: ChatMessage): string {
  switch (message.role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'assistant_progress':
      return message.content
    case 'assistant_thinking':
      return safeJson(message.blocks)
    case 'assistant_tool_call':
      return `${message.toolName} ${safeJson(message.input)}`.trim()
    case 'tool_result':
      return message.content
    case 'context_summary':
      return `[Context Summary] ${message.content}`
    case 'snip_boundary':
      return message.content
    default:
      return ''
  }
}
