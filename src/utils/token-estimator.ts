import type { ChatMessage, ProviderUsage } from '../types.js'
import { getTokenCounter } from '../token/index.js'
import { getModelContextWindow } from './model-context.js'

export type TokenAccountingSource =
  | 'provider_usage'
  | 'provider_usage_plus_estimate'
  | 'estimate_only'

export type TokenAccountingResult = {
  totalTokens: number
  providerUsageTokens: number
  estimatedTokens: number
  source: TokenAccountingSource
  isExact: boolean
  usageBoundary?: {
    messageIndex: number
    messageId?: string
  }
  stale?: boolean
  reason?: string
}

export type ContextStats = {
  estimatedTokens: number
  totalTokens: number
  providerUsageTokens: number
  contextWindow: number
  effectiveInput: number
  utilization: number
  warningLevel: 'normal' | 'warning' | 'critical' | 'blocked'
  accounting: TokenAccountingResult
}

const CLEAR_MARKER = '[Output cleared for context space]'

export function estimateMessageTokens(message: ChatMessage): number {
  return getTokenCounter().countMessage(message)
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  const counter = getTokenCounter()
  let total = 0
  for (const message of messages) {
    total += counter.countMessage(message)
  }
  return total
}

function messageProviderUsage(message: ChatMessage): ProviderUsage | undefined {
  if (
    (message.role === 'assistant' ||
      message.role === 'assistant_progress' ||
      message.role === 'assistant_tool_call') &&
    message.providerUsage &&
    !message.usageStale
  ) {
    return message.providerUsage
  }
  return undefined
}

function staleUsageReason(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (
      (message.role === 'assistant' ||
        message.role === 'assistant_progress' ||
        message.role === 'assistant_tool_call') &&
      message.providerUsage &&
      message.usageStale
    ) {
      return message.usageStaleReason ?? 'provider usage was marked stale'
    }
  }
  return undefined
}

function messageBoundaryId(message: ChatMessage): string | undefined {
  if (message.role === 'assistant_tool_call') return message.toolUseId
  return undefined
}

export function tokenCountWithEstimation(messages: ChatMessage[]): TokenAccountingResult {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messageProviderUsage(messages[i])
    if (!usage) continue

    const tailMessages = messages.slice(i + 1)
    const estimatedTokens = estimateMessagesTokens(tailMessages)
    return {
      totalTokens: usage.totalTokens + estimatedTokens,
      providerUsageTokens: usage.totalTokens,
      estimatedTokens,
      source: estimatedTokens > 0 ? 'provider_usage_plus_estimate' : 'provider_usage',
      isExact: estimatedTokens === 0,
      usageBoundary: {
        messageIndex: i,
        messageId: messageBoundaryId(messages[i]),
      },
    }
  }

  const reason = staleUsageReason(messages)
  const estimatedTokens = estimateMessagesTokens(messages)
  return {
    totalTokens: estimatedTokens,
    providerUsageTokens: 0,
    estimatedTokens,
    source: 'estimate_only',
    isExact: false,
    stale: Boolean(reason),
    reason: reason ?? 'no provider usage available',
  }
}

export function markProviderUsageStale(
  message: ChatMessage,
  reason: string,
): ChatMessage {
  if (
    (message.role === 'assistant' ||
      message.role === 'assistant_progress' ||
      message.role === 'assistant_tool_call') &&
    message.providerUsage
  ) {
    return {
      ...message,
      usageStale: true,
      usageStaleReason: reason,
    }
  }
  return message
}

export function computeContextStats(
  messages: ChatMessage[],
  model: string,
): ContextStats {
  const window = getModelContextWindow(model)
  const accounting = tokenCountWithEstimation(messages)
  const utilization = Math.min(1, accounting.totalTokens / window.effectiveInput)

  let warningLevel: ContextStats['warningLevel']
  if (utilization >= 0.95) {
    warningLevel = 'blocked'
  } else if (utilization >= 0.85) {
    warningLevel = 'critical'
  } else if (utilization >= 0.50) {
    warningLevel = 'warning'
  } else {
    warningLevel = 'normal'
  }

  return {
    estimatedTokens: accounting.estimatedTokens,
    totalTokens: accounting.totalTokens,
    providerUsageTokens: accounting.providerUsageTokens,
    contextWindow: window.contextWindow,
    effectiveInput: window.effectiveInput,
    utilization,
    warningLevel,
    accounting,
  }
}

export { CLEAR_MARKER }
