import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PluginRegistry } from '../src/plugin/plugin-registry.js'
import type { MiniPlugin } from '../src/plugin/types.js'

describe('PluginRegistry', () => {
  it('loads plugins in dependency order', async () => {
    const order: string[] = []
    const registry = new PluginRegistry()
    await registry.load([
      { name: 'c', dependencies: ['b'], setup() { order.push('c') } },
      { name: 'a', setup() { order.push('a') } },
      { name: 'b', dependencies: ['a'], setup() { order.push('b') } },
    ])
    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  it('shares services between plugins via provide/use', async () => {
    const registry = new PluginRegistry()
    let resolved: string | undefined
    await registry.load([
      {
        name: 'model',
        setup(ctx) { ctx.provide('model', { complete: () => 'ok' }) },
      },
      {
        name: 'loop',
        dependencies: ['model'],
        setup(ctx) {
          const model = ctx.use<{ complete(): string }>('model')
          resolved = model.complete()
        },
      },
    ])
    assert.equal(resolved, 'ok')
    assert.equal(registry.services.has('model'), true)
  })

  it('disposes plugins in reverse load order', async () => {
    const disposed: string[] = []
    const registry = new PluginRegistry()
    await registry.load([
      { name: 'a', setup() {}, dispose() { disposed.push('a') } },
      { name: 'b', setup() {}, dispose() { disposed.push('b') } },
    ])
    await registry.dispose()
    assert.deepEqual(disposed, ['b', 'a'])
  })

  it('rejects a duplicate plugin name', async () => {
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([
        { name: 'a', setup() {} },
        { name: 'a', setup() {} },
      ]),
      /Duplicate plugin name: a/,
    )
  })

  it('rejects a dependency on an unknown plugin', async () => {
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([{ name: 'a', dependencies: ['missing'], setup() {} }]),
      /depends on unknown plugin: missing/,
    )
  })

  it('rejects a self-dependency', async () => {
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([{ name: 'a', dependencies: ['a'], setup() {} }]),
      /cannot depend on itself/,
    )
  })

  it('rejects circular dependencies', async () => {
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([
        { name: 'a', dependencies: ['b'], setup() {} },
        { name: 'b', dependencies: ['a'], setup() {} },
      ]),
      /Circular plugin dependency detected/,
    )
  })

  it('rejects duplicate service registration', async () => {
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([
        { name: 'a', setup(ctx) { ctx.provide('x', 1) } },
        { name: 'b', setup(ctx) { ctx.provide('x', 2) } },
      ]),
      /Service already registered: x/,
    )
  })

  it('rolls back already-loaded plugins when a setup fails', async () => {
    const disposed: string[] = []
    const registry = new PluginRegistry()
    await assert.rejects(
      registry.load([
        { name: 'ok', setup() {}, dispose() { disposed.push('ok') } },
        { name: 'bad', setup() { throw new Error('boom') } },
      ]),
      /boom/,
    )
    assert.deepEqual(disposed, ['ok'])
  })

  it('supports optional dispose and sync setup', async () => {
    const registry = new PluginRegistry()
    await registry.load([
      { name: 'sync', setup(ctx) { ctx.provide('v', 42) } },
    ])
    assert.equal(registry.services.get<number>('v'), 42)
    await registry.dispose()
    assert.equal(registry.services.has('v'), false)
  })
})
