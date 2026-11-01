import { describe, expect, it } from 'vitest'
import { sampleEmails, signInEmail } from './email.ts'

const samples = sampleEmails()

describe('emails', () => {
  for (const [name, e] of Object.entries(samples)) {
    it(`${name}: matches its snapshot (subject, text, HTML)`, async () => {
      await expect(`Subject: ${e.subject}\n\n${e.text}`).toMatchFileSnapshot(`./__snapshots__/emails/${name}.txt`)
      await expect(e.html).toMatchFileSnapshot(`./__snapshots__/emails/${name}.html`)
    })

    it(`${name}: no tracking, no images, no rewritten links, a real text part`, () => {
      expect(e.html).not.toMatch(/<img|background-image|url\(/i)
      expect(e.html).not.toMatch(/utm_|track|pixel|click\./i)
      // Every link in the HTML is also written out in the text part, unchanged.
      for (const [, href] of e.html.matchAll(/href="([^"]+)"/g)) expect(e.text).toContain(href!.replace(/&amp;/g, '&'))
      expect(e.text.length).toBeGreaterThan(80)
      expect(e.text).not.toMatch(/<[a-z]/i)
      expect(e.html).toContain('<meta name="color-scheme" content="light dark">')
    })
  }

  it('sign-in: the subject says it expires; the body says we never ask for a password', () => {
    expect(samples['sign-in']!.subject).toBe('Your Aggregate sign-in link (expires in 10 minutes)')
    expect(samples['sign-in']!.text).toContain('never asks for your password')
  })

  it('escapes what it puts in HTML', () => {
    const e = signInEmail({ url: 'https://x.test/?a=1&b="2"', app: '<b>Evil</b>' })
    expect(e.html).not.toContain('<b>Evil</b>')
    expect(e.html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"')
  })

  it('the first link in the text part is the action', () => {
    for (const e of Object.values(samples)) {
      const first = e.text.match(/https?:\/\/\S+/)?.[0]
      if (e.html.includes('class="btn-a"')) expect(e.html).toContain(`href="${first}"`)
    }
  })
})
