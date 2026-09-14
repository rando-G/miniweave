import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Redirect the home directory and the tool's data directory BEFORE importing
// config.js, because its paths are computed at module load time.
const home = mkdtempSync(path.join(os.tmpdir(), 'miniweave-config-'))
const miniCodeHome = path.join(home, '.mini-code')
mkdirSync(miniCodeHome, { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home
process.env.MINI_CODE_HOME = miniCodeHome

const { loadRuntimeConfig } = await import('../src/config.js')

const SETTINGS_PATH = path.join(miniCodeHome, 'settings.json')

const MANAGED_KEYS = [
  'MINIWEAVE_MODEL',
  'MINIWEAVE_BASE_URL',
  'MINIWEAVE_AUTH_TOKEN',
  'MINIWEAVE_API_KEY',
  'MINIWEAVE_MAX_OUTPUT_TOKENS',
  'MINI_CODE_MODEL',
  'MINI_CODE_BASE_URL',
  'MINI_CODE_MAX_OUTPUT_TOKENS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]

function clearManagedEnv(): void {
  for (const key of MANAGED_KEYS) delete process.env[key]
}

function writeSettings(value: unknown): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2), 'utf8')
}

after(() => {
  clearManagedEnv()
  rmSync(home, { recursive: true, force: true })
})

describe('runtime config precedence', () => {
  it("lets this tool's settings file beat a shared ANTHROPIC_* environment", async () => {
    clearManagedEnv()
    writeSettings({
      model: 'settings-model',
      env: {
        ANTHROPIC_BASE_URL: 'https://settings.example',
        ANTHROPIC_AUTH_TOKEN: 'settings-token',
      },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://other-tool.example'
    process.env.ANTHROPIC_AUTH_TOKEN = 'other-tool-token'
    process.env.ANTHROPIC_MODEL = 'other-tool-model'

    const runtime = await loadRuntimeConfig()
    assert.equal(runtime.model, 'settings-model')
    assert.equal(runtime.baseUrl, 'https://settings.example')
    assert.equal(runtime.authToken, 'settings-token')
  })

  it('lets MINIWEAVE_* override both settings and ANTHROPIC_*', async () => {
    clearManagedEnv()
    writeSettings({
      model: 'settings-model',
      env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://other-tool.example'
    process.env.MINIWEAVE_MODEL = 'miniweave-model'
    process.env.MINIWEAVE_BASE_URL = 'https://miniweave.example'
    process.env.MINIWEAVE_AUTH_TOKEN = 'miniweave-token'

    const runtime = await loadRuntimeConfig()
    assert.equal(runtime.model, 'miniweave-model')
    assert.equal(runtime.baseUrl, 'https://miniweave.example')
    assert.equal(runtime.authToken, 'miniweave-token')
  })

  it('falls back to ANTHROPIC_* when nothing else is configured', async () => {
    clearManagedEnv()
    writeSettings({})
    process.env.ANTHROPIC_BASE_URL = 'https://env.example'
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'
    process.env.ANTHROPIC_MODEL = 'env-model'

    const runtime = await loadRuntimeConfig()
    assert.equal(runtime.model, 'env-model')
    assert.equal(runtime.baseUrl, 'https://env.example')
    assert.equal(runtime.authToken, 'env-token')
  })

  it('never mixes a bearer token and an API key from different sources', async () => {
    clearManagedEnv()
    writeSettings({
      model: 'settings-model',
      env: { ANTHROPIC_AUTH_TOKEN: 'settings-token' },
    })
    // A shared API key from another tool must not be paired with the settings token.
    process.env.ANTHROPIC_API_KEY = 'other-tool-key'

    const runtime = await loadRuntimeConfig()
    assert.equal(runtime.authToken, 'settings-token')
    assert.equal(runtime.apiKey, undefined)
  })

  it('reports which source each value came from', async () => {
    clearManagedEnv()
    writeSettings({
      model: 'settings-model',
      env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://other-tool.example'

    const runtime = await loadRuntimeConfig()
    assert.match(runtime.sourceSummary, /model=.*settings\.json/)
    assert.match(runtime.sourceSummary, /endpoint=.*settings\.json/)
  })

  it('throws a helpful error when no auth is configured', async () => {
    clearManagedEnv()
    writeSettings({ model: 'settings-model' })
    await assert.rejects(() => loadRuntimeConfig(), /No auth configured/)
  })

  it('throws a helpful error when no model is configured', async () => {
    clearManagedEnv()
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'settings-token' } })
    await assert.rejects(() => loadRuntimeConfig(), /No model configured/)
  })
})
