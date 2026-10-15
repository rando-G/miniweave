import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const testDir = path.join(root, 'test')
const entries = await readdir(testDir)
const testFiles = entries
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => path.join(testDir, name))

if (testFiles.length === 0) {
  console.error('No test files found in test/*.test.ts')
  process.exit(1)
}

// Isolate the data directory unless the caller pinned one. Some tests delete
// MINI_CODE_PROJECTS_DIR, which is the real ~/.mini-code/projects by default.
const ownedHome = process.env.MINI_CODE_HOME ? null : await mkdtemp(path.join(os.tmpdir(), 'miniweave-test-home-'))
const isolatedHome = process.env.MINI_CODE_HOME ?? ownedHome

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  {
    stdio: 'inherit',
    env: { ...process.env, MINI_CODE_HOME: isolatedHome },
  },
)

child.on('exit', async (code, signal) => {
  if (ownedHome) {
    await rm(ownedHome, { recursive: true, force: true }).catch(() => {})
  }
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
