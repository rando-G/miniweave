import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CandidatePatch } from './types.js'
import { writeCandidate } from './candidate.js'

export type WorkspaceHandle = {
  id: string
  dir: string
  /** Set for the champion worktree that accumulates accepted changes. */
  branch?: string
}

export type WorkspaceManagerOptions = {
  repoDir: string
  scratchDir: string
  /** Ref candidates branch from before any acceptance. Defaults to HEAD. */
  baseRef?: string
  /** When set, accepted candidates are committed to this branch. */
  branch?: string
}

type GitResult = { code: number; stdout: string; stderr: string }

export function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise(resolve => {
    const child = spawn('git', [...args], { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function runGitOrThrow(cwd: string, args: readonly string[]): Promise<GitResult> {
  const result = await runGit(cwd, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

/**
 * Isolates every candidate in its own `git worktree`. The user's working tree
 * and current branch are never touched: accepted changes accumulate on a
 * dedicated campaign branch inside a champion worktree, which can be inspected
 * or merged afterwards.
 */
export class WorkspaceManager {
  private readonly handles = new Map<string, WorkspaceHandle>()
  private currentRef: string

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.currentRef = options.baseRef ?? 'HEAD'
  }

  get ref(): string {
    return this.currentRef
  }

  async prepare(): Promise<void> {
    const inside = await runGit(this.options.repoDir, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error(`Not a git working tree: ${this.options.repoDir}`)
    }
    await mkdir(this.options.scratchDir, { recursive: true })
    await runGit(this.options.repoDir, ['worktree', 'prune'])
  }

  /** Create a detached worktree pinned at the current ref. */
  async create(id: string, ref: string = this.currentRef): Promise<WorkspaceHandle> {
    const dir = path.join(this.options.scratchDir, id)
    await rm(dir, { recursive: true, force: true })
    await runGitOrThrow(this.options.repoDir, ['worktree', 'add', '--detach', dir, ref])
    const handle: WorkspaceHandle = { id, dir }
    this.handles.set(id, handle)
    return handle
  }

  /** Create the worktree that carries accepted commits on the campaign branch. */
  async champion(): Promise<WorkspaceHandle> {
    const branch = this.options.branch
    if (!branch) throw new Error('WorkspaceManager was created without a campaign branch.')
    const id = 'champion'
    const dir = path.join(this.options.scratchDir, id)
    await rm(dir, { recursive: true, force: true })
    const created = await runGit(this.options.repoDir, [
      'worktree', 'add', '-b', branch, dir, this.options.baseRef ?? 'HEAD',
    ])
    if (created.code !== 0) {
      // The branch may already exist from a resumed campaign; attach instead.
      await runGitOrThrow(this.options.repoDir, ['worktree', 'add', dir, branch])
    }
    const handle: WorkspaceHandle = { id, dir, branch }
    this.handles.set(id, handle)
    this.currentRef = branch
    return handle
  }

  /** Write an accepted candidate into the champion worktree and commit it. */
  async commitAccepted(handle: WorkspaceHandle, patch: CandidatePatch, message: string): Promise<boolean> {
    await writeCandidate(handle.dir, patch)
    await runGitOrThrow(handle.dir, ['add', '-A'])
    const status = await runGitOrThrow(handle.dir, ['status', '--porcelain'])
    if (!status.stdout.trim()) return false
    await runGitOrThrow(handle.dir, ['commit', '-m', message])
    return true
  }

  async dispose(handle: WorkspaceHandle): Promise<void> {
    this.handles.delete(handle.id)
    const removed = await runGit(this.options.repoDir, ['worktree', 'remove', '--force', handle.dir])
    if (removed.code !== 0) {
      await rm(handle.dir, { recursive: true, force: true })
      await runGit(this.options.repoDir, ['worktree', 'prune'])
    }
  }

  async removeAll(): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      await this.dispose(handle)
    }
    await rm(this.options.scratchDir, { recursive: true, force: true })
  }
}
