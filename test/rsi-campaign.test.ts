import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  RsiCampaign,
  StaticMutator,
  createCommandScorer,
  runGit,
  type CandidateFile,
  type CandidateProposal,
  type MutationContext,
  type Mutator,
  type RsiEvent,
  type Scorer,
} from '../src/rsi/index.js'

const node = process.execPath
const scoreScript =
  "const fs=require('fs');const n=Number(fs.readFileSync('answer.txt','utf8').trim());process.stdout.write(JSON.stringify({score:n,passed:n>=3}))"

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-repo-'))
  await writeFile(path.join(dir, 'answer.txt'), '1')
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'rsi@test.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'RSI Test'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function scriptedMutator(context: MutationContext): CandidateProposal[] {
  if (context.cycle === 1) {
    return [
      { rationale: 'raise answer to 2', files: [{ path: 'answer.txt', content: '2' }] },
      { rationale: 'raise answer to 3', files: [{ path: 'answer.txt', content: '3' }] },
    ]
  }
  if (context.cycle === 2) {
    return [
      { rationale: 'raise answer to 4', files: [{ path: 'answer.txt', content: '4' }] },
      { rationale: 're-propose the old 2', files: [{ path: 'answer.txt', content: '2' }] },
    ]
  }
  if (context.cycle === 3) {
    return [{ rationale: 'touch an immutable file', files: [{ path: 'src/other.ts', content: 'x' }] }]
  }
  return []
}

describe('RsiCampaign end to end', () => {
  let repoDir: string

  before(async () => { repoDir = await makeRepo() })
  after(async () => { await rm(repoDir, { recursive: true, force: true }) })

  it('compounds accepted improvements on a branch without touching the working tree', async () => {
    const archiveDir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-archive-'))
    const archivePath = path.join(archiveDir, 'lineage.jsonl')
    const events: RsiEvent[] = []
    try {
      const campaign = new RsiCampaign({
        repoDir,
        mutableFiles: ['answer.txt'],
        scorer: createCommandScorer({ command: node, args: ['-e', scoreScript] }),
        mutator: new StaticMutator(scriptedMutator),
        archivePath,
        limits: {
          maxCycles: 6,
          maxAgentStarts: 6,
          maxEvaluatorRuns: 20,
          deadlineMs: 60_000,
          plateauCycles: 2,
          maxCandidatesPerCycle: 3,
          minimumGain: 0,
        },
        onEvent: event => events.push(event),
      })

      const result = await campaign.run()

      // Baseline is 1. Cycle 1 evaluates '2' and '3' against that baseline and
      // promotes only the best of the two, so the champion is 3 -> 4.
      assert.equal(result.baselineScore, 1)
      assert.equal(result.baselineConsistent, true)
      assert.equal(result.bestScore, 4)
      assert.equal(result.acceptedCount, 2)
      assert.equal(result.stopReason, 'plateau')
      assert.equal(result.cycles, 4)
      // 2 baseline runs + 3 evaluated candidates (2, 3, 4); the duplicate and the
      // out-of-scope proposal never reach the scorer.
      assert.equal(result.evaluations, 5)
      assert.equal(result.records.length, 3)
      assert.equal(result.records.filter(record => record.accepted).length, 2)
      assert.notEqual(result.branch, null)

      // The user's working tree is untouched.
      assert.equal(await readFile(path.join(repoDir, 'answer.txt'), 'utf8'), '1')
      assert.equal(await readFile(path.join(repoDir, '.gitignore'), 'utf8'), 'node_modules/\n')

      // Accepted changes are committed on the campaign branch.
      const count = await runGit(repoDir, ['rev-list', '--count', result.branch!])
      assert.equal(count.stdout.trim(), '3')
      const champion = await runGit(repoDir, ['show', `${result.branch}:answer.txt`])
      assert.equal(champion.stdout.trim(), '4')

      // The lineage log has one line per evaluated candidate.
      const lines = (await readFile(archivePath, 'utf8')).trim().split('\n')
      assert.equal(lines.length, 3)

      // The tree records the accepted chain.
      assert.equal(result.tree.length, 4)
      assert.equal(result.tree.filter(node => node.accepted && node.parentId !== null).length, 2)

      const kinds = new Set(events.map(event => event.type))
      assert.ok(kinds.has('candidate_skipped_duplicate'))
      assert.ok(kinds.has('candidate_skipped_scope'))
      assert.ok(kinds.has('candidate_accepted'))
    } finally {
      await rm(archiveDir, { recursive: true, force: true })
    }
  })
})

