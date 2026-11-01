// @vitest-environment happy-dom
// Keyboard: the phone menu and popover menus open, close on Escape and hand focus back to what opened them.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${new MockApi()} />`)
}

describe('Main menu by keyboard', () => {
  it('focus moves in on open; Escape closes it and returns focus to Menu', async () => {
    start('#/')
    const menu = await screen.findByRole('button', { name: 'Menu' })
    fireEvent.click(menu)
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Close menu'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(menu)
  })
})

describe('Company menu by keyboard', () => {
  it('Escape closes it even after focus has left it, without closing anything else', async () => {
    start('#/')
    const sw = (await screen.findAllByRole('button', { name: /All companies/ }))[0]!
    fireEvent.click(sw)
    await screen.findByRole('group', { name: 'Switch company' })
    ;(document.querySelector('main') as HTMLElement).focus()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Switch company' })).toBeNull())
  })

  it('Tab moves through the menu and closes it past the last item, back on the trigger', async () => {
    start('#/')
    const sw = (await screen.findAllByRole('button', { name: /All companies/ }))[0]!
    fireEvent.click(sw)
    const pop = await screen.findByRole('group', { name: 'Switch company' })
    const items = [...pop.querySelectorAll<HTMLElement>('button')]
    items.at(-1)!.focus()
    fireEvent.keyDown(items.at(-1)!, { key: 'Tab' })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Switch company' })).toBeNull())
    expect(document.activeElement).toBe(sw)
  })

  it('Escape inside a drawer closes only the menu', async () => {
    start('#/?d=ai:g_claude')
    const slot = (await screen.findAllByRole('button', { name: /all your companies/ }))[0]!
    fireEvent.click(slot)
    await waitFor(() => expect(document.querySelector('.pop')).not.toBeNull())
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.pop')).toBeNull())
    expect(document.querySelector('.drawer')).not.toBeNull()
    expect(document.activeElement).toBe(slot)
  })
})

describe('Skip to content', () => {
  it('moves focus to the content and stays on the page (the hash is the route)', async () => {
    start('#/review')
    await screen.findByRole('heading', { name: 'Review' })
    fireEvent.click(screen.getByText('Skip to content'))
    expect(location.hash).toBe('#/review')
    expect(document.activeElement?.id).toBe('main')
  })
})

describe('Drawer focus', () => {
  it('Tab from the title stays inside when nothing focusable follows it (a drawer still loading)', async () => {
    // happy-dom has no layout, so nothing has an offsetParent; the drawer counts only shown stops.
    const op = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
    onTestFinished(() => void (op && Object.defineProperty(HTMLElement.prototype, 'offsetParent', op)))
    const api = new MockApi()
    api.connection = () => new Promise(() => {}) // never loads: only Close, before the title
    location.hash = '#/?d=connection:c_chase'
    render(html`<${Root} api=${api} />`)
    const title = await screen.findByRole('heading', { name: 'Loading…' })
    await waitFor(() => expect(document.activeElement).toBe(title))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close')
  })
})

describe('Inline confirms keep focus', () => {
  it('Delete company and Disconnect move focus to Cancel, not to the page', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    location.hash = `#/?d=company:${e.id}`
    const v = render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'))
    v.unmount()
    start('#/?d=connection:c_chase')
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'))
  })

  it('Cancel puts focus back on the link that opened the confirm', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    location.hash = `#/?d=company:${e.id}`
    const v = render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Delete company'))
    v.unmount()
    start('#/?d=connection:c_chase')
    for (const opener of ['Disconnect', 'Disconnect and delete its data']) {
      fireEvent.click(await screen.findByRole('button', { name: opener }))
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(document.activeElement?.textContent).toBe(opener))
    }
  })
})
