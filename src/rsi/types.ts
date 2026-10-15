import { z } from 'zod'

/**
 * Recursive Self-Improvement (RSI) core contracts.
 *
 * The design borrows three ideas from public RSI work:
 * - Darwin Godel Machine: an archive of accepted variants and an outer
 *   generation loop that only keeps benchmark-verified changes.
 * - Godel Agent: the mutable surface is harness code, addressed by explicit
 *   read/propose/evaluate actions rather than free-form editing.
 * - pi-Dream-RSI: a bounded campaign (hard budgets + plateau stop) and a
 *   scoring contract that must stay outside the mutated workspace.
 *
 * MiniWeave's engine is intentionally small and dependency-injected so the
 * whole loop can be unit tested without a model or a network.
 */

export const candidateFileSchema = z.object({
  /** Repository-relative path. Absolute paths and `..` are rejected later. */
  path: z.string().trim().min(1),
  content: z.string(),
})
export type CandidateFile = z.infer<typeof candidateFileSchema>

export const candidateProposalSchema = z.object({
  parentId: z.string().trim().min(1).nullable().optional(),
  rationale: z.string().trim().min(1),
  files: z.array(candidateFileSchema).min(1),
})
export type CandidateProposal = z.infer<typeof candidateProposalSchema>

/** A normalized proposal. `id` is the content fingerprint, not a model-provided name. */
export type CandidatePatch = {
  id: string
  parentId: string | null
  rationale: string
  files: CandidateFile[]
}

export const campaignLimitsSchema = z.object({
  /** Maximum discovery cycles. */
  maxCycles: z.number().int().positive(),
  /** Maximum mutator (agent) invocations. */
  maxAgentStarts: z.number().int().nonnegative(),
  /** Maximum scorer runs, including the two baseline measurements. */
  maxEvaluatorRuns: z.number().int().nonnegative(),
  /** Wall-clock cap for the whole campaign. */
  deadlineMs: z.number().int().positive(),
  /** Stop after this many consecutive cycles without an accepted gain. */
  plateauCycles: z.number().int().nonnegative(),
  /** Cap on candidates evaluated per cycle. */
  maxCandidatesPerCycle: z.number().int().positive(),
  /** Relative gain required to accept: score > best * (1 + minimumGain). */
  minimumGain: z.number().min(0),
})
export type CampaignLimits = z.infer<typeof campaignLimitsSchema>

export const DEFAULT_CAMPAIGN_LIMITS: CampaignLimits = {
  maxCycles: 5,
  maxAgentStarts: 10,
  maxEvaluatorRuns: 30,
  deadlineMs: 30 * 60 * 1000,
  plateauCycles: 2,
  maxCandidatesPerCycle: 3,
  minimumGain: 0,
}

export type ScoreResult = {
  score: number
  passed: boolean
  metrics: Record<string, number>
  durationMs: number
}

export type ScoreContext = {
  workspaceDir: string
  signal?: AbortSignal
}

/**
 * The evaluator. `fingerprint` identifies the scoring contract: if it changes,
 * scores from different runs are not comparable and the campaign refuses to
 * compare them.
 */
export interface Scorer {
  readonly fingerprint: string
  run(context: ScoreContext): Promise<ScoreResult>
}

export type MutationContext = {
  cycle: number
  scorerFingerprint: string
  /** Highest-scoring variant so far, with its full file contents. */
  best: {
    nodeId: string
    score: number
    rationale: string
    files: CandidateFile[]
  }
  history: EvaluationRecord[]
}

export interface Mutator {
  propose(context: MutationContext, signal?: AbortSignal): Promise<CandidateProposal[]>
}

export type EvaluationRecord = {
  cycle: number
  nodeId: string
  patchId: string
  parentId: string
  rationale: string
  score: number
  passed: boolean
  metrics: Record<string, number>
  accepted: boolean
  improvement: number
  /** Set when the scorer threw; the candidate was recorded but not accepted. */
  error?: string
  scorerFingerprint: string
  evaluatedAt: string
}

export const ROOT_NODE_ID = 'root'

export type TreeNode = {
  id: string
  parentId: string | null
  /** Independent direction opened in a cycle. -1 for the root. */
  branch: number
  /** Refinement attempt within the branch. -1 for the root. */
  attempt: number
  rationale: string
  score: number
  passed: boolean
  accepted: boolean
  createdAt: string
}

export type RsiStopReason =
  | 'plateau'
  | 'max_cycles'
  | 'budget'
  | 'deadline'
  | 'aborted'
  | 'mutator_exhausted'

export type RsiEvent =
  | { type: 'baseline'; nodeId: string; score: number; consistent: boolean }
  | { type: 'cycle_start'; cycle: number; bestScore: number }
  | { type: 'candidate_proposed'; cycle: number; patchId: string; rationale: string }
  | { type: 'candidate_skipped_scope'; cycle: number; patchId: string; paths: string[] }
  | { type: 'candidate_skipped_duplicate'; cycle: number; patchId: string }
  | { type: 'candidate_evaluated'; record: EvaluationRecord }
  | { type: 'candidate_failed'; cycle: number; patchId: string; error: string }
  | { type: 'candidate_accepted'; record: EvaluationRecord; branch: string | null }
  | { type: 'campaign_end'; result: CampaignResult }

export type CampaignResult = {
  campaignId: string
  branch: string | null
  scorerFingerprint: string
  baselineScore: number
  baselineConsistent: boolean
  bestScore: number
  acceptedCount: number
  evaluations: number
  cycles: number
  stopReason: RsiStopReason
  tree: TreeNode[]
  records: EvaluationRecord[]
}
