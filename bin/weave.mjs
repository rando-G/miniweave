#!/usr/bin/env node
/**
 * Cross-platform launcher for MiniWeave.
 *
 * Resolves tsx from this project's `node_modules` (so it works when linked via
 * `npm link` / `npm install -g .`) and runs the TypeScript CLI with the caller's
 * working directory, so `weave` operates on whatever project you are in.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const cliEntry = path.join(projectRoot, 'src', 'index.ts')

function resolveTsxCli() {
  const candidates = [
    path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.cjs'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

const tsxCli = resolveTsxCli()
if (!tsxCli) {
  console.error(
    `weave: could not find tsx in ${path.join(projectRoot, 'node_modules')}.\n` +
      `Run "npm install" in ${projectRoot} first.`,
  )
  process.exit(1)
}

const child = spawn(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

child.on('error', error => {
  console.error(`weave: failed to start: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
