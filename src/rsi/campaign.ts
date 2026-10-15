import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Archive } from './archive.js'
import { CampaignBudget } from './budget.js'
import { normalizeCandidate, outOfScopePaths, writeCandidate } from './candidate.js'
import { DiscoveryTree } from './tree.js'
import { WorkspaceManager, type WorkspaceHandle } from './workspace.js'
import {
  DEFAULT_CAMPAIGN_LIMITS,
  ROOT_NODE_ID,
  campaignLimitsSchema,
  type CandidateFile,
  type CandidatePatch,
  type CampaignLimits,
  type CampaignResult,
  type EvaluationRecord,
  type Mutator,
  type RsiEvent,
  type RsiStopReason,
  type ScoreResult,
  type Scorer,
} from './types.js'

export type RsiCampaignOptions = {
  repoDir: string
  /** Globs the mutator is allowed to change. Everything else is discarded. */
  mutableFiles: readonly string[]
  /**
   * Starting contents of the mutable files. Model-driven mutators need this to
   * see the seed harness before anything has been accepted.
   */
  seedFiles?: readonly CandidateFile[]
  scorer: Scorer
  mutator: Mutator
  /** Disposable worktrees land here. Defaults to an OS temp directory. */
  scratchDir?: string
  campaignId?: string
  limits?: Partial<CampaignLimits>
  /** JSONL lineage log. Omit to keep the archive in memory. */
  archivePath?: string
  /** Commit accepted candidates to a `rsi/<id>` branch. Defaults to true. */
  commitAccepted?: boolean
  onEvent?: (event: RsiEvent) => void
  signal?: AbortSignal
  now?: () => number
}

