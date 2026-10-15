export { Archive } from './archive.js'
export type { ArchiveRecord } from './archive.js'
export { CampaignBudget, CampaignLimitError } from './budget.js'
export type { BudgetSnapshot } from './budget.js'
export { RsiCampaign } from './campaign.js'
export type { RsiCampaignOptions } from './campaign.js'
export {
  isPatchInScope,
  matchGlob,
  normalizeCandidate,
  outOfScopePaths,
  patchFingerprint,
  summarizePatch,
  writeCandidate,
} from './candidate.js'
export { ModelMutator, buildMutationPrompt, DEFAULT_RSI_SYSTEM_PROMPT } from './model-mutator.js'
export type { ModelMutatorOptions } from './model-mutator.js'
export { extractJsonValue, parseCandidateProposals, StaticMutator } from './mutator.js'
export { createCommandScorer } from './scorer.js'
export type { CommandScorerOptions } from './scorer.js'
export { DiscoveryTree } from './tree.js'
export { WorkspaceManager, runGit } from './workspace.js'
export type { WorkspaceHandle, WorkspaceManagerOptions } from './workspace.js'
export * from './types.js'
