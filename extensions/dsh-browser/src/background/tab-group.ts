/** Browser-session storage survives service-worker suspension, but not browser exit. */
export interface TabGroupStorage {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

/** Owns only agent-created tabs, with independent groups and cleanup per session. */
export class DshTabGroupManager {
  private groups = new Map<string, Map<number, number>>()
  private owned = new Map<string, Set<number>>()
  private borrowed = new Map<string, Map<number, { originalGroup: number; taskGroup: number }>>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage?: TabGroupStorage) {
    if (storage !== undefined) this.pending = this.restore()
  }

  private async restore(): Promise<void> {
    const saved = await this.storage?.read()
    if (!Array.isArray(saved)) return
    for (const entry of saved) {
      if (typeof entry !== 'object' || entry === null || typeof entry.sessionId !== 'string'
        || !Array.isArray(entry.tabs) || !entry.tabs.every((id: unknown) => Number.isInteger(id))) continue
      this.owned.set(entry.sessionId, new Set<number>(entry.tabs))
      if (Array.isArray(entry.borrowed)) {
        const borrowed = new Map<number, { originalGroup: number; taskGroup: number }>()
        for (const tab of entry.borrowed) {
          if (Array.isArray(tab) && tab.length === 3 && tab.every(id => Number.isInteger(id))) {
            borrowed.set(tab[0], { originalGroup: tab[1], taskGroup: tab[2] })
          }
        }
        this.borrowed.set(entry.sessionId, borrowed)
      }
      if (Array.isArray(entry.groups) && entry.groups.every((pair: unknown) =>
        Array.isArray(pair) && pair.length === 2 && pair.every(id => Number.isInteger(id)))) {
        this.groups.set(entry.sessionId, new Map<number, number>(entry.groups))
      }
    }
  }

  private async persist(): Promise<void> {
    await this.storage?.write([...this.owned].map(([sessionId, tabs]) => ({
      sessionId, tabs: [...tabs], groups: [...(this.groups.get(sessionId) ?? [])],
      borrowed: [...(this.borrowed.get(sessionId) ?? [])].map(([id, tab]) => [id, tab.originalGroup, tab.taskGroup]),
    })))
  }

  /** Group an agent-created tab without activating its tab or window. */
  ensureGroup(windowId: number, tabId: number, sessionId = ''): Promise<{ groupId: number; created: boolean }> {
    return this.enqueue(async () => {
      const tabs = this.owned.get(sessionId) ?? new Set<number>()
      tabs.add(tabId)
      this.owned.set(sessionId, tabs)
      await this.persist()
      return this.groupTab(windowId, tabId, sessionId)
    })
  }

  private async groupTab(windowId: number, tabId: number, sessionId: string): Promise<{ groupId: number; created: boolean }> {
    const groups = this.groups.get(sessionId) ?? new Map<number, number>()
    this.groups.set(sessionId, groups)
    const cached = groups.get(windowId)
    if (cached !== undefined && await this.isLive(cached)) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: cached })
      return { groupId: cached, created: false }
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } })
    groups.set(windowId, groupId)
    await this.persist()
    await chrome.tabGroups.update(groupId, { title: 'DSH', color: 'blue' })
    return { groupId, created: true }
  }

  /** Temporarily group a pre-existing target; it must never be automatically closed. */
  borrowTab(tabId: number, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if ([...this.owned.values()].some(tabs => tabs.has(tabId))
        || [...this.borrowed.values()].some(tabs => tabs.has(tabId))) return
      const tab = await chrome.tabs.get(tabId)
      if (tab.groupId >= 0) return
      const grouped = await this.groupTab(tab.windowId, tabId, sessionId)
      const borrowed = this.borrowed.get(sessionId) ?? new Map<number, { originalGroup: number; taskGroup: number }>()
      borrowed.set(tabId, { originalGroup: tab.groupId ?? -1, taskGroup: grouped.groupId })
      this.borrowed.set(sessionId, borrowed)
      if (!this.owned.has(sessionId)) this.owned.set(sessionId, new Set())
      await this.persist()
    })
  }

  /** Close only this session's agent-created tabs; Chrome removes empty groups. */
  finishSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const tabs = this.owned.get(sessionId)
      const borrowed = this.borrowed.get(sessionId)
      for (const [tabId, previous] of borrowed ?? []) {
        try {
          const tab = await chrome.tabs.get(tabId)
          // Respect any manual regrouping the user made during the task.
          if (tab.groupId !== previous.taskGroup) continue
          if (previous.originalGroup >= 0 && await this.isLive(previous.originalGroup)) {
            await chrome.tabs.group({ tabIds: [tabId], groupId: previous.originalGroup })
          } else {
            await chrome.tabs.ungroup(tabId)
          }
        } catch { /* The user may have closed or moved the borrowed tab. */ }
      }
      this.borrowed.delete(sessionId)
      this.owned.delete(sessionId)
      this.groups.delete(sessionId)
      for (const tabId of tabs ?? []) {
        try { await chrome.tabs.remove(tabId) }
        catch { /* The user may have already closed this owned tab. */ }
      }
      await this.persist()
    })
  }

  /** Forget closed tabs so their IDs cannot remain owned. */
  forgetTab(tabId: number): void {
    void this.enqueue(async () => {
      for (const tabs of this.owned.values()) tabs.delete(tabId)
      for (const tabs of this.borrowed.values()) tabs.delete(tabId)
      await this.persist()
    }).catch(console.error)
  }

  /** Preserve ownership when Chrome replaces a tab. */
  replaceTab(removedTabId: number, addedTabId: number): void {
    void this.enqueue(async () => {
      for (const tabs of this.owned.values()) {
        if (tabs.delete(removedTabId)) tabs.add(addedTabId)
      }
      for (const tabs of this.borrowed.values()) {
        const previous = tabs.get(removedTabId)
        if (previous !== undefined) { tabs.delete(removedTabId); tabs.set(addedTabId, previous) }
      }
      await this.persist()
    }).catch(console.error)
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }

  private async isLive(groupId: number): Promise<boolean> {
    try { await chrome.tabGroups.get(groupId); return true }
    catch { return false }
  }
}
