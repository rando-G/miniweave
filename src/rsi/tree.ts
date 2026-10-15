import type { TreeNode } from './types.js'
import { ROOT_NODE_ID } from './types.js'

/**
 * Discovery tree: the structure one campaign explores.
 *
 * The root is the baseline harness. Every accepted candidate opens or extends a
 * branch; each node records the outcome of one evaluated attempt. Rejected
 * candidates are still recorded so the lineage explains what was tried.
 *
 * Playback/replay of a tree is intentionally out of scope for this first
 * version: the tree is an audit structure plus a parent selector.
 */
export class DiscoveryTree {
  private readonly nodes = new Map<string, TreeNode>()
  private readonly childrenByParent = new Map<string, string[]>()

  constructor(readonly rootId: string = ROOT_NODE_ID) {}

  addRoot(input: { score: number; passed: boolean; rationale?: string; createdAt?: string }): TreeNode {
    if (this.nodes.has(this.rootId)) {
      throw new Error(`Root node already exists: ${this.rootId}`)
    }
    const node: TreeNode = {
      id: this.rootId,
      parentId: null,
      branch: -1,
      attempt: -1,
      rationale: input.rationale ?? 'baseline',
      score: input.score,
      passed: input.passed,
      accepted: true,
      createdAt: input.createdAt ?? new Date().toISOString(),
    }
    this.insert(node)
    return node
  }

  addCandidate(input: {
    id: string
    parentId: string
    branch: number
    attempt: number
    rationale: string
    score: number
    passed: boolean
    accepted: boolean
    createdAt?: string
  }): TreeNode {
    if (this.nodes.has(input.id)) {
      throw new Error(`Duplicate node id: ${input.id}`)
    }
    if (!this.nodes.has(input.parentId)) {
      throw new Error(`Unknown parent node: ${input.parentId}`)
    }
    const node: TreeNode = { ...input, createdAt: input.createdAt ?? new Date().toISOString() }
    this.insert(node)
    return node
  }

  get(id: string): TreeNode | undefined {
    return this.nodes.get(id)
  }

  get size(): number {
    return this.nodes.size
  }

  best(): TreeNode | undefined {
    let best: TreeNode | undefined
    for (const node of this.nodes.values()) {
      if (!best || node.score > best.score) best = node
    }
    return best
  }

  /** Frontier nodes: the root plus everything that was not extended. */
  frontier(): TreeNode[] {
    return this.toArray().filter(node => (this.childrenByParent.get(node.id) ?? []).length === 0)
  }

  lineage(id: string): TreeNode[] {
    const chain: TreeNode[] = []
    let current = this.nodes.get(id)
    while (current) {
      chain.unshift(current)
      current = current.parentId ? this.nodes.get(current.parentId) : undefined
    }
    return chain
  }

  toArray(): TreeNode[] {
    return [...this.nodes.values()]
  }

  static fromArray(nodes: readonly TreeNode[], rootId: string = ROOT_NODE_ID): DiscoveryTree {
    const tree = new DiscoveryTree(rootId)
    for (const node of nodes) {
      if (node.parentId === null) {
        if (!tree.nodes.has(node.id)) tree.insert(node)
      } else {
        if (!tree.nodes.has(node.parentId)) {
          throw new Error(`Cannot restore tree: missing parent ${node.parentId} for ${node.id}`)
        }
        if (!tree.nodes.has(node.id)) tree.insert(node)
      }
    }
    return tree
  }

  private insert(node: TreeNode): void {
    this.nodes.set(node.id, node)
    if (node.parentId) {
      const siblings = this.childrenByParent.get(node.parentId) ?? []
      siblings.push(node.id)
      this.childrenByParent.set(node.parentId, siblings)
    }
  }
}
