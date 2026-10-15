/**
 * RSI scorer for the heuristic token counter.
 *
 * Runs from the main repository (so its own dependencies resolve) and loads the
 * candidate's counter from `$WEAVE_WORKSPACE` by absolute path. The samples and
 * the reference tokenizer are part of the scoring contract and are never read
 * from the mutated workspace, so a candidate cannot move the goalposts.
 *
 * Prints `{ "score": 100 - MAPE, "passed": bool, "metrics": {...} }`.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAnthropicCountTokens } from '../src/token/anthropic-counter.js'
import { messageTokenText } from '../src/token/render.js'
import type { TokenCounter } from '../src/token/types.js'
import { buildFitSamples, mapeFor } from './token-fit.js'

type CandidateModule = { HeuristicTokenCounter: new () => TokenCounter }

async function loadCandidate(workspaceDir: string): Promise<TokenCounter> {
  const modulePath = path.join(workspaceDir, 'src', 'token', 'heuristic-counter.ts')
  const module = (await import(pathToFileURL(modulePath).href)) as CandidateModule
  if (typeof module.HeuristicTokenCounter !== 'function') {
    throw new Error('Candidate does not export a HeuristicTokenCounter class.')
  }
  return new module.HeuristicTokenCounter()
}

async function main(): Promise<void> {
  const workspaceDir = process.env.WEAVE_WORKSPACE
  if (!workspaceDir) throw new Error('WEAVE_WORKSPACE is required.')
  const countTokens = loadAnthropicCountTokens()
  if (!countTokens) {
    throw new Error('@anthropic-ai/tokenizer is required as the offline reference. Install it first.')
  }

  const samples = buildFitSamples()
  const references = samples.map(message => countTokens(messageTokenText(message)))
  const counter = await loadCandidate(workspaceDir)
  const mape = mapeFor(counter, samples, references)

  process.stdout.write(JSON.stringify({
    score: 100 - mape,
    passed: mape <= 25,
    metrics: { mape: Number(mape.toFixed(4)), samples: samples.length },
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
