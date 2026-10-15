import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ScoreContext, ScoreResult, Scorer } from './types.js'
import { isEnoentError } from '../utils/errors.js'

export type CommandScorerOptions = {
  /** Executable, e.g. `npm`, `node` or `bash`. */
  command: string
  args?: readonly string[]
  /** Run via a shell. Needed when `command` is a full shell line. */
  shell?: boolean
  /** Workspace-relative or absolute path the scorer writes JSON to. */
  scoreFile?: string
  /** Extra environment for the scorer. */
  env?: Record<string, string>
  timeoutMs?: number
  /**
   * Directory to launch the scorer from. Defaults to the candidate workspace.
   * Set it when the scorer lives outside the workspace and needs its own
   * dependencies; read candidate files via `$WEAVE_WORKSPACE` instead of `cwd`.
   */
  cwd?: string
}

function scorerFingerprint(options: CommandScorerOptions): string {
  const contract = JSON.stringify({
    command: options.command,
    args: options.args ?? [],
    shell: Boolean(options.shell),
    scoreFile: options.scoreFile ?? null,
    env: options.env ?? null,
    cwd: options.cwd ?? null,
  })
  return createHash('sha256').update(contract).digest('hex').slice(0, 16)
}

type ScorePayload = { score: number; passed?: boolean; metrics?: Record<string, number> }

function coerceScore(payload: unknown): ScorePayload {
  if (typeof payload === 'number') {
    if (!Number.isFinite(payload)) throw new Error(`Scorer produced a non-finite score: ${payload}`)
    return { score: payload }
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const score = record.score
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error('Scorer JSON must contain a finite numeric "score".')
    }
    const metrics: Record<string, number> = {}
    if (record.metrics && typeof record.metrics === 'object') {
      for (const [key, value] of Object.entries(record.metrics as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value
      }
    }
    return {
      score,
      passed: typeof record.passed === 'boolean' ? record.passed : undefined,
      metrics,
    }
  }
  throw new Error('Scorer JSON must be an object with a numeric "score".')
}

function parseFromText(text: string): ScorePayload | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return coerceScore(JSON.parse(trimmed))
  } catch {
    // Fall through to per-line scanning for command output with log noise.
  }
  const lines = trimmed.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return coerceScore(JSON.parse(line))
    } catch {
      // Keep scanning.
    }
  }
  return null
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

type RunOutcome = { code: number; stdout: string; stderr: string; timedOut: boolean }

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutcome> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, options.timeoutMs)
    const onAbort = () => { if (child.pid) killTree(child.pid) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { stderr += String(error); finish(-1) })
    child.on('close', code => finish(code ?? -1))
  })
}

/**
 * The scoring contract.
 *
 * The command runs with `cwd` set to the candidate workspace and must either
 * print a JSON object `{ "score": number, "passed"?: boolean, "metrics"?: {...} }`
 * or write it to `$WEAVE_SCORE_FILE`. The scorer is never read from the mutated
 * workspace: keep the bench and the scoring script outside the mutable set.
 */
export function createCommandScorer(options: CommandScorerOptions): Scorer {
  const fingerprint = scorerFingerprint(options)
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  return {
    fingerprint,
    async run(context: ScoreContext): Promise<ScoreResult> {
      const scoreFile = options.scoreFile
        ? (path.isAbsolute(options.scoreFile) ? options.scoreFile : path.join(context.workspaceDir, options.scoreFile))
        : path.join(os.tmpdir(), `weave-rsi-score-${randomUUID()}.json`)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
        WEAVE_RSI: '1',
        WEAVE_WORKSPACE: context.workspaceDir,
        WEAVE_SCORE_FILE: scoreFile,
      }
      const startedAt = Date.now()
      const outcome = await runProcess(options.command, options.args ?? [], {
        cwd: options.cwd ?? context.workspaceDir,
        env,
        shell: options.shell ?? false,
        timeoutMs,
        signal: context.signal,
      })
      let payload: ScorePayload | null = null
      try {
        const content = await readFile(scoreFile, 'utf8')
        payload = parseFromText(content)
      } catch (error) {
        if (!isEnoentError(error)) throw error
      }
      if (!options.scoreFile) await rm(scoreFile, { force: true })
      payload ??= parseFromText(outcome.stdout)
      if (!payload) {
        const detail = (outcome.stderr || outcome.stdout).trim().slice(0, 500)
        throw new Error(
          `Scorer produced no score${outcome.timedOut ? ' (timed out)' : ''}${outcome.code !== 0 ? ` (exit ${outcome.code})` : ''}: ${detail}`,
        )
      }
      return {
        score: payload.score,
        passed: payload.passed ?? outcome.code === 0,
        metrics: payload.metrics ?? {},
        durationMs: Date.now() - startedAt,
      }
    },
  }
}
