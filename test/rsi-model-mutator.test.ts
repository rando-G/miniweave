import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ModelMutator, buildMutationPrompt } from '../src/rsi/index.js'
import type { ChatMessage, ModelAdapter, ModelRequestOptions } from '../src/types.js'
import type { MutationContext } from '../src/rsi/index.js'

function recordingAdapter(content: string, seen: ChatMessage[][] = []): ModelAdapter {
  return {
    async next(messages: ChatMessage[], _options?: ModelRequestOptions) {
      seen.push(messages)
      return { type: 'assistant', content }
    },
  }
}

const context: MutationContext = {
  cycle: 1,
  scorerFingerprint: 'abc123',
  best: {
    nodeId: 'root',
    score: 51.2,
    rationale: 'baseline',
    files: [{ path: 'src/token/heuristic-counter.ts', content: 'export const CHARS_PER_TOKEN = { user: 3 }' }],
  },
  history: [],
}

describe('ModelMutator', () => {
  it('parses candidate proposals from model JSON', async () => {
    const payload = JSON.stringify({
      candidates: [{ rationale: 'lower the user ratio', files: [{ path: 'src/token/heuristic-counter.ts', content: 'export const CHARS_PER_TOKEN = { user: 2.5 }' }] }],
    })
    const mutator = new ModelMutator({ model: recordingAdapter(payload) })
    const proposals = await mutator.propose(context)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.rationale, 'lower the user ratio')
    assert.equal(proposals[0]!.files[0]!.content, 'export const CHARS_PER_TOKEN = { user: 2.5 }')
  })

  it('shows the current best harness to the model', async () => {
    const seen: ChatMessage[][] = []
    const mutator = new ModelMutator({ model: recordingAdapter('{"candidates":[]}', seen) })
    await mutator.propose(context)
    const userMessage = seen[0]!.find(message => message.role === 'user')
    assert.ok(userMessage && userMessage.role === 'user')
    assert.match(userMessage.content, /heuristic-counter\.ts/)
    assert.match(userMessage.content, /user: 3/)
  })

  it('treats unparseable output as an empty proposal list', async () => {
    const errors: Error[] = []
    const mutator = new ModelMutator({
      model: recordingAdapter('I think you should tune the ratios.'),
      onParseError: error => errors.push(error),
    })
    const proposals = await mutator.propose(context)
    assert.deepEqual(proposals, [])
    assert.equal(errors.length, 1)
  })

  it('caps the number of candidates', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      rationale: `c${index}`,
      files: [{ path: 'src/token/heuristic-counter.ts', content: `v${index}` }],
    }))
    const mutator = new ModelMutator({ model: recordingAdapter(JSON.stringify({ candidates })), maxCandidates: 2 })
    assert.equal((await mutator.propose(context)).length, 2)
  })
})

describe('buildMutationPrompt', () => {
  it('lists history and the current best files', () => {
    const prompt = buildMutationPrompt({
      ...context,
      history: [{
        cycle: 1,
        nodeId: 'a',
        patchId: 'a',
        parentId: 'root',
        rationale: 'first try',
        score: 40,
        passed: true,
        metrics: {},
        accepted: true,
        improvement: -11.2,
        scorerFingerprint: 'abc123',
        evaluatedAt: '2026-10-15T00:00:00.000Z',
      }],
    })
    assert.match(prompt, /Cycle: 1/)
    assert.match(prompt, /cycle 1 ACCEPTED score=40/)
    assert.match(prompt, /raw JSON only/)
  })
})
