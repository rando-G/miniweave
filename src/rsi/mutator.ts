import type { CandidateProposal, MutationContext, Mutator } from './types.js'
import { candidateProposalSchema } from './types.js'

/** Pull the first JSON array/object out of model output, tolerating prose and fences. */
export function extractJsonValue(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const text = fenced?.[1] ?? raw
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error('Mutator output contained no JSON.')
  for (let end = text.length; end > start; end -= 1) {
    const candidate = text.slice(start, end).trim()
    const last = candidate[candidate.length - 1]
    if (last !== ']' && last !== '}') continue
    try {
      return JSON.parse(candidate)
    } catch {
      // Keep shrinking until the JSON parses.
    }
  }
  throw new Error('Could not parse JSON from mutator output.')
}

export function parseCandidateProposals(raw: string): CandidateProposal[] {
  const value = extractJsonValue(raw)
  const list: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { candidates?: unknown }).candidates)
      ? ((value as { candidates: unknown[] }).candidates)
      : [value]
  return list.map(item => candidateProposalSchema.parse(item))
}

/** Deterministic mutator for tests and offline demos. */
export class StaticMutator implements Mutator {
  constructor(
    private readonly proposals: CandidateProposal[] | ((context: MutationContext) => CandidateProposal[]),
  ) {}

  async propose(context: MutationContext): Promise<CandidateProposal[]> {
    return typeof this.proposals === 'function' ? this.proposals(context) : this.proposals
  }
}
