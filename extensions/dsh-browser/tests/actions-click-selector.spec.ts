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

describe('browser_click_selector', () => {
  it('clicks the first element matching a CSS selector, addressable without a prior snapshot', async () => {
    document.body.innerHTML = '<div role="listbox"><div role="option" data-column="doing">Doing</div></div>'
    const option = document.querySelector('[data-column="doing"]')!
    option.scrollIntoView = vi.fn()
    const clicked = vi.fn()
    option.addEventListener('click', clicked)
    const ids = { elementByIndex: vi.fn() } as unknown as ElementIds

    const pending = runAction('browser_click_selector', { selector: '[data-column="doing"]' }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(250)

    await expect(pending).resolves.toMatchObject({ text: expect.stringContaining('Clicked "[data-column="doing"]"') })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('fails clearly when no element matches the selector', async () => {
    const ids = { elementByIndex: vi.fn() } as unknown as ElementIds

    await expect(runAction('browser_click_selector', { selector: '.does-not-exist' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ message: expect.stringContaining('No element matched selector: .does-not-exist') })
  })

  it('fails cleanly (not an unhandled DOMException) on a malformed selector', async () => {
    const ids = { elementByIndex: vi.fn() } as unknown as ElementIds

    await expect(runAction('browser_click_selector', { selector: '::::not-a-selector' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
  })
})
