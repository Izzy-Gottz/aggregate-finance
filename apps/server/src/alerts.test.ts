import { describe, expect, it, vi } from 'vitest'
import { createAlerter } from './alerts.ts'

describe('alerts', () => {
  it('posts warnings once per 10 minutes, drops unsafe fields, ignores info', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bodies: string[] = []
    let t = 0
    const a = createAlerter({ webhookUrl: 'https://hooks.example/x', now: () => t, fetch: (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('ok'))) as typeof fetch })
    a('info', 'started')
    a('error', 'sync failed', { connector: 'plaid', accessToken: 'secret-tok', amount: 5 })
    a('error', 'sync failed', { connector: 'plaid' })
    t += 11 * 60_000
    a('error', 'sync failed', { connector: 'plaid' })
    await a.flush()
    expect(bodies).toHaveLength(2)
    const text = (JSON.parse(bodies[0]!) as { text: string }).text
    expect(text).toContain('sync failed (connector=plaid)')
    expect(bodies[0]).not.toContain('secret-tok')
    expect(bodies[0]).not.toContain('amount')
  })

  it('scrubs every alert: a job or sync error can hold an amount, an email, a key or a card number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bodies: string[] = []
    const a = createAlerter({ telegram: { botToken: 't', chatId: 'c' }, now: () => 0, fetch: (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('{}'))) as never })
    a('error', 'job failed', { job: 'sync.all', error: 'charge of $1,234.56 for alice.smith@example.com failed: rk_live_abc123, card 4111111111111111, balance 987.65' })
    a('error', 'failed for bob.jones@example.com', { connector: 'stripe' })
    await a.flush()
    const all = bodies.join('\n')
    for (const s of ['1,234.56', '987.65', 'alice.smith', 'bob.jones', 'rk_live_abc123', '4111111111111111']) expect(all).not.toContain(s)
    expect(all).toContain('job failed')
    expect(all).toContain('[amount]')
  })

  it('a burst sends one alert per kind per workspace per 10 minutes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bodies: string[] = []
    const a = createAlerter({ webhookUrl: 'https://hooks.example/x', now: () => 0, fetch: (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('ok'))) as typeof fetch })
    for (let i = 0; i < 50; i++) a('error', 'ai alert: audit_append_failed', { workspaceId: 'ws_a', kind: 'audit_append_failed' })
    a('error', 'ai alert: audit_append_failed', { workspaceId: 'ws_b', kind: 'audit_append_failed' })
    await a.flush()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain('workspaceId=ws_b kind=audit_append_failed')
  })

  it('sends to Telegram as plain text when a bot token and chat id are set, with the same dedup, and never logs the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const calls: Array<{ url: string; body: string }> = []
    const a = createAlerter({ telegram: { botToken: '123:SECRET-tok', chatId: '-1001' }, label: 'app.aggregate.finance', now: () => 0, fetch: (async (u: string, init: RequestInit) => (calls.push({ url: u, body: String(init.body) }), new Response('{"ok":true}'))) as typeof fetch })
    a('info', 'started')
    a('error', 'job failed', { job: 'sync' })
    a('error', 'job failed', { job: 'sync' })
    await a.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:SECRET-tok/sendMessage')
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: '-1001', text: '🔴 app.aggregate.finance: job failed (job=sync)' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-tok')
    // A failing send stays silent (its error would carry the URL, and so the token).
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = createAlerter({ telegram: { botToken: '123:SECRET-tok', chatId: '-1001' }, fetch: (async () => { throw new Error('fetch failed https://api.telegram.org/bot123:SECRET-tok/sendMessage') }) as typeof fetch })
    b('error', 'x')
    await b.flush()
    expect(JSON.stringify([...warn.mock.calls, ...err.mock.calls])).not.toContain('SECRET-tok')
  })

  it('sends to both the webhook and Telegram when both are set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const urls: string[] = []
    const a = createAlerter({ webhookUrl: 'https://hooks.example/x', telegram: { botToken: 't', chatId: '1' }, fetch: (async (u: string) => (urls.push(u), new Response('ok'))) as typeof fetch })
    a('warn', 'y')
    await a.flush()
    expect(urls).toEqual(['https://hooks.example/x', 'https://api.telegram.org/bott/sendMessage'])
  })

  it('only logs when no webhook is set', async () => {
    const f = vi.fn()
    const a = createAlerter({ fetch: f as never })
    a('error', 'x')
    await a.flush()
    expect(f).not.toHaveBeenCalled()
  })
})
