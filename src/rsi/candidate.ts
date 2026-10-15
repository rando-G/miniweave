import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CandidateFile, CandidatePatch } from './types.js'
import { candidateProposalSchema } from './types.js'

/** Content fingerprint: the identity of a candidate, independent of its label. */
export function patchFingerprint(files: readonly CandidateFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path.replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Validate a mutator proposal and turn it into a normalized patch. Duplicate
 * paths keep the last write, and files are sorted so the fingerprint is stable.
 */
export function normalizeCandidate(proposal: unknown, parentId: string | null): CandidatePatch {
  const parsed = candidateProposalSchema.parse(proposal)
  const byPath = new Map<string, string>()
  for (const file of parsed.files) {
    byPath.set(file.path.replace(/\\/g, '/'), file.content)
  }
  const files: CandidateFile[] = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, content]) => ({ path: filePath, content }))
  return {
    id: patchFingerprint(files),
    parentId: parsed.parentId ?? parentId,
    rationale: parsed.rationale,
    files,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Minimal glob matcher supporting `**`, `*` and `?` on `/`-separated paths. */
export function matchGlob(pattern: string, filePath: string): boolean {
  const glob = pattern.replace(/\\/g, '/')
  const target = filePath.replace(/\\/g, '/')
  let regex = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          regex += '(?:.*/)?'
        } else {
          regex += '.*'
        }
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else {
      regex += escapeRegExp(char)
    }
  }
  regex += '$'
  return new RegExp(regex).test(target)
}

export function isPatchInScope(patch: CandidatePatch, allowed: readonly string[]): boolean {
  return patch.files.every(file => allowed.some(pattern => matchGlob(pattern, file.path)))
}

export function outOfScopePaths(patch: CandidatePatch, allowed: readonly string[]): string[] {
  return patch.files
    .map(file => file.path)
    .filter(filePath => !allowed.some(pattern => matchGlob(pattern, filePath)))
}

/**
 * Write a candidate into a disposable workspace. Traversal is rejected rather
 * than silently normalized, so a malformed proposal fails loudly.
 */
export async function writeCandidate(workspaceDir: string, patch: CandidatePatch): Promise<void> {
  const root = path.resolve(workspaceDir)
  for (const file of patch.files) {
    if (path.isAbsolute(file.path)) {
      throw new Error(`Candidate path must be relative: ${file.path}`)
    }
    const target = path.resolve(root, file.path)
    const relative = path.relative(root, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Candidate path escapes the workspace: ${file.path}`)
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }
}

export function summarizePatch(patch: CandidatePatch): string {
  const paths = patch.files.map(file => file.path).join(', ')
  return `${patch.id} (${patch.files.length} file${patch.files.length === 1 ? '' : 's'}: ${paths})`
}
