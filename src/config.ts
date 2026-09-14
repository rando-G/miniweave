import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export type MiniCodeSettings = {
  env?: Record<string, string | number>
  model?: string
  maxOutputTokens?: number
  mcpServers?: Record<string, McpServerConfig>
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>
  sourceSummary: string
}

export type McpConfigScope = 'user' | 'project'

export const MINI_CODE_DIR = process.env.MINI_CODE_HOME
  ? path.resolve(process.env.MINI_CODE_HOME)
  : path.join(os.homedir(), '.mini-code')
export const MINI_CODE_SETTINGS_PATH = path.join(MINI_CODE_DIR, 'settings.json')
export const MINI_CODE_HISTORY_PATH = path.join(MINI_CODE_DIR, 'history.jsonl')
export const MINI_CODE_PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')
export const MINI_CODE_MCP_PATH = path.join(MINI_CODE_DIR, 'mcp.json')
export const MINI_CODE_MCP_TOKENS_PATH = path.join(MINI_CODE_DIR, 'mcp-tokens.json')
export const MINI_CODE_PROJECTS_DIR = path.join(MINI_CODE_DIR, 'projects')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')

export async function readMcpTokensFile(
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

async function readSettingsFile(filePath: string): Promise<MiniCodeSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as MiniCodeSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : MINI_CODE_MCP_PATH
}

export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

function mergeSettings(
  base: MiniCodeSettings,
  override: MiniCodeSettings,
): MiniCodeSettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
  }
}

export async function loadEffectiveSettings(): Promise<MiniCodeSettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, miniCodeSettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(MINI_CODE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(MINI_CODE_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    miniCodeSettings,
  )
}

