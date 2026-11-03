// @vitest-environment happy-dom
// The app's Connect your AI steps say exactly what the guides say (docs/guides/connect-*.md and docs/connect-your-ai.md),
// so a video viewer who reads either sees the same words. Then the list itself: Claude open, one at a time, links.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { AssistantList, ASSISTANTS, cursorLink, vscodeLink } from './assistants.ts'

const HOSTED = 'https://app.aggregate.finance/mcp'
/** The repo's docs folder (tests run from the repo root). */
const docs = join(process.cwd(), 'docs')
/** Markdown to plain words: links to their text, no bold or code marks, straight quotes. */
const plain = (t: string) =>
  t
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
const guide = (g: string) => plain(readFileSync(join(docs, g === 'connect-your-ai' ? 'connect-your-ai.md' : `guides/${g}.md`), 'utf8'))

describe('Connect your AI follows the guides', () => {
  for (const a of ASSISTANTS) {
    it(`${a.name}: every step${a.note && !a.own ? ', the note' : ''} and command is in ${a.guide}.md`, () => {
      const text = guide(a.guide)
      const words = [...a.steps, ...(a.note && !a.own ? [a.note] : []), ...(a.commands ?? []).flatMap((c) => [c.text, ...(c.after ? [c.after] : [])])]
      for (const w of words) expect(text, w).toContain(plain(w.replace(/\{url\}/g, HOSTED)))
    })
  }

  it('the Cursor link for the hosted server is the guide’s', () => {
    expect(guide('connect-cursor')).toContain(cursorLink(HOSTED))
  })
})

describe('the list', () => {
  it('starts with Claude open, opens one at a time, shows this server’s link and the guide', async () => {
    render(html`<${AssistantList} url="https://agfn.example/mcp" />`)
    const claude = screen.getByRole('button', { name: /^Claude Web and desktop/ })
    expect(claude.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Customize → Connectors/)).toBeTruthy()
    expect(screen.getByText('https://agfn.example/mcp')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Full guide ↗' }).getAttribute('href')).toBe('/docs/guides/connect-claude')

    fireEvent.click(screen.getByRole('button', { name: /^Cursor/ }))
    expect(claude.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/Customize → Connectors/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Add Aggregate to Cursor' }).getAttribute('href')).toBe(cursorLink('https://agfn.example/mcp'))
    expect(screen.getByRole('link', { name: 'Add Aggregate to VS Code' }).getAttribute('href')).toBe(vscodeLink('https://agfn.example/mcp'))
    expect(vscodeLink('https://agfn.example/mcp')).toBe('vscode:mcp/install?%7B%22name%22%3A%22aggregate%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fagfn.example%2Fmcp%22%7D')

    fireEvent.click(screen.getByRole('button', { name: /^Claude Code, Codex/ }))
    expect(screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent === 'claude mcp add --transport http --scope user aggregate https://agfn.example/mcp')).toBeTruthy()
    // A flag never splits at its hyphens on a narrow screen: each word is kept whole.
    expect(screen.getByText('--scope').className).toBe('nowrap')
    expect(screen.queryByText(/from launch day/)).toBeNull()
    for (const name of ['ChatGPT', 'Grok', 'Other apps']) expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy()
  })
})
