import type { CampaignLimits } from './types.js'
import { DEFAULT_CAMPAIGN_LIMITS } from './types.js'

export class CampaignLimitError extends Error {
  constructor(readonly limit: keyof CampaignLimits, message: string) {
    super(message)
    this.name = 'CampaignLimitError'
  }
}

export type BudgetSnapshot = {
  cycles: number
  agentStarts: number
  evaluatorRuns: number
  elapsedMs: number
}

/**
 * Hard counters for one bounded campaign. Every limit is checked before work
 * starts, never after, so a campaign can never overshoot by one expensive run.
 *
 * `now` is injectable so deadline behaviour is deterministic in tests.
 */
export class CampaignBudget {
  private cycles = 0
  private agentStarts = 0
  private evaluatorRuns = 0

  constructor(
    readonly limits: CampaignLimits = DEFAULT_CAMPAIGN_LIMITS,
    private readonly startedAt = Date.now(),
    private readonly now: () => number = Date.now,
  ) {}

  get elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt)
  }

  deadlineExceeded(): boolean {
    return this.elapsedMs >= this.limits.deadlineMs
  }

  canBeginCycle(): boolean {
    return this.cycles < this.limits.maxCycles && !this.deadlineExceeded()
  }

  beginCycle(): number {
    if (!this.canBeginCycle()) {
      throw new CampaignLimitError('maxCycles', 'Cannot begin a cycle: cycle or deadline limit reached.')
    }
    this.cycles += 1
    return this.cycles
  }

  canStartAgent(): boolean {
    return this.agentStarts < this.limits.maxAgentStarts && !this.deadlineExceeded()
  }

  spendAgentStart(): void {
    if (this.agentStarts >= this.limits.maxAgentStarts) {
      throw new CampaignLimitError('maxAgentStarts', 'Agent-start budget exhausted.')
    }
    this.agentStarts += 1
  }

  canEvaluate(): boolean {
    return this.evaluatorRuns < this.limits.maxEvaluatorRuns && !this.deadlineExceeded()
  }

  spendEvaluation(): void {
    if (this.evaluatorRuns >= this.limits.maxEvaluatorRuns) {
      throw new CampaignLimitError('maxEvaluatorRuns', 'Evaluator-run budget exhausted.')
    }
    this.evaluatorRuns += 1
  }

  snapshot(): BudgetSnapshot {
    return {
      cycles: this.cycles,
      agentStarts: this.agentStarts,
      evaluatorRuns: this.evaluatorRuns,
      elapsedMs: this.elapsedMs,
    }
  }
}
