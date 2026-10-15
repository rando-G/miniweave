import process from 'node:process'
import { stringDisplayWidth } from './chrome.js'

export const INPUT_PROMPT_PREFIX = 'weave> '

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const GREEN = '\u001b[32m'
const BOLD = '\u001b[1m'
const REVERSE = '\u001b[7m'

const INPUT_HINTS = [
  'Ask for code, files, tasks, or MCP tools',
  'Enter send; /help commands; Esc clear; Ctrl+C exit',
]

function truncateHint(input: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (input.length <= maxLength) return input
  if (maxLength <= 3) return '.'.repeat(maxLength)
  return `${input.slice(0, maxLength - 3)}...`
}

export function renderInputPrompt(
  input: string,
  cursorOffset: number,
  hintFrame = 0,
): string {
  const offset = Math.max(0, Math.min(cursorOffset, input.length))
  const before = input.slice(0, offset)
  const current = input[offset] ?? ' '
  const after = input.slice(Math.min(offset + 1, input.length))
  const promptPrefix = INPUT_PROMPT_PREFIX
  const visibleInput = `${promptPrefix}${before}${current}${after}`
  const panelInnerWidth = Math.max(0, Math.max(60, process.stdout.columns ?? 100) - 4)
  const hintMaxLength = Math.max(0, panelInnerWidth - visibleInput.length - 1)
  const hintText = truncateHint(
    INPUT_HINTS[Math.max(0, hintFrame) % INPUT_HINTS.length] ?? INPUT_HINTS[0]!,
    hintMaxLength,
  )
  const hint = input || !hintText ? '' : ` ${DIM}${hintText}${RESET}`

  const promptLabel = INPUT_PROMPT_PREFIX.trimEnd()
  return `${GREEN}${BOLD}${promptLabel}${RESET} ${before}${REVERSE}${current}${RESET}${after}${hint}`
}

/**
 * Display offset (0-based) of the caret within the input prompt text. The
 * terminal's own cursor is placed here so IME composition appears inside the
 * input box rather than wherever the last frame write happened to leave it.
 */
export function inputPromptCaretWidth(input: string, cursorOffset: number): number {
  const offset = Math.max(0, Math.min(cursorOffset, input.length))
  return stringDisplayWidth(INPUT_PROMPT_PREFIX) + stringDisplayWidth(input.slice(0, offset))
}