/** Merge a candidate's files into the current best-variant file set. */
function mergeFiles(base: readonly CandidateFile[], patch: readonly CandidateFile[]): CandidateFile[] {
  const byPath = new Map(base.map(file => [file.path, file] as const))
  for (const file of patch) byPath.set(file.path, file)
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Bounded RSI campaign.
 *
 * 1. Score the unchanged harness twice (baseline + consistency check).
 * 2. Each cycle: ask the mutator for candidates, evaluate each inside its own
 *    git worktree with the frozen scorer, keep the best if it beats the current
 *    champion by `minimumGain`.
 * 3. Accepted candidates are committed to a campaign branch, so later cycles
 *    refine the champion rather than restarting from the baseline.
 * 4. Stop on plateau, cycle/evaluator/agent budget, deadline, or abort.
 */
export class RsiCampaign {
  constructor(private readonly options: RsiCampaignOptions) {}

  async run(): Promise<CampaignResult> {
    const limits = campaignLimitsSchema.parse({ ...DEFAULT_CAMPAIGN_LIMITS, ...this.options.limits })
    if (limits.maxEvaluatorRuns < 2) {
      throw new Error('RSI needs at least two evaluator runs for the baseline consistency check.')
    }
    if (this.options.mutableFiles.length === 0) {
      throw new Error('RSI needs a non-empty mutable file scope.')
    }
    const { repoDir, scorer, mutator, signal } = this.options
    const emit = (event: RsiEvent): void => { this.options.onEvent?.(event) }
    const campaignId = this.options.campaignId ?? randomUUID().slice(0, 8)
    const commitAccepted = this.options.commitAccepted ?? true
    const branch = commitAccepted ? `rsi/${campaignId}` : null
    const scratchDir = this.options.scratchDir ?? path.join(os.tmpdir(), `weave-rsi-${campaignId}`)
    const budget = new CampaignBudget(limits, Date.now(), this.options.now)
    const tree = new DiscoveryTree()
    const archive = new Archive(this.options.archivePath)
    await archive.load()
    const workspaces = new WorkspaceManager({ repoDir, scratchDir, baseRef: 'HEAD', branch: branch ?? undefined })

    const records: EvaluationRecord[] = []
    const evaluated = new Set<string>()
    let evaluations = 0
    let cycles = 0
    let baselineScore = 0
    let baselineConsistent = true
    let acceptedCount = 0
    let plateau = 0
    const seedFiles = (this.options.seedFiles ?? []).map(file => ({ ...file }))
    let best = { nodeId: ROOT_NODE_ID, score: 0, rationale: 'baseline', files: seedFiles.map(file => ({ ...file })) }
    let stopReason: RsiStopReason = 'max_cycles'

    let champion: WorkspaceHandle | undefined
    await workspaces.prepare()
    try {
      const rootWorkspace = await workspaces.create(ROOT_NODE_ID)
      let first
      let second
      try {
        budget.spendEvaluation(); evaluations += 1
        first = await scorer.run({ workspaceDir: rootWorkspace.dir, signal })
        budget.spendEvaluation(); evaluations += 1
        second = await scorer.run({ workspaceDir: rootWorkspace.dir, signal })
      } finally {
        await workspaces.dispose(rootWorkspace)
      }
      baselineScore = Math.max(first.score, second.score)
      baselineConsistent = first.score === second.score
      best = { nodeId: ROOT_NODE_ID, score: baselineScore, rationale: 'baseline', files: seedFiles.map(file => ({ ...file })) }
      tree.addRoot({ score: baselineScore, passed: second.passed })
      emit({ type: 'baseline', nodeId: ROOT_NODE_ID, score: baselineScore, consistent: baselineConsistent })

      while (budget.canBeginCycle() && plateau < limits.plateauCycles) {
        if (signal?.aborted) { stopReason = 'aborted'; break }
        const cycle = budget.beginCycle()
        cycles = cycle
        emit({ type: 'cycle_start', cycle, bestScore: best.score })

        if (!budget.canStartAgent()) { stopReason = budget.deadlineExceeded() ? 'deadline' : 'budget'; break }
        budget.spendAgentStart()
        const proposals = await mutator.propose(
          { cycle, scorerFingerprint: scorer.fingerprint, best: { ...best, files: best.files.map(file => ({ ...file })) }, history: records },
          signal,
        )
        if (signal?.aborted) { stopReason = 'aborted'; break }

        const patches = this.normalize(proposals, best.nodeId)
        for (const patch of patches.slice(0, limits.maxCandidatesPerCycle)) {
          emit({ type: 'candidate_proposed', cycle, patchId: patch.id, rationale: patch.rationale })
        }
        if (patches.length === 0) { plateau += 1; continue }

        // Every candidate is measured against the same cycle-start champion.
        const cycleStart = best
        const entries: Array<{ patch: CandidatePatch; record: EvaluationRecord; attempt: number }> = []
        let attempt = 0
        cycleLoop: for (const patch of patches.slice(0, limits.maxCandidatesPerCycle)) {
          if (signal?.aborted) { stopReason = 'aborted'; break cycleLoop }
          if (evaluated.has(patch.id)) {
            emit({ type: 'candidate_skipped_duplicate', cycle, patchId: patch.id })
            continue
          }
          const offending = outOfScopePaths(patch, this.options.mutableFiles)
          if (offending.length > 0) {
            emit({ type: 'candidate_skipped_scope', cycle, patchId: patch.id, paths: offending })
            continue
          }
          if (!budget.canEvaluate()) { stopReason = budget.deadlineExceeded() ? 'deadline' : 'budget'; break cycleLoop }

          budget.spendEvaluation(); evaluations += 1
          const workspace = await workspaces.create(patch.id)
          let score: ScoreResult | undefined
          let failure: string | undefined
          try {
            await writeCandidate(workspace.dir, patch)
            score = await scorer.run({ workspaceDir: workspace.dir, signal })
          } catch (error) {
            // A candidate that does not build or run is ordinary evidence, not a
            // reason to abort the whole campaign.
            failure = error instanceof Error ? error.message : String(error)
          } finally {
            await workspaces.dispose(workspace)
          }
          evaluated.add(patch.id)

          const record: EvaluationRecord = score
            ? {
                cycle,
                nodeId: patch.id,
                patchId: patch.id,
                parentId: cycleStart.nodeId,
                rationale: patch.rationale,
                score: score.score,
                passed: score.passed,
                metrics: score.metrics,
                accepted: false,
                improvement: score.score - cycleStart.score,
                scorerFingerprint: scorer.fingerprint,
                evaluatedAt: new Date().toISOString(),
              }
            : {
                cycle,
                nodeId: patch.id,
                patchId: patch.id,
                parentId: cycleStart.nodeId,
                rationale: patch.rationale,
                score: cycleStart.score,
                passed: false,
                metrics: {},
                accepted: false,
                improvement: 0,
                error: failure ?? 'Scorer failed.',
                scorerFingerprint: scorer.fingerprint,
                evaluatedAt: new Date().toISOString(),
              }
          entries.push({ patch, record, attempt })
          attempt += 1
        }

        // One promotion per cycle (Darwin-Godel / Dream-RSI style): the best
        // candidate wins, everything else is discarded. Accepting several whole-
        // file candidates from one cycle would let a later rewrite silently
        // clobber an earlier acceptance, so we never do that.
        let promoted: (typeof entries)[number] | undefined
        for (const entry of entries) {
          if (entry.record.error) continue
          if (!promoted || entry.record.score > promoted.record.score) promoted = entry
        }
        if (promoted && !(promoted.record.score > cycleStart.score * (1 + limits.minimumGain))) {
          promoted = undefined
        }
        if (promoted) promoted.record.accepted = true

        const bestScoreAfterCycle = promoted ? promoted.record.score : cycleStart.score
        for (const entry of entries) {
          tree.addCandidate({
            id: entry.patch.id,
            parentId: cycleStart.nodeId,
            branch: cycle,
            attempt: entry.attempt,
            rationale: entry.patch.rationale,
            score: entry.record.score,
            passed: entry.record.passed,
            accepted: entry.record.accepted,
          })
          records.push(entry.record)
          if (entry.record.error) {
            emit({ type: 'candidate_failed', cycle, patchId: entry.patch.id, error: entry.record.error })
          } else {
            emit({ type: 'candidate_evaluated', record: entry.record })
          }
          await archive.append({ ...entry.record, campaignId, branch, bestScoreAfter: bestScoreAfterCycle })
        }

        if (promoted) {
          best = {
            nodeId: promoted.patch.id,
            score: promoted.record.score,
            rationale: promoted.patch.rationale,
            files: mergeFiles(best.files, promoted.patch.files),
          }
          acceptedCount += 1
          if (branch) {
            // Create the campaign branch lazily: a run that accepts nothing
            // should not leave an empty branch behind.
            champion ??= await workspaces.champion()
            await workspaces.commitAccepted(champion, promoted.patch, `rsi(${campaignId}): ${promoted.patch.rationale}`)
          }
          emit({ type: 'candidate_accepted', record: promoted.record, branch })
        }
        plateau = promoted ? 0 : plateau + 1
      }

      if (signal?.aborted) stopReason = 'aborted'
      else if (plateau >= limits.plateauCycles) stopReason = 'plateau'
      else if (budget.deadlineExceeded()) stopReason = 'deadline'
      else if (!budget.canEvaluate() || !budget.canStartAgent()) stopReason = 'budget'
      else stopReason = 'max_cycles'

      const result: CampaignResult = {
        campaignId,
        branch,
        scorerFingerprint: scorer.fingerprint,
        baselineScore,
        baselineConsistent,
        bestScore: best.score,
        acceptedCount,
        evaluations,
        cycles,
        stopReason,
        tree: tree.toArray(),
        records,
      }
      emit({ type: 'campaign_end', result })
      return result
    } finally {
      await workspaces.removeAll()
    }
  }

  private normalize(proposals: readonly unknown[], parentId: string): CandidatePatch[] {
    const patches: CandidatePatch[] = []
    for (const proposal of proposals) {
      try {
        patches.push(normalizeCandidate(proposal, parentId))
      } catch {
        // A malformed proposal is dropped; the campaign should not die on it.
      }
    }
    return patches
  }
}
