// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser_click_at', () => {
  it('clicks the topmost element resolved at the given point (coordinate fallback for unenumerated targets)', async () => {
    document.body.innerHTML = '<div role="listbox"><div role="option">Doing</div></div>'
    const option = document.querySelector('[role="option"]')!
    option.scrollIntoView = vi.fn()
    const clicked = vi.fn()
    option.addEventListener('click', clicked)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(option as HTMLElement)
    const ids = { elementByIndex: vi.fn() } as unknown as ElementIds

    const pending = runAction('browser_click_at', { x: 42, y: 17 }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(250)

    await expect(pending).resolves.toMatchObject({ text: expect.stringContaining('Clicked at (42, 17)') })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('fails clearly when no element sits at the given point', async () => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    const ids = { elementByIndex: vi.fn() } as unknown as ElementIds

    await expect(runAction('browser_click_at', { x: 9_999, y: 9_999 }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ message: expect.stringContaining('No element found at (9999, 9999)') })
  })
})
