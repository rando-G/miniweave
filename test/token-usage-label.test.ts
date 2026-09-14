import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatResponseTokens } from '../src/utils/token-usage-label.js'
import { getTokenCounter, setTokenCounter } from '../src/token/index.js'

describe('formatResponseTokens', () => {
  it('prefers exact provider usage over any estimate', () => {
    const label = formatResponseTokens(
      { inputTokens: 1_200, outputTokens: 340, totalTokens: 1_540, source: 'test' },
      'text that would be estimated',
    )
    assert.equal(label, 'tokens 1.2k in / 340 out')
  })

  it('marks the label as estimated when the provider reported no usage', () => {
    const previous = getTokenCounter()
    try {
      setTokenCounter({ name: 'fixed', countText: () => 42, countMessage: () => 42 })
      assert.equal(formatResponseTokens(undefined, 'hello'), 'tokens ~42 estimated')
    } finally {
      setTokenCounter(previous)
    }
  })

  it('compacts thousands and millions', () => {
    assert.equal(
      formatResponseTokens({ inputTokens: 1_500_000, outputTokens: 12_345, totalTokens: 1_512_345, source: 't' }),
      'tokens 1.5M in / 12k out',
    )
    assert.equal(
      formatResponseTokens({ inputTokens: 999, outputTokens: 1, totalTokens: 1_000, source: 't' }),
      'tokens 999 in / 1 out',
    )
  })

  it('returns null when there is nothing to report', () => {
    assert.equal(formatResponseTokens(undefined, ''), null)
    assert.equal(
      formatResponseTokens({ inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 't' }, ''),
      null,
    )
  })
})
