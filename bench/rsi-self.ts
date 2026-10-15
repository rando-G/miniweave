/**
 * Offline RSI on MiniWeave itself.
 *
 *   npm run bench:rsi:self
 *
 * Mutable surface : the `CHARS_PER_TOKEN` ratio table in
 *                   `src/token/heuristic-counter.ts`.
 * Fitness         : `100 - MAPE` of the candidate heuristic against the official
 *                   Anthropic tokenizer on a frozen sample set.
 * Mutator         : a dumb local search (perturb one role at a time, two
 *                   directions, decreasing step). It has no access to the
 *                   reference counts, so any gain comes from the campaign
 *                   selecting candidates, not from an oracle.
 *
 * Fully offline: no model, no network. Accepted changes land on a `rsi/<id>`
 * branch; the working tree and current branch are never touched.
 * Inspect the result with `git log --oneline rsi/<id>` and `git diff main rsi/<id>`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RsiCampaign,
  createCommandScorer,
  type CandidateProposal,
  type MutationContext,
  type Mutator,
  type RsiEvent,
} from '../src/rsi/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(here, '..')
const scorerScript = path.join(here, 'rsi-token-score.ts')
const MUTABLE_FILE = 'src/token/heuristic-counter.ts'

function parseRatios(source: string): Record<string, number> {
  const table = /export const CHARS_PER_TOKEN: Record<string, number> = \{([\s\S]*?)\n\}/.exec(source)
  if (!table) throw new Error('CHARS_PER_TOKEN table not found in the seed file.')
  const ratios: Record<string, number> = {}
  for (const match of table[1]!.matchAll(/([A-Za-z_]\w*):\s*([\d.]+)/g)) {
    ratios[match[1]!] = Number(match[2])
  }
  return ratios
}

function renderRatios(original: string, ratios: Record<string, number>): string {
  const entries = Object.entries(ratios).map(([role, value]) => `  ${role}: ${value},`).join('\n')
  const next = original.replace(
    /(export const CHARS_PER_TOKEN: Record<string, number> = \{)[\s\S]*?(\n\})/,
    `$1\n${entries}$2`,
  )
  if (next === original) throw new Error('Could not rewrite the CHARS_PER_TOKEN table.')
  return next
}

class RatioTableMutator implements Mutator {
  constructor(private readonly original: string) {}

  async propose(context: MutationContext): Promise<CandidateProposal[]> {
    const source = context.best.files[0]?.content ?? this.original
    const ratios = parseRatios(source)
    const roles = Object.keys(ratios)
    if (roles.length === 0) return []

    const step = context.cycle <= 2 ? 0.5 : context.cycle <= 4 ? 0.3 : context.cycle <= 7 ? 0.15 : 0.08
    const windowSize = 3
    const start = ((context.cycle - 1) * windowSize) % roles.length
    const selected = Array.from(
      { length: Math.min(windowSize, roles.length) },
      (_, index) => roles[(start + index) % roles.length]!,
    )

    const proposals: CandidateProposal[] = []
    for (const role of selected) {
      for (const delta of [step, -step]) {
        const value = Math.max(0.5, Math.round((ratios[role]! + delta) * 100) / 100)
        if (value === ratios[role]) continue
        proposals.push({
          rationale: `${role}: ${ratios[role]} -> ${value}`,
          files: [{ path: MUTABLE_FILE, content: renderRatios(this.original, { ...ratios, [role]: value }) }],
        })
      }
    }
    return proposals
  }
}

function describe(event: RsiEvent): string | null {
  switch (event.type) {
    case 'baseline':
      return `baseline score=${event.score.toFixed(2)} (consistent=${event.consistent})`
    case 'cycle_start':
      return `\ncycle ${event.cycle} — best=${event.bestScore.toFixed(2)}`
    case 'candidate_proposed':
      return `  propose ${event.rationale}`
    case 'candidate_evaluated': {
      const mape = event.record.metrics.mape
      const tag = event.record.accepted ? 'ACCEPT' : 'reject'
      return `  ${tag} score=${event.record.score.toFixed(2)} mape=${mape?.toFixed(2) ?? 'n/a'} (${event.record.improvement >= 0 ? '+' : ''}${event.record.improvement.toFixed(2)})`
    }
    case 'candidate_failed':
      return `  FAILED ${event.patchId}: ${event.error.slice(0, 80)}`
    case 'candidate_skipped_duplicate':
      return `  skip ${event.patchId}: duplicate`
    case 'candidate_skipped_scope':
      return `  skip ${event.patchId}: out of scope`
    default:
      return null
  }
}

async function main(): Promise<void> {
  const original = readFileSync(path.join(repoDir, MUTABLE_FILE), 'utf8')
  const result = await new RsiCampaign({
    repoDir,
    mutableFiles: [MUTABLE_FILE],
    seedFiles: [{ path: MUTABLE_FILE, content: original }],
    scorer: createCommandScorer({
      command: process.execPath,
      args: ['--import', 'tsx', scorerScript],
      cwd: repoDir,
      timeoutMs: 120_000,
    }),
    mutator: new RatioTableMutator(original),
    limits: {
      maxCycles: 12,
      maxAgentStarts: 24,
      maxEvaluatorRuns: 80,
      deadlineMs: 10 * 60 * 1000,
      plateauCycles: 3,
      maxCandidatesPerCycle: 6,
      minimumGain: 0,
    },
    onEvent: event => {
      const line = describe(event)
      if (line) console.log(line)
    },
  }).run()

  console.log('\n--- RSI result ---')
  console.log(`heuristic MAPE ${(100 - result.baselineScore).toFixed(2)}% -> ${(100 - result.bestScore).toFixed(2)}%`)
  console.log(`accepted=${result.acceptedCount} evaluations=${result.evaluations} cycles=${result.cycles} stop=${result.stopReason}`)
  console.log(`champion branch: ${result.branch}`)
  console.log(`inspect: git diff main ${result.branch} -- ${MUTABLE_FILE}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
