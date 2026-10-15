import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CampaignBudget,
  CampaignLimitError,
  DiscoveryTree,
  createCommandScorer,
  extractJsonValue,
  matchGlob,
  normalizeCandidate,
  outOfScopePaths,
  parseCandidateProposals,
  patchFingerprint,
  writeCandidate,
} from '../src/rsi/index.js'

const node = process.execPath

describe('CampaignBudget', () => {
  const limits = {
    maxCycles: 2,
    maxAgentStarts: 1,
    maxEvaluatorRuns: 2,
    deadlineMs: 1000,
    plateauCycles: 1,
    maxCandidatesPerCycle: 1,
    minimumGain: 0,
  }

  it('enforces the cycle limit', () => {
    const budget = new CampaignBudget(limits, 0, () => 0)
    assert.equal(budget.beginCycle(), 1)
    assert.equal(budget.beginCycle(), 2)
    assert.equal(budget.canBeginCycle(), false)
    assert.throws(() => budget.beginCycle(), CampaignLimitError)
  })

  it('enforces the evaluator and agent budgets', () => {
    const budget = new CampaignBudget(limits, 0, () => 0)
    budget.spendEvaluation()
    budget.spendEvaluation()
    assert.equal(budget.canEvaluate(), false)
    assert.throws(() => budget.spendEvaluation(), CampaignLimitError)
    budget.spendAgentStart()
    assert.throws(() => budget.spendAgentStart(), CampaignLimitError)
  })

  it('detects the deadline from the injected clock', () => {
    let now = 0
    const budget = new CampaignBudget({ ...limits, deadlineMs: 50 }, 0, () => now)
    assert.equal(budget.deadlineExceeded(), false)
    now = 60
    assert.equal(budget.deadlineExceeded(), true)
    assert.equal(budget.canBeginCycle(), false)
  })
})

describe('DiscoveryTree', () => {
  it('tracks root, candidates, best and lineage', () => {
    const tree = new DiscoveryTree()
    tree.addRoot({ score: 1, passed: true })
    tree.addCandidate({ id: 'a', parentId: 'root', branch: 1, attempt: 0, rationale: 'a', score: 2, passed: true, accepted: true })
    tree.addCandidate({ id: 'b', parentId: 'a', branch: 1, attempt: 1, rationale: 'b', score: 3, passed: true, accepted: true })
    tree.addCandidate({ id: 'c', parentId: 'a', branch: 2, attempt: 0, rationale: 'c', score: 1, passed: false, accepted: false })
    assert.equal(tree.size, 4)
    assert.equal(tree.best()?.id, 'b')
    assert.deepEqual(tree.frontier().map(n => n.id), ['b', 'c'])
    assert.deepEqual(tree.lineage('b').map(n => n.id), ['root', 'a', 'b'])
    assert.equal(tree.get('missing'), undefined)
  })

  it('rejects duplicate ids and unknown parents, and round-trips', () => {
    const tree = new DiscoveryTree()
    tree.addRoot({ score: 1, passed: true })
    assert.throws(() => tree.addRoot({ score: 1, passed: true }))
    assert.throws(() => tree.addCandidate({ id: 'x', parentId: 'nope', branch: 1, attempt: 0, rationale: 'x', score: 1, passed: true, accepted: false }))
    tree.addCandidate({ id: 'a', parentId: 'root', branch: 1, attempt: 0, rationale: 'a', score: 2, passed: true, accepted: true })
    const restored = DiscoveryTree.fromArray(tree.toArray())
    assert.equal(restored.size, 2)
    assert.equal(restored.best()?.id, 'a')
  })
})

