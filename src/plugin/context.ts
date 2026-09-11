import type { ServiceRegistry } from './service-registry.js'

/**
 * The per-plugin view of the shared ServiceRegistry. Plugins `provide` the
 * services they own and `use` services provided by plugins loaded before
 * them. The `use`/`provide` split enforces the "Service 与 Plugin 分离"
 * discipline: a plugin declares a capability contract but never reaches into
 * another plugin's internals.
 */
export class MiniContext {
  private readonly providedServices = new Set<string>()

  constructor(private readonly services: ServiceRegistry) {}

  use<T>(name: string): T {
    return this.services.get<T>(name)
  }

  provide<T>(name: string, service: T): void {
    this.services.provide(name, service)
    this.providedServices.add(name)
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  /**
   * Names of services this context registered. Used by the PluginRegistry to
   * undo a plugin's registrations on rollback or dispose.
   */
  getProvidedServiceNames(): readonly string[] {
    return [...this.providedServices]
  }
}
