/**
 * Offline RSI demo.
 *
 *   npm run bench:rsi
 *
 * Builds a throwaway git repository whose "harness" is a single number in
 * `metric.txt`, then runs a bounded campaign. The mutator raises the number,
 * re-proposes an old candidate (deduped), and proposes an out-of-scope file
 * (skipped), so the printed lineage shows accept / reject / skip side by side.
 *
 * No model and no network are involved: this exercises the same engine the
 * model-driven mutator plugs into.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  RsiCampaign,
  StaticMutator,
  createCommandScorer,
  type CandidateProposal,
  type MutationContext,
  type RsiEvent,
} from '../src/rsi/index.js'

const nodeExec = process.execPath
const scoreScript =
  "const fs=require('fs');const n=Number(fs.readFileSync('metric.txt','utf8').trim());process.stdout.write(JSON.stringify({score:n,passed:n>=3,metrics:{value:n}}))"

async function makePlayground(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-rsi-demo-'))
  await writeFile(path.join(dir, 'metric.txt'), '1')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'demo@miniweave.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'MiniWeave Demo'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'seed harness'], { cwd: dir })
  return dir
}

function planNext(context: MutationContext): CandidateProposal[] {
  const next = context.best.score + 1
  const proposals: CandidateProposal[] = [
    { rationale: `raise metric ${context.best.score} -> ${next}`, files: [{ path: 'metric.txt', content: String(next) }] },
  ]
  if (context.cycle === 2) {
    proposals.push({ rationale: 'regress on purpose (expected: rejected)', files: [{ path: 'metric.txt', content: '1' }] })
  }
  if (context.cycle === 3) {
    proposals.push({ rationale: 'edit an immutable file (expected: skipped)', files: [{ path: 'README.md', content: 'nope' }] })
  }
  return proposals
}

function describe(event: RsiEvent): string | null {
  switch (event.type) {
    case 'baseline': return `baseline score=${event.score} (consistent=${event.consistent})`
    case 'cycle_start': return `\ncycle ${event.cycle} — best=${event.bestScore}`
    case 'candidate_proposed': return `  propose ${event.patchId}: ${event.rationale}`
    case 'candidate_skipped_duplicate': return `  skip ${event.patchId}: duplicate`
    case 'candidate_skipped_scope': return `  skip ${event.patchId}: out of scope (${event.paths.join(', ')})`
    case 'candidate_evaluated': return `  ${event.record.accepted ? 'ACCEPT' : 'reject'} ${event.record.patchId} score=${event.record.score} (${event.record.improvement >= 0 ? '+' : ''}${event.record.improvement})`
    default: return null
  }
}

async function main(): Promise<void> {
  const repoDir = await makePlayground()
  try {
    const result = await new RsiCampaign({
      repoDir,
      mutableFiles: ['metric.txt'],
      scorer: createCommandScorer({ command: nodeExec, args: ['-e', scoreScript] }),
      mutator: new StaticMutator(planNext),
      limits: { maxCycles: 6, maxAgentStarts: 6, maxEvaluatorRuns: 20, plateauCycles: 2, maxCandidatesPerCycle: 3 },
      onEvent: event => {
        const line = describe(event)
        if (line) console.log(line)
      },
    }).run()

    console.log('\n--- campaign result ---')
    console.log(`baseline ${result.baselineScore} -> best ${result.bestScore} in ${result.cycles} cycles`)
    console.log(`accepted=${result.acceptedCount} evaluations=${result.evaluations} stop=${result.stopReason}`)
    console.log(`champion branch: ${result.branch} (inspect with: git log --oneline ${result.branch})`)
    console.log('\ndiscovery tree:')
    for (const node of result.tree) {
      console.log(`  ${node.accepted ? '✓' : '·'} ${node.id} score=${node.score} parent=${node.parentId ?? '-'} :: ${node.rationale}`)
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
