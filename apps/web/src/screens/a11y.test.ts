// @vitest-environment happy-dom
// axe on every page and drawer (MASTER §2 Look). Colour contrast is checked from the tokens (ui/contrast.test.ts); happy-dom
// has no layout, so axe's contrast rule can't run here.
import { render, screen } from '@testing-library/preact'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { tick } from '../test/setup.ts'
import { html } from '../ui/html.ts'

const PLACES = [
  '#/',
  '#/review',
  '#/preferences',
  '#/?d=company:e_acme',
  '#/?d=connection:c_chase',
  '#/?d=connect',
  '#/?d=connect:plaid',
  '#/?d=connect-ai',
  '#/?d=ai:g_claude',
  '#/?d=add:cash',
  '#/?d=add:upload',
  '#/?d=add:email',
  '#/?d=health',
  '#/?d=explain:e_acme:cash',
  '#/?d=company-new',
  '#/?d=invite',
  '#/?d=equity:e_acme',
  '#/?d=mrr:e_acme',
  '#/?d=investments:e_personal',
  '#/?d=company:e_personal',
]

describe('accessibility (axe)', () => {
  afterEach(() => document.body.replaceChildren())
  for (const place of PLACES) {
    it(`${place} has no axe violations`, async () => {
      location.hash = place
      render(html`<${Root} api=${new MockApi()} />`)
      await screen.findByRole('navigation')
      if (place.includes('?d=')) await screen.findByRole('dialog')
      for (let i = 0; i < 5; i++) await tick()
      const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
    })
  }
  for (const [place, opts, heading] of [
    ['#/signin', { signedIn: false }, /Sign in/],
    ['#/welcome/1', { empty: true }, /company called/],
    ['#/welcome/2', { empty: true }, /./],
    ['#/welcome/3', { empty: true }, /./],
    ['#/welcome/4', { empty: true }, /./],
    ['#/connect-ai/consent?client_id=claude&scope=read&exp=1&sig=abc', {}, /./],
  ] as const) {
    it(`${place} has no axe violations`, async () => {
      location.hash = place
      render(html`<${Root} api=${new MockApi(opts)} />`)
      await screen.findByRole('heading', { name: heading })
      for (let i = 0; i < 5; i++) await tick()
      const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
    })
  }
})
