// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('DshTabGroupManager', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a group on first use in a window and titles it DSH', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    const group = vi.fn(async () => 501)
    const update = vi.fn(async () => ({ id: 501 }))
    const get = vi.fn(async () => ({ id: 501 }))
    vi.stubGlobal('chrome', { tabs: { group }, tabGroups: { get, update } })

    const manager = new DshTabGroupManager()
    const result = await manager.ensureGroup(9, 42)

    expect(result).toEqual({ groupId: 501, created: true })
    expect(group).toHaveBeenCalledWith({ tabIds: [42], createProperties: { windowId: 9 } })
    expect(update).toHaveBeenCalledWith(501, { title: 'DSH', color: 'blue' })
  })

  it('reuses the cached group id for a second call in the same window', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    const group = vi.fn(async () => 501)
    const update = vi.fn(async () => ({ id: 501 }))
    const get = vi.fn(async () => ({ id: 501 }))
    vi.stubGlobal('chrome', { tabs: { group }, tabGroups: { get, update } })

    const manager = new DshTabGroupManager()
    const first = await manager.ensureGroup(9, 42)
    const second = await manager.ensureGroup(9, 43)

    expect(first).toEqual({ groupId: 501, created: true })
    expect(second).toEqual({ groupId: 501, created: false })
    // First call creates the group (tabIds + createProperties); second call
    // just moves its tab into the now-cached group id. Title is set once.
    expect(group).toHaveBeenNthCalledWith(1, { tabIds: [42], createProperties: { windowId: 9 } })
    expect(group).toHaveBeenNthCalledWith(2, { tabIds: [43], groupId: 501 })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('scopes groups independently per window', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    const group = vi.fn(async ({ createProperties }: { createProperties: { windowId: number } }) => (
      createProperties.windowId === 9 ? 501 : 777
    ))
    const update = vi.fn(async () => ({}))
    const get = vi.fn(async () => ({ id: 1 }))
    vi.stubGlobal('chrome', { tabs: { group }, tabGroups: { get, update } })

    const manager = new DshTabGroupManager()
    const first = await manager.ensureGroup(9, 42)
    const second = await manager.ensureGroup(3, 100)

    expect(first).toEqual({ groupId: 501, created: true })
    expect(second).toEqual({ groupId: 777, created: true })
    expect(group).toHaveBeenCalledTimes(2)
  })

  it('recreates the group after the cached one has been destroyed', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    let createCount = 0
    const group = vi.fn(async () => {
      createCount += 1
      return createCount === 1 ? 501 : 999
    })
    const update = vi.fn(async () => ({}))
    const get = vi.fn(async (id: number) => {
      if (id === 501) throw new Error('No group with id: 501')
      return { id }
    })
    vi.stubGlobal('chrome', { tabs: { group }, tabGroups: { get, update } })

    const manager = new DshTabGroupManager()
    const first = await manager.ensureGroup(9, 42)
    const second = await manager.ensureGroup(9, 43)

    expect(first).toEqual({ groupId: 501, created: true })
    expect(second).toEqual({ groupId: 999, created: true })
    expect(group).toHaveBeenCalledTimes(2)
  })
})

 describe('session tab cleanup', () => {
  it('closes only tabs opened by the completed session, even when grouping fails', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    const remove = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      tabs: { group: vi.fn(async () => { throw new Error('groups unavailable') }), remove },
      tabGroups: { get: vi.fn(), update: vi.fn() },
    })
    const manager = new DshTabGroupManager()
    await manager.ensureGroup(9, 42, 'a').catch(() => {})
    await manager.ensureGroup(9, 43, 'b').catch(() => {})
    await manager.finishSession('a')
    expect(remove).toHaveBeenCalledExactlyOnceWith(42)
    await manager.finishSession('a')
    expect(remove).toHaveBeenCalledTimes(1)
    await manager.finishSession('b')
    expect(remove).toHaveBeenLastCalledWith(43)
  })

  it('serializes simultaneous opens into one group per session', async () => {
    const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
    const group = vi.fn(async () => 501)
    vi.stubGlobal('chrome', {
      tabs: { group, remove: vi.fn(async () => {}) },
      tabGroups: { get: vi.fn(async () => ({ id: 501 })), update: vi.fn(async () => {}) },
    })
    const manager = new DshTabGroupManager()
    await Promise.all([manager.ensureGroup(9, 42, 'a'), manager.ensureGroup(9, 43, 'a')])
    expect(group).toHaveBeenNthCalledWith(2, { tabIds: [43], groupId: 501 })
    await manager.ensureGroup(9, 44, 'b')
    expect(group).toHaveBeenLastCalledWith({ tabIds: [44], createProperties: { windowId: 9 } })
  })
})

it('restores owned tabs after the background worker restarts', async () => {
  const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
  let saved: unknown
  const storage = { read: async () => saved, write: async (value: unknown) => { saved = structuredClone(value) } }
  const remove = vi.fn(async () => {})
  vi.stubGlobal('chrome', {
    tabs: { group: vi.fn(async () => 501), remove },
    tabGroups: { get: vi.fn(async () => ({ id: 501 })), update: vi.fn(async () => {}) },
  })
  await new DshTabGroupManager(storage).ensureGroup(9, 42, 'a')
  await new DshTabGroupManager(storage).finishSession('a')
  expect(remove).toHaveBeenCalledExactlyOnceWith(42)
  await new DshTabGroupManager(storage).finishSession('a')
  expect(remove).toHaveBeenCalledTimes(1)
})

it('temporarily groups an existing tab and restores it without closing it', async () => {
  const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
  let groupId = -1
  const group = vi.fn(async (options: { groupId?: number }) => { groupId = options.groupId ?? 501; return groupId })
  const remove = vi.fn()
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ id: 7, windowId: 9, groupId })), group, remove, ungroup: vi.fn() },
    tabGroups: { get: vi.fn(async (id: number) => ({ id })), update: vi.fn(async () => {}) },
  })
  const manager = new DshTabGroupManager()
  await manager.borrowTab(7, 'a')
  expect(group).toHaveBeenCalledWith({ tabIds: [7], createProperties: { windowId: 9 } })
  await manager.finishSession('a')
  expect(chrome.tabs.ungroup).toHaveBeenCalledExactlyOnceWith(7)
  expect(remove).not.toHaveBeenCalled()
})

it('leaves existing user groups intact', async () => {
  const { DshTabGroupManager } = await import('../src/background/tab-group.ts')
  const group = vi.fn()
  const remove = vi.fn()
  vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => ({ id: 7, windowId: 9, groupId: 12 })), group, remove } })
  const manager = new DshTabGroupManager()
  await manager.borrowTab(7, 'a')
  await manager.finishSession('a')
  expect(group).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})
