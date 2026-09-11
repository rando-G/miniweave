import { ServiceRegistry } from './service-registry.js'
import { MiniContext } from './context.js'
import type { MiniPlugin } from './types.js'

type LoadedPlugin = {
  plugin: MiniPlugin
  providedServices: string[]
}

/**
 * Assembles plugins into a runtime:
 *
 * - topologically sorts plugins by their `dependencies` (Kahn's algorithm)
 * - loads each plugin in order, giving it a MiniContext backed by the shared
 *   ServiceRegistry
 * - on any setup failure, rolls back by disposing already-loaded plugins
 * - disposes plugins in reverse load order
 *
 * Load order is derived from the dependency graph, not hard-coded, so adding
 * a plugin never requires editing the execution loop.
 */
export class PluginRegistry {
  readonly services = new ServiceRegistry()
  private readonly loaded = new Map<string, LoadedPlugin>()

  async load(plugins: MiniPlugin[]): Promise<void> {
    const order = this.resolveLoadOrder(plugins)
    try {
      for (const plugin of order) {
        const context = new MiniContext(this.services)
        try {
          await plugin.setup(context)
        } catch (error) {
          // A plugin that fails mid-setup may have registered services already.
          this.removeServices(context.getProvidedServiceNames())
          throw error
        }
        this.loaded.set(plugin.name, {
          plugin,
          providedServices: [...context.getProvidedServiceNames()],
        })
      }
    } catch (error) {
      await this.disposeLoaded()
      throw error
    }
  }

  async dispose(): Promise<void> {
    await this.disposeLoaded()
    this.services.clear()
  }

  private async disposeLoaded(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse()) {
      const entry = this.loaded.get(name)
      await entry?.plugin.dispose?.()
      this.removeServices(entry?.providedServices ?? [])
    }
    this.loaded.clear()
  }

  private removeServices(names: readonly string[]): void {
    for (const name of names) {
      if (this.services.has(name)) {
        this.services.remove(name)
      }
    }
  }

  private resolveLoadOrder(plugins: MiniPlugin[]): MiniPlugin[] {
    const byName = new Map<string, MiniPlugin>()
    for (const plugin of plugins) {
      if (byName.has(plugin.name)) {
        throw new Error(`Duplicate plugin name: ${plugin.name}`)
      }
      byName.set(plugin.name, plugin)
    }

    const indegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()
    for (const plugin of plugins) {
      indegree.set(plugin.name, 0)
      dependents.set(plugin.name, [])
    }

    for (const plugin of plugins) {
      for (const dep of plugin.dependencies ?? []) {
        if (dep === plugin.name) {
          throw new Error(`Plugin ${plugin.name} cannot depend on itself`)
        }
        if (!byName.has(dep)) {
          throw new Error(
            `Plugin ${plugin.name} depends on unknown plugin: ${dep}`,
          )
        }
        indegree.set(plugin.name, indegree.get(plugin.name)! + 1)
        dependents.get(dep)!.push(plugin.name)
      }
    }

    const queue = [...plugins]
      .filter(plugin => indegree.get(plugin.name) === 0)
      .map(plugin => plugin.name)
    const ordered: string[] = []

    while (queue.length > 0) {
      const name = queue.shift()!
      ordered.push(name)
      for (const dependent of dependents.get(name)!) {
        const next = indegree.get(dependent)! - 1
        indegree.set(dependent, next)
        if (next === 0) queue.push(dependent)
      }
    }

    if (ordered.length !== plugins.length) {
      const stuck = [...indegree.entries()]
        .filter(([, degree]) => degree > 0)
        .map(([name]) => name)
      throw new Error(
        `Circular plugin dependency detected: ${stuck.join(' -> ')}`,
      )
    }

    return ordered.map(name => byName.get(name)!)
  }
}
