export type RunBudgetLimits = {
  /** Model rounds allowed in one turn. `undefined` means no round limit. */
  maxSteps?: number
  /** Tool executions allowed in one turn. `undefined` means no call limit. */
  maxToolCalls?: number
  /** Wall-clock deadline for the whole turn, in milliseconds. */
  timeoutMs?: number
}

/** The budget a turn ran out of. Every value is also an `AgentTurnOutcome`. */
export type RunBudgetStop = 'max_steps' | 'max_tool_calls' | 'timeout'

export class RunBudgetLimitError extends Error {
  constructor(readonly stop: RunBudgetStop, message: string) {
    super(message)
    this.name = 'RunBudgetLimitError'
  }
}

/**
 * Hard counters for one agent turn: model rounds, tool executions, wall clock.
 *
 * Every limit is inspected *before* the work it pays for, so a counter can only
 * be exceeded by the operation already in flight and never by a fresh one. The
 * deadline is additionally enforced against in-flight I/O by the caller (it
 * derives an `AbortSignal` from `remainingMs`), so it does not wait for the next
 * round to notice. Same contract as `CampaignBudget` in the RSI engine.
 *
 * `now` is injectable so deadline behaviour is deterministic in tests.
 */
export class RunBudget {
  private steps = 0
  private toolCalls = 0

  constructor(
    readonly limits: RunBudgetLimits = {},
    private readonly startedAt = Date.now(),
    private readonly now: () => number = Date.now,
  ) {}

  get stepCount(): number { return this.steps }
  get toolCallCount(): number { return this.toolCalls }
  get hasDeadline(): boolean { return this.limits.timeoutMs !== undefined }

  get elapsedMs(): number { return Math.max(0, this.now() - this.startedAt) }

  get remainingMs(): number | undefined {
    if (this.limits.timeoutMs === undefined) return undefined
    return Math.max(0, this.limits.timeoutMs - this.elapsedMs)
  }

  deadlineExceeded(): boolean {
    return this.limits.timeoutMs !== undefined && this.elapsedMs >= this.limits.timeoutMs
  }

  /**
   * Why no further model round may start, or `undefined` while one may.
   * The deadline outranks the counters: time is the reason work is worthless.
   * A spent tool-call budget also stops the turn, because a new round could
   * only ask for tools the budget will refuse.
   */
  stopBeforeStep(): RunBudgetStop | undefined {
    if (this.deadlineExceeded()) return 'timeout'
    if (this.limits.maxSteps !== undefined && this.steps >= this.limits.maxSteps) return 'max_steps'
    return this.stopBeforeToolCall()
  }

  /**
   * Why no further tool call may run, or `undefined` while one may.
   * The round limit is deliberately absent: the round in progress is already
   * paid for, so its tools still run.
   */
  stopBeforeToolCall(): RunBudgetStop | undefined {
    if (this.deadlineExceeded()) return 'timeout'
    if (this.limits.maxToolCalls !== undefined && this.toolCalls >= this.limits.maxToolCalls) return 'max_tool_calls'
    return undefined
  }

  /** Consume one model round. Only call after checking `stopBeforeStep()`. */
  beginStep(): number {
    const stop = this.stopBeforeStep()
    if (stop) throw new RunBudgetLimitError(stop, `Run budget exhausted (${stop}) before model round ${this.steps + 1}.`)
    this.steps += 1
    return this.steps
  }

  /** Consume one tool execution. Only call after checking `stopBeforeToolCall()`. */
  spendToolCall(): number {
    const stop = this.stopBeforeToolCall()
    if (stop) throw new RunBudgetLimitError(stop, `Run budget exhausted (${stop}) before tool call ${this.toolCalls + 1}.`)
    this.toolCalls += 1
    return this.toolCalls
  }
}

/**
 * Explicit per-turn budgets. Autonomous modes (goal / loop) get a wall-clock
 * deadline because nobody is watching them. Interactive turns do not: the clock
 * would otherwise bill the human for thinking inside an approval prompt.
 */
export const MAX_TURN_STEPS = 50
export const MAX_INTERACTIVE_TURN_STEPS = 100
export const MAX_TURN_TOOL_CALLS = 200
export const TURN_TIMEOUT_MS = 30 * 60 * 1000

export function turnBudgetFor(mode?: 'goal' | 'loop'): RunBudgetLimits {
  return mode
    ? { maxSteps: MAX_TURN_STEPS, maxToolCalls: MAX_TURN_TOOL_CALLS, timeoutMs: TURN_TIMEOUT_MS }
    : { maxSteps: MAX_INTERACTIVE_TURN_STEPS, maxToolCalls: MAX_TURN_TOOL_CALLS }
}

/** Budget-sized duration for stop messages: milliseconds, seconds or minutes. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} 毫秒`
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} 秒`
  return `${Math.round(milliseconds / 60_000)} 分钟`
}
