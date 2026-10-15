/**
 * Model-driven RSI on MiniWeave itself.
 *
 *   npm run bench:rsi:model
 *
 * Same target and scorer as `bench:rsi:self`, but the candidate proposer is a
 * real model (`ModelMutator` over the configured Anthropic-compatible adapter)
 * instead of a scripted local search. The model sees the current best
 * `src/token/heuristic-counter.ts`, proposes full-file rewrites, and the
 * campaign keeps only the ones that lower the token-counter MAPE.
 *
 * Requires model credentials (same config as the CLI). Set
 * `MINI_CODE_MODEL_MODE=mock` to only exercise the plumbing offline.
 *
 * Accepted changes land on a `rsi/<id>` branch; the working tree is untouched.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { loadRuntimeConfig } from '../src/config.js'
import { MockModelAdapter } from '../src/mock-model.js'
import { ToolRegistry } from '../src/tool.js'
import {
  ModelMutator,
  RsiCampaign,
  createCommandScorer,
  type RsiEvent,
} from '../src/rsi/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(here, '..')
const scorerScript = path.join(here, 'rsi-token-score.ts')
const MUTABLE_FILE = 'src/token/heuristic-counter.ts'
const useMock = process.env.MINI_CODE_MODEL_MODE === 'mock'

function describe(event: RsiEvent): string | null {
  switch (event.type) {
    case 'baseline':
      return `baseline score=${event.score.toFixed(2)} (consistent=${event.consistent})`
    case 'cycle_start':
      return `\ncycle ${event.cycle} — best=${event.bestScore.toFixed(2)}`
    case 'candidate_proposed':
      return `  propose ${event.patchId}: ${event.rationale}`
    case 'candidate_evaluated': {
      const mape = event.record.metrics.mape
      const tag = event.record.accepted ? 'ACCEPT' : 'reject'
      return `  ${tag} score=${event.record.score.toFixed(2)} mape=${mape?.toFixed(2) ?? 'n/a'} :: ${event.record.rationale}`
    }
    case 'candidate_failed':
      return `  FAILED ${event.patchId}: ${event.error.slice(0, 100)}`
    case 'candidate_skipped_duplicate':
      return `  skip ${event.patchId}: duplicate`
    case 'candidate_skipped_scope':
      return `  skip ${event.patchId}: out of scope (${event.paths.join(', ')})`
    default:
      return null
  }
}

async function main(): Promise<void> {
  if (!useMock) {
    try {
      await loadRuntimeConfig()
    } catch (error) {
      console.error('No model configured. Set MINIWEAVE_BASE_URL / MINIWEAVE_AUTH_TOKEN (or ~/.mini-code/settings.json),')
      console.error('or run with MINI_CODE_MODEL_MODE=mock to check the plumbing without a model.')
      console.error(`Details: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return
    }
  }

  const seed = readFileSync(path.join(repoDir, MUTABLE_FILE), 'utf8')
  const model = useMock
    ? new MockModelAdapter()
    : new AnthropicModelAdapter(new ToolRegistry([]), loadRuntimeConfig)

  const result = await new RsiCampaign({
    repoDir,
    mutableFiles: [MUTABLE_FILE],
    seedFiles: [{ path: MUTABLE_FILE, content: seed }],
    scorer: createCommandScorer({
      command: process.execPath,
      args: ['--import', 'tsx', scorerScript],
      cwd: repoDir,
      timeoutMs: 120_000,
    }),
    mutator: new ModelMutator({
      model,
      maxCandidates: 2,
      maxFileChars: 12_000,
      onParseError: (error, raw) => {
        console.error(`[mutator] could not parse model output (${error.message}); first 200 chars: ${raw.slice(0, 200)}`)
      },
    }),
    limits: {
      maxCycles: 4,
      maxAgentStarts: 8,
      maxEvaluatorRuns: 20,
      deadlineMs: 20 * 60 * 1000,
      plateauCycles: 2,
      maxCandidatesPerCycle: 2,
      minimumGain: 0,
    },
    onEvent: event => {
      const line = describe(event)
      if (line) console.log(line)
    },
  }).run()

  console.log('\n--- model-driven RSI result ---')
  console.log(`heuristic MAPE ${(100 - result.baselineScore).toFixed(2)}% -> ${(100 - result.bestScore).toFixed(2)}%`)
  console.log(`accepted=${result.acceptedCount} evaluations=${result.evaluations} cycles=${result.cycles} stop=${result.stopReason}`)
  if (result.acceptedCount > 0) {
    console.log(`champion branch: ${result.branch}`)
    console.log(`inspect: git diff main ${result.branch} -- ${MUTABLE_FILE}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
