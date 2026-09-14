import type { ProviderUsage } from '../types.js'
import { getTokenCounter } from '../token/index.js'

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * A short label describing how many tokens one agent reply consumed.
 *
 * Prefers the provider's exact usage. When the provider does not report usage
 * (offline/mock models), it falls back to the local token counter and marks the
 * number as estimated so an approximation is never presented as exact.
 */
export function formatResponseTokens(
  usage?: ProviderUsage,
  fallbackText?: string,
): string | null {
  if (usage && usage.totalTokens > 0) {
    return `tokens ${compact(usage.inputTokens)} in / ${compact(usage.outputTokens)} out`
  }

  if (fallbackText) {
    const estimated = getTokenCounter().countText(fallbackText)
    if (estimated > 0) {
      return `tokens ~${compact(estimated)} estimated`
    }
  }

  return null
}
