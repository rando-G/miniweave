import type { MiniContext } from './context.js'

/**
 * A MiniWeave plugin. Each plugin registers services into the shared
 * ServiceRegistry during `setup` and may clean them up in `dispose`.
 *
 * The Agent Loop depends only on the Service abstractions provided by
 * plugins (Model, Tools, Session, Permission, Context Manager, ...), so a
 * plugin can be replaced without touching the execution loop.
 */
export interface MiniPlugin {
  /** Unique plugin name, used for dependency resolution and diagnostics. */
  name: string
  /** Names of plugins that must be loaded before this one. */
  dependencies?: string[]
  /** Register services and initialize state. Runs once, in dependency order. */
  setup(context: MiniContext): void | Promise<void>
  /** Release resources. Runs in reverse load order. */
  dispose?(): void | Promise<void>
}