export async function saveMiniCodeSettings(
  updates: MiniCodeSettings,
): Promise<void> {
  await mkdir(MINI_CODE_DIR, { recursive: true })
  const existing = await readSettingsFile(MINI_CODE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    MINI_CODE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

type ConfigTier =
  | 'miniweave-env'
  | 'mini-code-env'
  | 'mini-code-settings'
  | 'process-env'
  | 'claude-settings'

type ConfigCandidate = {
  value: string | undefined
  source: string
  tier: ConfigTier
}

function resolveFirst(candidates: ConfigCandidate[]): ConfigCandidate {
  for (const candidate of candidates) {
    if (candidate.value?.trim()) return candidate
  }
  return { value: undefined, source: 'unset', tier: 'process-env' }
}

/** Settings files may store env values as `string | number`; normalize to text. */
function asText(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value)
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const [claudeSettings, miniCodeSettings, globalMcpConfig, projectMcpConfig] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readSettingsFile(MINI_CODE_SETTINGS_PATH),
      readMcpConfigFile(MINI_CODE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
    ])

  const mcpServers =
    mergeSettings(
      mergeSettings(
        mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
        { mcpServers: projectMcpConfig },
      ),
      miniCodeSettings,
    ).mcpServers ?? {}

  const miniCodeEnv = miniCodeSettings.env ?? {}
  const claudeEnv = claudeSettings.env ?? {}
  const env = process.env

  // Resolution order, highest precedence first:
  //   1. MINIWEAVE_*     this tool's own namespace; cannot collide with another
  //                      Anthropic-compatible tool that exports ANTHROPIC_*
  //   2. MINI_CODE_*     legacy names inherited from upstream
  //   3. ~/.mini-code/settings.json   this tool's explicit configuration
  //   4. ANTHROPIC_* process env      often owned by another tool (pi, Claude Code)
  //   5. ~/.claude/settings.json      shared Claude configuration
  //
  // Note the deliberate inversion at 3 vs 4: a shared ANTHROPIC_* variable in
  // the shell should not silently override this tool's own settings file.
  const model = resolveFirst([
    { value: env.MINIWEAVE_MODEL, source: 'MINIWEAVE_MODEL', tier: 'miniweave-env' },
    { value: env.MINI_CODE_MODEL, source: 'MINI_CODE_MODEL', tier: 'mini-code-env' },
    { value: asText(miniCodeSettings.model), source: `${MINI_CODE_SETTINGS_PATH} (model)`, tier: 'mini-code-settings' },
    { value: env.ANTHROPIC_MODEL, source: 'ANTHROPIC_MODEL', tier: 'process-env' },
    { value: asText(claudeEnv.ANTHROPIC_MODEL), source: `${CLAUDE_SETTINGS_PATH} (env)`, tier: 'claude-settings' },
  ])

  const endpoint = resolveFirst([
    { value: env.MINIWEAVE_BASE_URL, source: 'MINIWEAVE_BASE_URL', tier: 'miniweave-env' },
    { value: env.MINI_CODE_BASE_URL, source: 'MINI_CODE_BASE_URL', tier: 'mini-code-env' },
    { value: asText(miniCodeEnv.ANTHROPIC_BASE_URL), source: `${MINI_CODE_SETTINGS_PATH} (env)`, tier: 'mini-code-settings' },
    { value: env.ANTHROPIC_BASE_URL, source: 'ANTHROPIC_BASE_URL', tier: 'process-env' },
    { value: asText(claudeEnv.ANTHROPIC_BASE_URL), source: `${CLAUDE_SETTINGS_PATH} (env)`, tier: 'claude-settings' },
  ])

  // Credentials resolve as a unit so a bearer token and an API key can never be
  // picked from two different sources.
  const authCandidates = [
    { value: env.MINIWEAVE_AUTH_TOKEN, source: 'MINIWEAVE_AUTH_TOKEN', tier: 'miniweave-env' as const, kind: 'authToken' as const },
    { value: env.MINIWEAVE_API_KEY, source: 'MINIWEAVE_API_KEY', tier: 'miniweave-env' as const, kind: 'apiKey' as const },
    { value: asText(miniCodeEnv.ANTHROPIC_AUTH_TOKEN), source: `${MINI_CODE_SETTINGS_PATH} (env)`, tier: 'mini-code-settings' as const, kind: 'authToken' as const },
    { value: asText(miniCodeEnv.ANTHROPIC_API_KEY), source: `${MINI_CODE_SETTINGS_PATH} (env)`, tier: 'mini-code-settings' as const, kind: 'apiKey' as const },
    { value: env.ANTHROPIC_AUTH_TOKEN, source: 'ANTHROPIC_AUTH_TOKEN', tier: 'process-env' as const, kind: 'authToken' as const },
    { value: env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY', tier: 'process-env' as const, kind: 'apiKey' as const },
    { value: asText(claudeEnv.ANTHROPIC_AUTH_TOKEN), source: `${CLAUDE_SETTINGS_PATH} (env)`, tier: 'claude-settings' as const, kind: 'authToken' as const },
    { value: asText(claudeEnv.ANTHROPIC_API_KEY), source: `${CLAUDE_SETTINGS_PATH} (env)`, tier: 'claude-settings' as const, kind: 'apiKey' as const },
  ]
  const auth = authCandidates.find(candidate => candidate.value?.trim())

  const authToken = auth?.kind === 'authToken' ? auth.value?.trim() : undefined
  const apiKey = auth?.kind === 'apiKey' ? auth.value?.trim() : undefined

  const maxOutputCandidate = resolveFirst([
    { value: env.MINIWEAVE_MAX_OUTPUT_TOKENS, source: 'MINIWEAVE_MAX_OUTPUT_TOKENS', tier: 'miniweave-env' },
    { value: env.MINI_CODE_MAX_OUTPUT_TOKENS, source: 'MINI_CODE_MAX_OUTPUT_TOKENS', tier: 'mini-code-env' },
    { value: asText(miniCodeSettings.maxOutputTokens), source: `${MINI_CODE_SETTINGS_PATH} (maxOutputTokens)`, tier: 'mini-code-settings' },
    { value: asText(claudeEnv.MINI_CODE_MAX_OUTPUT_TOKENS), source: `${CLAUDE_SETTINGS_PATH} (env)`, tier: 'claude-settings' },
  ])
  const parsedMaxOutputTokens = Number(maxOutputCandidate.value)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  const modelValue = model.value
  if (!modelValue) {
    throw new Error(
      'No model configured. Set MINIWEAVE_MODEL, ~/.mini-code/settings.json, or ANTHROPIC_MODEL.',
    )
  }

  if (!authToken && !apiKey) {
    throw new Error(
      'No auth configured. Set MINIWEAVE_AUTH_TOKEN / MINIWEAVE_API_KEY, '
        + '~/.mini-code/settings.json, or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY.',
    )
  }

  // Detect the split-brain case: the model comes from this tool's settings file
  // while the endpoint or credential comes from a shared ANTHROPIC_* variable
  // that most likely belongs to another tool.
  if (
    model.tier === 'mini-code-settings' &&
    (endpoint.tier === 'process-env' || auth?.tier === 'process-env')
  ) {
    console.error(
      '[miniweave] config warning: mixed sources — '
        + `model=${model.source}, endpoint=${endpoint.source}, auth=${auth?.source ?? 'unset'}. `
        + 'Another Anthropic-compatible tool may be exporting ANTHROPIC_* in this shell. '
        + 'Set MINIWEAVE_BASE_URL / MINIWEAVE_AUTH_TOKEN to override explicitly.',
    )
  }

  return {
    model: modelValue,
    baseUrl: endpoint.value ?? 'https://api.anthropic.com',
    authToken,
    apiKey,
    maxOutputTokens,
    mcpServers,
    sourceSummary:
      `model=${model.source} | endpoint=${endpoint.source} | auth=${auth?.source ?? 'unset'}`,
  }
}
