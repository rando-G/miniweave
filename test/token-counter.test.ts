import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/types.js'
import {
  AnthropicTokenizerCounter,
  CHARS_PER_TOKEN,
  HeuristicTokenCounter,
  createTokenCounter,
  getTokenCounter,
  loadAnthropicCountTokens,
  resolveTokenCounterKind,
  setTokenCounter,
} from '../src/token/index.js'
import { estimateMessageTokens } from '../src/utils/token-estimator.js'

describe('HeuristicTokenCounter', () => {
  it('keeps the legacy per-role ratio behaviour', () => {
    const counter = new HeuristicTokenCounter()
    const content = 'x'.repeat(100)

    const system: ChatMessage = { role: 'system', content }
    assert.equal(counter.countMessage(system), Math.ceil(100 / CHARS_PER_TOKEN.system!))

    const toolResult: ChatMessage = {
      role: 'tool_result',
      toolUseId: '1',
      toolName: 'read_file',
      content,
      isError: false,
    }
    assert.equal(counter.countMessage(toolResult), Math.ceil(100 / CHARS_PER_TOKEN.tool_result!))
  })

  it('returns 0 for empty content', () => {
    const counter = new HeuristicTokenCounter()
    assert.equal(counter.countMessage({ role: 'user', content: '' }), 0)
    assert.equal(counter.countText(''), 0)
  })

  it('counts more tokens for denser roles at equal length', () => {
    const counter = new HeuristicTokenCounter()
    const content = 'a'.repeat(100)
    const toolResult: ChatMessage = { role: 'tool_result', toolUseId: '1', toolName: 'read_file', content, isError: false }
    const assistant: ChatMessage = { role: 'assistant', content }
    assert.ok(counter.countMessage(toolResult) > counter.countMessage(assistant))
  })
})

describe('AnthropicTokenizerCounter', () => {
  const countTokens = loadAnthropicCountTokens()
  const available = countTokens !== null

  it('is available or gracefully absent', () => {
    // The optional dependency should be present in this repo (declared in
    // optionalDependencies), but the code must tolerate it missing.
    assert.equal(typeof available, 'boolean')
  })

  it('counts a real BPE token stream', { skip: !available }, () => {
    const counter = new AnthropicTokenizerCounter(countTokens!)
    const msg: ChatMessage = { role: 'user', content: 'Hello, how are you today?' }
    const tokens = counter.countMessage(msg)
    assert.ok(tokens > 0)
    assert.ok(tokens < 20, `expected a small count, got ${tokens}`)
    assert.equal(counter.countText(''), 0)
  })

  it('is deterministic and caches by message identity', { skip: !available }, () => {
    const counter = new AnthropicTokenizerCounter(countTokens!)
    const msg: ChatMessage = { role: 'user', content: 'Repeatable text for counting.' }
    assert.equal(counter.countMessage(msg), counter.countMessage(msg))
  })

  it('counts CJK text far above the character heuristic', { skip: !available }, () => {
    const counter = new AnthropicTokenizerCounter(countTokens!)
    const heuristic = new HeuristicTokenCounter()
    // Chinese is roughly one token per character; the heuristic divides by 3.
    const msg: ChatMessage = { role: 'user', content: '这是一个基于插件化架构的编码智能体' }
    assert.ok(
      counter.countMessage(msg) > heuristic.countMessage(msg),
      'the real tokenizer should count CJK text higher than the heuristic',
    )
  })
})

describe('token counter selection', () => {
  it('resolves the kind from an env string', () => {
    assert.equal(resolveTokenCounterKind('heuristic'), 'heuristic')
    assert.equal(resolveTokenCounterKind('ANTHROPIC'), 'anthropic')
    assert.equal(resolveTokenCounterKind('auto'), 'auto')
    assert.equal(resolveTokenCounterKind(undefined), 'auto')
    assert.equal(resolveTokenCounterKind('nonsense'), 'auto')
  })

  it('creates a heuristic counter on demand', () => {
    assert.equal(createTokenCounter('heuristic').name, 'heuristic')
  })

  it('auto-selects the real tokenizer when installed, else falls back', () => {
    const counter = createTokenCounter('auto')
    const expected = loadAnthropicCountTokens() ? 'anthropic' : 'heuristic'
    assert.equal(counter.name, expected)
  })

  it('lets the active counter be swapped and restores the default', () => {
    const previous = getTokenCounter()
    try {
      const custom = { name: 'fixed', countText: () => 7, countMessage: () => 7 }
      setTokenCounter(custom)
      assert.equal(estimateMessageTokens({ role: 'user', content: 'anything' }), 7)
    } finally {
      setTokenCounter(previous)
    }
  })
})
