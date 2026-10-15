import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { INPUT_PROMPT_PREFIX, inputPromptCaretWidth, renderInputPrompt } from '../src/tui/input.ts'

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, '')

describe('input prompt caret', () => {
  it('measures the caret offset after the prompt prefix', () => {
    const prefix = INPUT_PROMPT_PREFIX.length
    assert.equal(inputPromptCaretWidth('', 0), prefix)
    assert.equal(inputPromptCaretWidth('ab', 0), prefix)
    assert.equal(inputPromptCaretWidth('ab', 2), prefix + 2)
  })

  it('counts CJK characters by display width', () => {
    const prefix = INPUT_PROMPT_PREFIX.length
    // Two full-width characters occupy four terminal columns.
    assert.equal(inputPromptCaretWidth('你好', 1), prefix + 2)
    assert.equal(inputPromptCaretWidth('你好', 2), prefix + 4)
  })

  it('clamps the cursor offset to the input length', () => {
    assert.equal(inputPromptCaretWidth('ab', 99), inputPromptCaretWidth('ab', 2))
    assert.equal(inputPromptCaretWidth('ab', -5), inputPromptCaretWidth('ab', 0))
  })

  it('agrees with the rendered prompt text', () => {
    const rendered = stripAnsi(renderInputPrompt('ab', 2))
    assert.ok(rendered.startsWith('weave> ab'))
    assert.equal(inputPromptCaretWidth('ab', 2), 'weave> ab'.length)
  })
})