describe('RsiCampaign resilience', () => {
  let repoDir: string

  before(async () => { repoDir = await makeRepo() })
  after(async () => { await rm(repoDir, { recursive: true, force: true }) })

  it('records a failed evaluation and keeps the campaign alive', async () => {
    let calls = 0
    const scorer: Scorer = {
      fingerprint: 'fails-after-baseline',
      async run() {
        calls += 1
        if (calls <= 2) return { score: 1, passed: true, metrics: {}, durationMs: 0 }
        throw new Error('candidate exploded')
      },
    }
    const result = await new RsiCampaign({
      repoDir,
      mutableFiles: ['answer.txt'],
      scorer,
      mutator: new StaticMutator(() => [{ rationale: 'break it', files: [{ path: 'answer.txt', content: '9' }] }]),
      commitAccepted: false,
      limits: { maxCycles: 3, maxAgentStarts: 3, maxEvaluatorRuns: 6, deadlineMs: 60_000, plateauCycles: 1, maxCandidatesPerCycle: 1, minimumGain: 0 },
    }).run()

    assert.equal(result.acceptedCount, 0)
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0]!.error, 'candidate exploded')
    assert.equal(result.stopReason, 'plateau')
    assert.equal(await readFile(path.join(repoDir, 'answer.txt'), 'utf8'), '1')
  })

  it('passes seed files to the mutator before any acceptance', async () => {
    let captured: CandidateFile[] = []
    const result = await new RsiCampaign({
      repoDir,
      mutableFiles: ['answer.txt'],
      commitAccepted: false,
      seedFiles: [{ path: 'answer.txt', content: '1' }],
      scorer: { fingerprint: 'fixed', async run() { return { score: 1, passed: true, metrics: {}, durationMs: 0 } } },
      mutator: new StaticMutator(context => { captured = context.best.files; return [] }),
      limits: { maxCycles: 2, maxAgentStarts: 2, maxEvaluatorRuns: 4, deadlineMs: 60_000, plateauCycles: 1, maxCandidatesPerCycle: 1, minimumGain: 0 },
    }).run()

    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.path, 'answer.txt')
    assert.equal(captured[0]!.content, '1')
    assert.equal(result.stopReason, 'plateau')
  })

  it('promotes only the best candidate of a cycle and uses it as the next base', async () => {
    const seenBases: string[] = []
    const scorer: Scorer = {
      fingerprint: 'content-length',
      async run({ workspaceDir }) {
        const content = await readFile(path.join(workspaceDir, 'answer.txt'), 'utf8')
        return { score: content.length, passed: true, metrics: {}, durationMs: 0 }
      },
    }
    const mutator: Mutator = {
      async propose(context) {
        seenBases.push(context.best.files[0]?.content ?? '')
        if (context.cycle !== 1) return []
        return [
          { rationale: 'longer wins', files: [{ path: 'answer.txt', content: 'AAAA' }] },
          { rationale: 'shorter loses', files: [{ path: 'answer.txt', content: 'BB' }] },
        ]
      },
    }
    const result = await new RsiCampaign({
      repoDir,
      mutableFiles: ['answer.txt'],
      seedFiles: [{ path: 'answer.txt', content: '1' }],
      scorer,
      mutator,
      commitAccepted: false,
      limits: { maxCycles: 2, maxAgentStarts: 2, maxEvaluatorRuns: 4, deadlineMs: 60_000, plateauCycles: 1, maxCandidatesPerCycle: 2, minimumGain: 0 },
    }).run()

    // 'AAAA' (4) beats 'BB' (2); exactly one candidate is promoted.
    assert.equal(result.acceptedCount, 1)
    assert.equal(result.bestScore, 4)
    assert.equal(result.records.filter(record => record.accepted).length, 1)
    assert.equal(result.records.find(record => record.accepted)!.score, 4)
    // Cycle 2 must observe the promoted winner, not the last-evaluated loser.
    assert.equal(seenBases[0], '1')
    assert.equal(seenBases[1], 'AAAA')
  })
})
