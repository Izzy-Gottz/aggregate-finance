import type { Connector, ConnectorDescription } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'

/** A connector package exports a factory; the server registers whichever packages are installed. */
export type ConnectorFactory = (deps: ConnectorDeps) => Connector

export class ConnectorRegistry {
  private factories = new Map<string, ConnectorFactory>()
  private descriptions = new Map<string, ConnectorDescription>()

  register(factory: ConnectorFactory, probeDeps: ConnectorDeps): void {
    const d = factory(probeDeps).describe()
    if (this.factories.has(d.key)) throw new Error(`connector ${d.key} registered twice`)
    this.factories.set(d.key, factory)
    this.descriptions.set(d.key, d)
  }

  create(key: string, deps: ConnectorDeps): Connector {
    const f = this.factories.get(key)
    if (!f) throw new Error(`unknown connector ${key}`)
    return f(deps)
  }

  has(key: string): boolean {
    return this.factories.has(key)
  }

  list(): ConnectorDescription[] {
    return [...this.descriptions.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  }
}
