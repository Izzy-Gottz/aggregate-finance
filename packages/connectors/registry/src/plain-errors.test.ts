// Launch check (docs/qa/connector-errors.md): whatever a provider answers, a person never sees the provider's own text.
// Every connector's error classifier gets the same answers (expired token, missing permission, rate limit, outage, bad
// request) in every common body shape; plainError must turn each into one of our sentences.
//   AGFN_ERROR_TABLE=<file> npx vitest run packages/connectors/registry/src/plain-errors.test.ts  → writes the table
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { plainError, type ConnectorError } from '@agfn/connector-sdk'
import { classifyPlaidError } from '@agfn/connector-plaid'
import { classifySimplefinError } from '@agfn/connector-simplefin'
import { classifyMercuryError } from '@agfn/connector-mercury'
import { classifyBrexError } from '@agfn/connector-brex'
import { classifyRampError } from '@agfn/connector-ramp'
import { classifyWiseError } from '@agfn/connector-wise'
import { classifyStripeError } from '@agfn/connector-stripe'
import { classifySquareError } from '@agfn/connector-square'
import { classifyPayPalError } from '@agfn/connector-paypal'
import { classifyShopifyHttpError } from '@agfn/connector-shopify'
import { classifyPaddleError } from '@agfn/connector-paddle'
import { classifyPolarError } from '@agfn/connector-polar'
import { classifyLsError } from '@agfn/connector-lemonsqueezy'
import { classifyGumroadError } from '@agfn/connector-gumroad'
import { classifyAppStoreError } from '@agfn/connector-appstore'
import { classifyGoogleError } from '@agfn/connector-googleplay'
import { classifyQboError } from '@agfn/connector-quickbooks'
import { classifyXeroError } from '@agfn/connector-xero'

const RAW = 'ZZ_PROVIDER_TEXT'
// One body that carries the provider's text in every shape these APIs use.
const body = {
  message: RAW, error: RAW, error_description: RAW, error_message: RAW, detail: RAW, title: RAW, Message: RAW, Detail: RAW, Title: RAW,
  errors: [{ detail: RAW, message: RAW, code: 'SOMETHING', title: RAW }],
  error_type: 'X', error_code: 'X',
  Fault: { Error: [{ Message: RAW, Detail: RAW, code: '9999' }], type: 'ValidationFault' },
}
const headers = new Headers()
const CONNECTORS: Array<[string, (status: number) => ConnectorError | undefined]> = [
  // Plaid says a login died with ITEM_LOGIN_REQUIRED (HTTP 400), not with a 401.
  ['Plaid', (s) => classifyPlaidError(s === 401 ? 400 : s, s === 401 ? { ...body, error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', display_message: null } : body)],
  ['SimpleFIN', (s) => classifySimplefinError({ status: s, headers, body })],
  ['Mercury', (s) => classifyMercuryError({ status: s, headers, body })],
  ['Brex', (s) => classifyBrexError({ status: s, headers, body })],
  ['Ramp', (s) => classifyRampError({ status: s, headers, body })],
  ['Wise', (s) => classifyWiseError({ status: s, headers, body })],
  ['Stripe', (s) => classifyStripeError(s, body)],
  ['Square', (s) => classifySquareError(s, body)],
  ['PayPal', (s) => classifyPayPalError(s, body)],
  ['Shopify', (s) => classifyShopifyHttpError(s, body)],
  ['Paddle', (s) => classifyPaddleError(s, body)],
  ['Polar', (s) => classifyPolarError(s, body)],
  ['Lemon Squeezy', (s) => classifyLsError(s, body)],
  ['Gumroad', (s) => classifyGumroadError(s, body)],
  ['App Store Connect', (s) => classifyAppStoreError(s, body)],
  ['Google Play', (s) => classifyGoogleError(s, body)],
  ['QuickBooks', (s) => classifyQboError({ status: s, body })],
  ['Xero', (s) => classifyXeroError({ status: s, headers, body })],
]
const CASES: Array<[string, number]> = [
  ['token expired or revoked', 401],
  ['missing permission', 403],
  ['rate limited', 429],
  ['provider outage', 503],
  ['bad request', 400],
]

describe('connector failures in plain words', () => {
  const rows: string[] = []
  for (const [name, classify] of CONNECTORS) {
    it(`${name}: no provider text reaches the person, and a dead login asks to reconnect`, () => {
      for (const [what, status] of CASES) {
        const err = classify(status)
        expect(err, `${name} ${status}`).toBeDefined()
        if (!err) continue
        for (const phase of ['sync', 'connect'] as const) {
          const out = plainError(err, name, phase)
          expect(out.message, `${name} ${what} (${phase})`).not.toContain(RAW)
          expect(out.message.length).toBeGreaterThan(10)
        }
        const sync = plainError(err, name)
        if (status === 401) expect(sync.status, `${name} 401`).toBe('needs_reauth')
        if (status === 503) expect(sync.message, `${name} 503`).toMatch(/try again/i)
        rows.push(`| ${name} | ${what} (${status}) | ${err.kind} | ${sync.status === 'needs_reauth' ? 'Reconnect' : 'Sync now'} | ${sync.message} |`)
      }
    })
  }
  it('writes the table when asked', () => {
    const out = process.env.AGFN_ERROR_TABLE
    if (out) writeFileSync(out, ['| Connector | Case | Kind | Action | What the person sees |', '|---|---|---|---|---|', ...rows].join('\n') + '\n')
  })
})
