import { afterEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectorDescription } from '@agfn/contracts'
import type { ConnectorFactory } from '@agfn/sync'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { hiddenConnectors, hostedUnlisted, loadConfig } from './config.ts'

// Hosted holds back Plaid before production and Stripe before the Stripe App has a live key (34's call, 2026-10-12).
const BASE = 'https://books.example.com'
let booted: Booted | undefined
afterEach(() => booted?.shutdown())

const fake = (key: string, name: string, group: ConnectorDescription['group']): ConnectorFactory => () =>
  ({ describe: () => ({ key, name, group, provides: ['transactions'], freshness: 'hours', auth: 'oauth' }) }) as unknown as Connector

async function start(env: Record<string, string>, email = 'owner@example.com') {
  const outbox: string[] = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', ...env }), runWorker: false }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push(m.text) },
    connectors: [fake('plaid', 'Bank or card (Plaid)', 'banks'), fake('stripe', 'Stripe', 'payments'), fake('simplefin', 'SimpleFIN Bridge', 'banks'), fake('mercury', 'Mercury', 'banks')],
    fileStore: new MemoryFileStore(),
  })
  const app = createApp(booted.services)
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Acme' }) })
  const list = async () => (await (await app.request('/api/connectors', { headers: { origin: BASE, cookie } })).json()) as Array<ConnectorDescription & { beta?: boolean }>
  const keys = async () => (await list()).map((d) => d.key)
  const startConnect = (key: string) => app.request(`/api/connectors/${key}/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })
  return { keys, list, startConnect }
}

describe('hostedUnlisted', () => {
  it('self-hosted offers everything', () => {
    expect(hostedUnlisted({ PLAID_ENV: 'sandbox' })).toEqual([])
  })
  it('hosted: Plaid only in production, Stripe only with a live app key', () => {
    expect(hostedUnlisted({ AGFN_HOSTED: '1', PLAID_ENV: 'sandbox', STRIPE_APP_SECRET_KEY_TEST: 'rk_test' })).toEqual(['stripe', 'plaid', 'chargebee'])
    expect(hostedUnlisted({ AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live', AGFN_OFFER_CHARGEBEE: '1' })).toEqual([])
  })
  it('hosted: Carta only once it points at production (the playground has fake personas)', () => {
    const live = { AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live', CARTA_CLIENT_ID: 'c', AGFN_OFFER_CHARGEBEE: '1' }
    expect(hostedUnlisted({ ...live, CARTA_ENV: 'playground' })).toEqual(['carta'])
    expect(hostedUnlisted({ ...live, CARTA_ENV: 'production' })).toEqual([])
  })
  it('hosted: Chargebee only once AGFN_OFFER_CHARGEBEE=1 (staging offers it with the test connectors)', () => {
    const live = { AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live' }
    expect(hostedUnlisted(live)).toEqual(['chargebee'])
    expect(hostedUnlisted({ ...live, AGFN_OFFER_CHARGEBEE: '1' })).toEqual([])
  })
  it('hosted: Coinbase only once AGFN_OFFER_COINBASE=1, after its OAuth client exists', () => {
    const live = { AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live', AGFN_OFFER_CHARGEBEE: '1' }
    expect(hostedUnlisted(live)).toEqual([])
    expect(hostedUnlisted({ ...live, COINBASE_CLIENT_ID: 'c' })).toEqual(['coinbase'])
    expect(hostedUnlisted({ ...live, COINBASE_CLIENT_ID: 'c', AGFN_OFFER_COINBASE: '1' })).toEqual([])
  })
  it('hosted: Gumroad only once AGFN_OFFER_GUMROAD=1, after Aggregate’s app exists', () => {
    const live = { AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live', AGFN_OFFER_CHARGEBEE: '1' }
    expect(hostedUnlisted({ ...live, GUMROAD_CLIENT_ID: 'g' })).toEqual(['gumroad'])
    expect(hostedUnlisted({ ...live, GUMROAD_CLIENT_ID: 'g', AGFN_OFFER_GUMROAD: '1' })).toEqual([])
    expect(hostedUnlisted({ ...live, GUMROAD_CLIENT_ID: 'g', AGFN_OFFER_TEST_CONNECTORS: '1' })).toEqual([])
  })
  it('the challenge app offers sandbox Plaid (players link its test bank on purpose)', () => {
    expect(hostedUnlisted({ AGFN_HOSTED: '1', AGFN_CHALLENGE: '1', PLAID_ENV: 'sandbox' })).not.toContain('plaid')
  })
  it('staging opts back in to test-mode connectors', () => {
    expect(hostedUnlisted({ AGFN_HOSTED: '1', PLAID_ENV: 'sandbox', AGFN_OFFER_TEST_CONNECTORS: '1' })).toEqual([])
  })
})

describe('the catalog and connect on hosted', () => {
  it('before Plaid production and a live Stripe key: neither is offered, and starting one says it is coming soon', async () => {
    const { keys, startConnect } = await start({ AGFN_HOSTED: '1', PLAID_ENV: 'sandbox' })
    expect(await keys()).toEqual(['mercury', 'simplefin'])
    for (const [key, words] of [['plaid', /coming soon.*SimpleFIN/], ['stripe', /coming soon/]] as const) {
      const res = await startConnect(key)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { message: string }).message).toMatch(words)
    }
  })

  it('connectors not yet verified end to end are marked beta on hosted', async () => {
    const { list } = await start({ AGFN_HOSTED: '1', PLAID_ENV: 'production' })
    const beta = Object.fromEntries((await list()).map((d) => [d.key, d.beta === true]))
    expect(beta).toMatchObject({ mercury: true, simplefin: false, plaid: false })
    const config = loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, AGFN_HOSTED: '1' })
    expect(config.beta).toEqual(expect.arrayContaining(['mercury', 'brex', 'ramp', 'wise', 'paddle', 'appstore', 'googleplay']))
    expect(config.beta).not.toContain('simplefin')
    expect(config.beta).not.toContain('shopify')
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }).beta).toBeUndefined()
  })

  it('once live: both are offered', async () => {
    const { keys } = await start({ AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live_x' })
    expect(await keys()).toEqual(expect.arrayContaining(['plaid', 'stripe', 'simplefin']))
  })
})

describe('an operator pause (AGFN_HIDE_CONNECTORS)', () => {
  it('parses a comma or space separated list of keys', () => {
    expect(hiddenConnectors({ AGFN_HIDE_CONNECTORS: 'plaid, Square  stripe,,' })).toEqual(['plaid', 'square', 'stripe'])
    expect(hiddenConnectors({})).toEqual([])
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }).hidden).toBeUndefined()
  })

  it('production Plaid paused: not in the catalog, start says paused, and existing connections keep running', async () => {
    const { keys, startConnect } = await start({ AGFN_HOSTED: '1', PLAID_ENV: 'production', STRIPE_APP_SECRET_KEY_LIVE: 'rk_live_x', AGFN_HIDE_CONNECTORS: 'plaid' })
    expect(await keys()).not.toContain('plaid')
    expect(await keys()).toEqual(expect.arrayContaining(['stripe', 'simplefin']))
    const res = await startConnect('plaid')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { message: string }).message).toMatch(/paused.*keep updating/)
    // Still registered: syncs, reconnects (update mode) and webhooks for existing connections all go through it.
    expect(booted!.services.registry.has('plaid')).toBe(true)
  })

  it('applies on a self-hosted server too, and staging\'s test-connector opt-in does not undo it', async () => {
    expect((await (await start({ AGFN_HIDE_CONNECTORS: 'stripe' })).keys())).not.toContain('stripe')
    const staging = await start({ AGFN_HOSTED: '1', PLAID_ENV: 'sandbox', AGFN_OFFER_TEST_CONNECTORS: '1', AGFN_HIDE_CONNECTORS: 'plaid' })
    expect(await staging.keys()).not.toContain('plaid')
  })
})
