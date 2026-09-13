import type { ChatMessage } from '../types.js'

/**
 * A pluggable counter used for context accounting and compaction thresholds.
 *
 * The Agent Loop only depends on this interface, so the counting strategy can
 * be swapped without touching the loop: a dependency-free character heuristic
 * is always available, and a real BPE tokenizer can be enabled when installed.
 */
export interface TokenCounter {
  /** Stable identifier used in diagnostics (e.g. "heuristic", "anthropic"). */
  readonly name: string
  /** Count tokens for a raw string. */
  countText(text: string): number
  /** Count tokens for a single message. */
  countMessage(message: ChatMessage): number
}
