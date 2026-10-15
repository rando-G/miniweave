import type { ChatMessage, ModelAdapter } from '../types.js'
import type { CandidateProposal, MutationContext, Mutator } from './types.js'
import { parseCandidateProposals } from './mutator.js'

export const DEFAULT_RSI_SYSTEM_PROMPT = [
  'You are the mutation proposer inside a Recursive Self-Improvement loop for a coding-agent harness.',
  'You do not chat. You output candidate harness changes as strict JSON and nothing else.',
  'Every candidate must be a complete, self-contained rewrite of each file it touches:',
  'the evaluator writes your file contents verbatim into an isolated workspace, it does not apply diffs.',
].join(' ')

export type ModelMutatorOptions = {
  model: ModelAdapter
  systemPrompt?: string
  maxCandidates?: number
  /** Per-file character budget when showing the current best variant. */
  maxFileChars?: number
  /** Called when the model returns something that is not valid proposals. */
  onParseError?: (error: Error, raw: string) => void
}

function renderBestFiles(context: MutationContext, maxFileChars: number): string {
  if (context.best.files.length === 0) {
    return '(no files yet — propose full contents for the files you change)'
  }
  return context.best.files
    .map(file => {
      const body = file.content.length > maxFileChars
        ? `${file.content.slice(0, maxFileChars)}\n… [truncated]`
        : file.content
      return `### ${file.path}\n\`\`\`\n${body}\n\`\`\``
    })
    .join('\n\n')
}

export function buildMutationPrompt(context: MutationContext, maxFileChars = 8000): string {
  const history = context.history.length === 0
    ? '(none yet)'
    : context.history
      .map(record => `- cycle ${record.cycle} ${record.accepted ? 'ACCEPTED' : 'rejected'} score=${record.score} :: ${record.rationale}`)
      .join('\n')
  return [
    `Cycle: ${context.cycle}`,
    `Current best variant "${context.best.nodeId}" scores ${context.best.score}.`,
    `Scoring contract fingerprint: ${context.scorerFingerprint}.`,
    '',
    '## Previously evaluated candidates',
    history,
    '',
    '## Current best variant',
    renderBestFiles(context, maxFileChars),
    '',
    '## Your task',
    'Propose 1-3 candidate harness changes that should raise the score.',
    'Only change files that are inside the declared mutable scope; out-of-scope candidates are discarded.',
    'Return raw JSON only — no markdown fences and no commentary.',
    'Inside JSON strings escape newlines as \\n and double quotes as \\".',
    'Return strict JSON of the form:',
    '{"candidates":[{"rationale":"why this should help","files":[{"path":"src/...","content":"<full new file contents>"}]}]}',
  ].join('\n')
}

/** Model-driven mutator: asks the adapter for candidate patches and parses them. */
export class ModelMutator implements Mutator {
  constructor(private readonly options: ModelMutatorOptions) {}

  async propose(context: MutationContext, signal?: AbortSignal): Promise<CandidateProposal[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.options.systemPrompt ?? DEFAULT_RSI_SYSTEM_PROMPT },
      { role: 'user', content: buildMutationPrompt(context, this.options.maxFileChars) },
    ]
    const step = await this.options.model.next(messages, { signal })
    const text = step.type === 'assistant' ? step.content : ''
    if (!text.trim()) return []
    try {
      return parseCandidateProposals(text).slice(0, this.options.maxCandidates ?? 3)
    } catch (error) {
      // Unparseable model output is ordinary: the campaign will simply plateau
      // or retry on the next cycle. Never let it abort the run.
      this.options.onParseError?.(error instanceof Error ? error : new Error(String(error)), text)
      return []
    }
  }
}