describe('candidate normalization and scope', () => {
  it('fingerprints by content, not order', () => {
    const a = patchFingerprint([{ path: 'b.ts', content: '2' }, { path: 'a.ts', content: '1' }])
    const b = patchFingerprint([{ path: 'a.ts', content: '1' }, { path: 'b.ts', content: '2' }])
    assert.equal(a, b)
    const c = patchFingerprint([{ path: 'a.ts', content: 'changed' }, { path: 'b.ts', content: '2' }])
    assert.notEqual(a, c)
  })

  it('normalizes, dedupes by path and inherits the parent', () => {
    const patch = normalizeCandidate(
      {
        rationale: 'try it',
        files: [
          { path: 'src/a.ts', content: 'one' },
          { path: 'src\\a.ts', content: 'two' },
          { path: 'src/b.ts', content: 'bee' },
        ],
      },
      'root',
    )
    assert.equal(patch.parentId, 'root')
    assert.deepEqual(patch.files.map(f => f.path), ['src/a.ts', 'src/b.ts'])
    assert.equal(patch.files[0]!.content, 'two')
    assert.equal(patch.id, patchFingerprint(patch.files))
  })

  it('matches globs and reports out-of-scope paths', () => {
    assert.ok(matchGlob('src/**/*.ts', 'src/rsi/campaign.ts'))
    assert.ok(matchGlob('src/**', 'src/a/b/c.ts'))
    assert.ok(matchGlob('*.json', 'package.json'))
    assert.ok(matchGlob('src/*.ts', 'src/index.ts'))
    assert.equal(matchGlob('src/*.ts', 'src/rsi/index.ts'), false)
    const patch = normalizeCandidate({ rationale: 'x', files: [{ path: 'src/rsi/a.ts', content: '1' }, { path: 'package.json', content: '2' }] }, null)
    assert.deepEqual(outOfScopePaths(patch, ['src/**/*.ts']), ['package.json'])
  })

  it('writes files inside the workspace and rejects escapes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-write-'))
    try {
      const patch = normalizeCandidate({ rationale: 'x', files: [{ path: 'nested/a.txt', content: 'hello' }] }, null)
      await writeCandidate(dir, patch)
      assert.equal(await readFile(path.join(dir, 'nested/a.txt'), 'utf8'), 'hello')

      const escape = normalizeCandidate({ rationale: 'x', files: [{ path: '../escape.txt', content: 'no' }] }, null)
      await assert.rejects(() => writeCandidate(dir, escape), /escapes the workspace/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('model output parsing', () => {
  it('extracts JSON from fenced and noisy output', () => {
    assert.deepEqual(extractJsonValue('here:\n```json\n{"a":1}\n```\ndone'), { a: 1 })
    assert.deepEqual(extractJsonValue('prefix [1,2] suffix'), [1, 2])
  })

  it('parses arrays, wrappers and single objects', () => {
    assert.equal(parseCandidateProposals('[{"rationale":"r","files":[{"path":"a","content":"1"}]}]').length, 1)
    assert.equal(parseCandidateProposals('{"candidates":[{"rationale":"r","files":[{"path":"a","content":"1"}]}]}').length, 1)
    assert.equal(parseCandidateProposals('{"rationale":"r","files":[{"path":"a","content":"1"}]}').length, 1)
  })
})

describe('createCommandScorer', () => {
  it('reads a score printed to stdout', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-score-'))
    try {
      await writeFile(path.join(dir, 'answer.txt'), '7')
      const scorer = createCommandScorer({
        command: node,
        args: ['-e', "const fs=require('fs');const n=Number(fs.readFileSync('answer.txt','utf8'));process.stdout.write(JSON.stringify({score:n,passed:n>0,metrics:{n}}))"],
      })
      const result = await scorer.run({ workspaceDir: dir })
      assert.equal(result.score, 7)
      assert.equal(result.passed, true)
      assert.equal(result.metrics.n, 7)
      assert.equal(scorer.fingerprint.length, 16)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a score written to $WEAVE_SCORE_FILE', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-score-'))
    try {
      const scorer = createCommandScorer({
        command: node,
        args: ['-e', "require('fs').writeFileSync(process.env.WEAVE_SCORE_FILE, JSON.stringify({score:3}))"],
      })
      const result = await scorer.run({ workspaceDir: dir })
      assert.equal(result.score, 3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a parsed score even when the command exits non-zero', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-score-'))
    try {
      const scorer = createCommandScorer({
        command: node,
        args: ['-e', "console.log(JSON.stringify({score:2}));process.exit(1)"],
      })
      const result = await scorer.run({ workspaceDir: dir })
      assert.equal(result.score, 2)
      assert.equal(result.passed, false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('honors the cwd override while still exposing the workspace', async () => {
    const runnerDir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-runner-'))
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-ws-'))
    try {
      const scorer = createCommandScorer({
        command: node,
        args: ['-e', "process.stdout.write(JSON.stringify({score: process.cwd()===process.env.EXPECT_CWD && process.env.WEAVE_WORKSPACE ? 1 : 0}))"],
        env: { EXPECT_CWD: runnerDir },
        cwd: runnerDir,
      })
      const result = await scorer.run({ workspaceDir })
      assert.equal(result.score, 1)
    } finally {
      await rm(runnerDir, { recursive: true, force: true })
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  it('throws when no score is produced', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-score-'))
    try {
      const scorer = createCommandScorer({ command: node, args: ['-e', "console.error('boom');process.exit(2)"] })
      await assert.rejects(() => scorer.run({ workspaceDir: dir }), /no score/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
