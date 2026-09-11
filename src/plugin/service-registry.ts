/**
 * A named map of services shared across plugins. Rejects duplicate
 * registrations so a service always has exactly one owning plugin.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, unknown>()

  provide<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service already registered: ${name}`)
    }
    this.services.set(name, service)
  }

  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`Service not found: ${name}`)
    }
    return this.services.get(name) as T
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  remove(name: string): void {
    if (!this.services.has(name)) {
      throw new Error(`Service not found: ${name}`)
    }
    this.services.delete(name)
  }

  clear(): void {
    this.services.clear()
  }
}
