import type { TokenCounter } from './types.js'
import { HeuristicTokenCounter } from './heuristic-counter.js'
import {
  AnthropicTokenizerCounter,
  loadAnthropicCountTokens,
} from './anthropic-counter.js'

export type { TokenCounter } from './types.js'
export { HeuristicTokenCounter, CHARS_PER_TOKEN } from './heuristic-counter.js'
export { AnthropicTokenizerCounter, loadAnthropicCountTokens } from './anthropic-counter.js'
export { messageTokenText } from './render.js'

/**
 * - `heuristic`: dependency-free character/constant estimate (deterministic default)
 * - `anthropic`: Anthropic's official BPE tokenizer (requires the optional dep)
 * - `auto`: use the real tokenizer when it is installed, otherwise heuristic
 */
export type TokenCounterKind = 'heuristic' | 'anthropic' | 'auto'

let active: TokenCounter = new HeuristicTokenCounter()

export function getTokenCounter(): TokenCounter {
  return active
}

export function setTokenCounter(counter: TokenCounter): void {
  active = counter
}

export function createTokenCounter(kind: TokenCounterKind): TokenCounter {
  if (kind === 'heuristic') {
    return new HeuristicTokenCounter()
  }

  const countTokens = loadAnthropicCountTokens()
  if (!countTokens) {
    if (kind === 'anthropic') {
      console.error(
        '[miniweave] @anthropic-ai/tokenizer is not installed; falling back to the heuristic token counter',
      )
    }
    return new HeuristicTokenCounter()
  }

  return new AnthropicTokenizerCounter(countTokens)
}

export function resolveTokenCounterKind(
  raw: string | undefined = process.env.MINIWEAVE_TOKEN_COUNTER,
): TokenCounterKind {
  const value = (raw ?? 'auto').trim().toLowerCase()
  if (value === 'heuristic' || value === 'anthropic' || value === 'auto') {
    return value
  }
  return 'auto'
}

export function initTokenCounterFromEnv(raw?: string): TokenCounter {
  const counter = createTokenCounter(resolveTokenCounterKind(raw))
  setTokenCounter(counter)
  return counter
}
