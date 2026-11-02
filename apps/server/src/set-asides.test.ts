// Set-asides through the real tools. The acceptance case comes from a real chat: a "Taxes" bucket held a fixed reserve
// in one savings account as custom fields, and the AI had to tell the person to subtract it by hand. Numbers are made up.
import { describe, expect, it } from 'vitest'
import type { GrantShape } from '@agfn/contracts'
import { connectAi, connectProvider, entities, READ_WRITE_ALL, signIn, startServer, type Server, type Session } from './scenarios/harness.ts'

const usd = (minor: number) => ({ minor, currency: 'USD' })
const ON = { env: { AGFN_SET_ASIDES: '1' } }

async function world(srv: Server, s: Session, entityId: string, name = 'Savings', ext = 'sav', balance = 2_000_000) {
  const bank = await connectProvider(srv, s, 'plaid', { entityId, name })
  bank.push((c) => [
    { type: 'account.upsert', externalId: ext, connectionId: c, name, accountType: 'depository', currency: 'USD', institution: 'Bank' },
    { type: 'balance.snapshot', externalId: `${ext}-b`, connectionId: c, accountExternalId: ext, at: new Date(Date.now() - 86_400_000).toISOString(), current: usd(balance) },
  ])
  expect((await bank.sync()).status).toBe('ok')
}
const accountId = async (ai: Awaited<ReturnType<typeof connectAi>>, name: string, company?: string) => (await ai.call<{ accounts: Array<{ id: string; name: string }> }>('list_accounts', company ? { company } : {})).accounts.find((a) => a.name === name)!.id

describe('set-asides through the tools', () => {
  it('a Taxes bucket made with custom fields is upgraded in place: available cash drops, the tool says so, the due date is the goal date', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'taxes@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const made = await ai.call<{ record_id: string }>('create_bucket', { company: 'Acme', name: 'Taxes', fields: [{ key: 'reserved', label: 'Reserved', type: 'number' }, { key: 'held_in', label: 'Held in', type: 'text' }], values: { reserved: 7500, held_in: 'Savings' }, idempotency_key: 'taxes-fields-1' })
      const cash = (m: string) => ai.call<{ value: { amount: string } }>('get_metric', { metric: m, company: 'Acme' })
      expect((await cash('available_cash')).value.amount).toBe('20000.00')

      await ai.call('update_bucket', { bucket_id: made.record_id, set_aside: { allocations: [{ account_id: await accountId(ai, 'Savings'), amount: { amount: '7500.00', currency: 'USD' } }], counts_in_cash: false, goal: { amount: { amount: '7500.00', currency: 'USD' }, by: '2027-04-15' } }, idempotency_key: 'taxes-upgrade-1' })
      expect((await cash('cash')).value.amount).toBe('20000.00')
      expect((await cash('available_cash')).value.amount).toBe('12500.00')

      const b = await ai.call<{ id: string; values: unknown; set_aside: { held: { amount: string }; counts_in_cash: boolean; cash_effect: string; goal: { by: string; progress_percent: number } } }>('get_bucket', { id: made.record_id })
      expect(b.id).toBe(made.record_id)
      expect(b.values).toEqual({ reserved: 7500, held_in: 'Savings' })
      expect(b.set_aside).toMatchObject({ held: { amount: '7500.00' }, counts_in_cash: false, goal: { by: '2027-04-15', progress_percent: 100 } })
      expect(b.set_aside.cash_effect).toContain("don't subtract it by hand")

      const ov = await ai.call<{ companies: Array<{ cash: { amount: string }; available_cash: { amount: string }; set_aside: { amount: string }; cash_effect: string }> }>('get_overview', { company: 'Acme' })
      expect(ov.companies[0]).toMatchObject({ cash: { amount: '20000.00' }, available_cash: { amount: '12500.00' }, set_aside: { amount: '7500.00' } })

      // The app gets what "Cash $12,500 · $7,500 set aside" needs.
      const detail = (await s.get<{ entity: { setAside?: { available: { minor: number }; held: { minor: number } } } }>(`/api/entities/${E['Acme']}`)).body
      expect(detail.entity.setAside).toMatchObject({ available: { minor: 1_250_000 }, held: { minor: 750_000 } })

      await ai.call('update_bucket', { bucket_id: made.record_id, set_aside: null, idempotency_key: 'taxes-remove-1' })
      expect((await cash('available_cash')).value.amount).toBe('20000.00')
      expect((await ai.call<{ id: string }>('get_bucket', { id: made.record_id })).id).toBe(made.record_id)
    } finally {
      await srv.close()
    }
  })

  it('on: a dry_run preview of the bucket tools records nothing', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'preview@example.test', 'Acme')
      await world(srv, s, (await entities(s))['Acme'] as string)
      const ai = await connectAi(srv, s)
      const account_id = await accountId(ai, 'Savings')
      const set_aside = { allocations: [{ account_id, amount: { amount: '100.00', currency: 'USD' } }], counts_in_cash: false }
      const preview = await ai.call<{ summary: string }>('create_bucket', { company: 'Acme', name: 'Taxes', set_aside, idempotency_key: 'preview-1', dry_run: true })
      expect(preview.summary).toBeTruthy()
      const list = () => ai.call<{ buckets: unknown[] }>('list_buckets', { company: 'Acme' })
      expect((await list()).buckets).toHaveLength(0)

      const made = await ai.call<{ record_id: string }>('create_bucket', { company: 'Acme', name: 'Taxes', idempotency_key: 'preview-2' })
      await ai.call('update_bucket', { bucket_id: made.record_id, set_aside, idempotency_key: 'preview-3', dry_run: true })
      expect((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'available_cash', company: 'Acme' })).value.amount).toBe('20000.00')
    } finally {
      await srv.close()
    }
  })

  it('off (the default): the tools publish no set_aside and no available_cash', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'off@example.test', 'Acme')
      await world(srv, s, (await entities(s))['Acme'] as string)
      const ai = await connectAi(srv, s)
      await expect(ai.call('get_metric', { metric: 'available_cash', company: 'Acme' })).rejects.toThrow()
    } finally {
      await srv.close()
    }
  })

  it('an AI can name only accounts its grant shows, and a reader sees only accounts in companies whose balances they see', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'two@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string, 'Acme bank', 'a', 1_000_000)
      await world(srv, s, E['Personal'] as string, 'HIDDENPERSONAL', 'p', 3_000_000)
      const full = await connectAi(srv, s, { ...READ_WRITE_ALL, dataTypes: [...READ_WRITE_ALL.dataTypes, 'personal'] } as GrantShape, 'Full bot')
      const personal = await accountId(full, 'HIDDENPERSONAL', 'Personal')
      const acme = await accountId(full, 'Acme bank')
      const made = await full.call<{ record_id: string }>('create_bucket', { company: 'Acme', name: 'Reserve', set_aside: { allocations: [{ account_id: acme, amount: { amount: '100.00', currency: 'USD' } }, { account_id: personal, percent: 50 }], goal: { amount: { amount: '20000.00', currency: 'USD' } } }, idempotency_key: 'reserve-both-1' })

      const narrow = await connectAi(srv, s, READ_WRITE_ALL, 'Narrow bot')
      const got = await narrow.call<{ set_aside: { held: { amount: string }; per_account: unknown[]; goal: { progress_percent: number } } }>('get_bucket', { id: made.record_id })
      expect(JSON.stringify(got)).not.toContain('HIDDENPERSONAL')
      expect(got.set_aside).toMatchObject({ held: { amount: '100.00' }, goal: { progress_percent: 0 } })
      expect(got.set_aside.per_account).toHaveLength(1)
      await expect(narrow.call('create_bucket', { company: 'Acme', name: 'Sneaky', set_aside: { allocations: [{ account_id: personal, percent: 10 }] }, idempotency_key: 'sneaky-bucket-1' })).rejects.toThrow(/No account/)
    } finally {
      await srv.close()
    }
  })

  it('on: more set aside than the account holds shows in Review with no buttons to press, and the overview line gives available cash', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'short@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const id = await accountId(ai, 'Savings')
      const ok = await s.post('/api/buckets', { entityId: E['Acme'], name: 'Taxes', setAside: { allocations: [{ accountId: id, amount: usd(500_000) }], countsInCash: false }, idempotencyKey: 'short-bucket-0001' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      const line = await ai.try('get_overview', { company: 'Acme' })
      expect(line.text).toContain('cash $20,000.00 (available $15,000.00 after set-asides)')
      expect((await s.get<Array<{ kind: string }>>('/api/review')).body.map((r) => r.kind)).not.toContain('set_aside_short')
      await s.post('/api/buckets', { entityId: E['Acme'], name: 'Reserve', setAside: { allocations: [{ accountId: id, amount: usd(2_000_000) }], countsInCash: false }, idempotencyKey: 'short-bucket-0002' })
      const review = (await s.get<Array<{ kind: string; title: string; detail: string }>>('/api/review')).body
      expect(review).toContainEqual(expect.objectContaining({ kind: 'set_aside_short', title: 'Set-aside is short' }))
    } finally {
      await srv.close()
    }
  })

  it('off: neither shows', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'off@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const id = await accountId(ai, 'Savings')
      // One saved while the flag was on: the app can't write it now, so it goes straight into the ledger.
      const ok = await s.post<{ id: string }>('/api/buckets', { entityId: E['Acme'], name: 'Taxes', idempotencyKey: 'off-bucket-0001' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      const ws = (await s.get<{ workspace?: { id: string }; workspaces?: Array<{ id: string }> }>('/api/me')).body
      await (srv.booted.services.ledger as unknown as { updateBucket(ws: string, id: string, patch: unknown): Promise<unknown> }).updateBucket((ws.workspace?.id ?? ws.workspaces?.[0]?.id) as string, ok.body.id, { setAside: { allocations: [{ accountId: id, kind: 'fixed', minor: 3_000_000 }], countsInCash: false } })
      const stored = (await s.get<{ canSetAside?: boolean; setAside?: unknown }>(`/api/buckets/${ok.body.id}`)).body
      expect(stored.setAside).toBeUndefined()
      expect(stored.canSetAside).toBeUndefined()
      expect((await s.get<{ entity: { setAside?: unknown } }>(`/api/entities/${E['Acme']}`)).body.entity.setAside).toBeUndefined()
      expect((await ai.try('get_overview', { company: 'Acme' })).text).not.toContain('after set-asides')
      expect((await s.get<Array<{ kind: string }>>('/api/review')).body.map((r) => r.kind)).not.toContain('set_aside_short')
    } finally {
      await srv.close()
    }
  })

  it('a narrow writer changes only what it sees: an allocation on a hidden account stays, and nothing reveals it', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'hidden@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string, 'Acme bank', 'a', 1_000_000)
      await world(srv, s, E['Personal'] as string, 'HIDDENPERSONAL', 'p', 3_000_000)
      const full = await connectAi(srv, s, { ...READ_WRITE_ALL, dataTypes: [...READ_WRITE_ALL.dataTypes, 'personal'] } as GrantShape, 'Full bot')
      const narrow = await connectAi(srv, s, READ_WRITE_ALL, 'Narrow bot')
      const acme = await accountId(full, 'Acme bank')
      const personal = await accountId(full, 'HIDDENPERSONAL', 'Personal')
      const usdAmount = (amount: string) => ({ amount: { amount, currency: 'USD' } })
      const made = await full.call<{ record_id: string }>('create_bucket', { company: 'Acme', name: 'Reserve', set_aside: { allocations: [{ account_id: acme, ...usdAmount('100.00') }, { account_id: personal, ...usdAmount('500.00') }] }, idempotency_key: 'hidden-1' })
      const held = async () => (await full.call<{ set_aside: { per_account: Array<{ account_id: string; held: { amount: string } }> } }>('get_bucket', { id: made.record_id })).set_aside.per_account.map((p) => [p.account_id, p.held.amount]).sort()

      const changed = await narrow.call('update_bucket', { bucket_id: made.record_id, set_aside: { allocations: [{ account_id: acme, ...usdAmount('200.00') }] }, idempotency_key: 'hidden-2' })
      expect(JSON.stringify(changed)).not.toContain('HIDDENPERSONAL')
      expect(await held()).toEqual([[acme, '200.00'], [personal, '500.00']].sort())

      await narrow.call('update_bucket', { bucket_id: made.record_id, set_aside: null, idempotency_key: 'hidden-3' })
      expect(await held()).toEqual([[personal, '500.00']])

      await full.call('update_bucket', { bucket_id: made.record_id, set_aside: null, idempotency_key: 'hidden-4' })
      expect((await full.call<{ set_aside?: unknown }>('get_bucket', { id: made.record_id })).set_aside).toBeFalsy()
    } finally {
      await srv.close()
    }
  })

  it('off, the app matches the tools: nothing offered, nothing shown, writes refused', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'flag@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const id = await accountId(ai, 'Savings')
      const made = await s.post<{ id: string; canSetAside?: boolean; setAside?: unknown }>('/api/buckets', { entityId: E['Acme'], name: 'Taxes', setAside: { allocations: [{ accountId: id, amount: usd(500_000) }], countsInCash: false }, idempotencyKey: 'flag-bucket-0001' })
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      expect(made.body).toMatchObject({ canSetAside: true, setAside: { countsInCash: false } })
      expect(((await s.get<{ entity: { setAside?: unknown } }>(`/api/entities/${E["Acme"]}`)).body).entity.setAside).toBeTruthy()
    } finally {
      await srv.close()
    }
    const off = await startServer()
    try {
      const s = await signIn(off, 'off@example.test', 'Acme')
      const E = await entities(s)
      await world(off, s, E['Acme'] as string)
      const made = await s.post<{ id: string; canSetAside?: boolean }>('/api/buckets', { entityId: E['Acme'], name: 'Rent', idempotencyKey: 'off-bucket-0001' })
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      expect(made.body.canSetAside).toBeUndefined()
      const ask = { allocations: [{ accountId: 'a', amount: usd(100) }] }
      const patched = await s.send<{ message?: string }>('PATCH', `/api/buckets/${made.body.id}`, { setAside: ask, idempotencyKey: 'off-bucket-0002' })
      expect(patched.status).toBe(400)
      expect(JSON.stringify(patched.body)).toContain('Setting money aside isn’t available yet.')
      expect((await s.post('/api/buckets', { entityId: E['Acme'], name: 'Taxes', setAside: ask, idempotencyKey: 'off-bucket-0003' })).status).toBe(400)
      expect(((await s.get<{ entity: { setAside?: unknown } }>(`/api/entities/${E["Acme"]}`)).body).entity.setAside).toBeUndefined()
    } finally {
      await off.close()
    }
  })

  it('a change that leaves out the goal, note and counts_in_cash keeps them, in the app and from an AI; null removes the goal', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'keep@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const id = await accountId(ai, 'Savings')
      type Held = { id: string; setAside: { countsInCash: boolean; note?: string; held: { minor: number }; goal?: { target: { minor: number } } } }
      const made = await s.post<Held>('/api/buckets', { entityId: E['Acme'], name: 'Taxes', setAside: { allocations: [{ accountId: id, amount: usd(500_000) }], countsInCash: false, note: 'For Q4', goal: { amount: usd(1_000_000) } }, idempotencyKey: 'keep-bucket-0001' })
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      const url = `/api/buckets/${made.body.id}`
      const kept = (await s.send<Held>('PATCH', url, { setAside: { allocations: [{ accountId: id, amount: usd(600_000) }] }, idempotencyKey: 'keep-bucket-0002' })).body.setAside
      expect(kept).toMatchObject({ countsInCash: false, note: 'For Q4', held: { minor: 600_000 }, goal: { target: { minor: 1_000_000 } } })
      await ai.call('update_bucket', { bucket_id: made.body.id, set_aside: { allocations: [{ account_id: id, amount: { amount: '7000.00', currency: 'USD' } }] }, idempotency_key: 'keep-bucket-ai' })
      const afterAi = (await s.get<Held>(url)).body.setAside
      expect(afterAi).toMatchObject({ countsInCash: false, note: 'For Q4', held: { minor: 700_000 }, goal: { target: { minor: 1_000_000 } } })
      const cleared = (await s.send<Held>('PATCH', url, { setAside: { allocations: [{ accountId: id, amount: usd(600_000) }], goal: null }, idempotencyKey: 'keep-bucket-0003' })).body.setAside
      expect(cleared.goal).toBeUndefined()
      expect(cleared).toMatchObject({ countsInCash: false, note: 'For Q4' })
      const noNote = (await s.send<Held>('PATCH', url, { setAside: { allocations: [{ accountId: id, amount: usd(600_000) }], note: null }, idempotencyKey: 'keep-bucket-0004' })).body.setAside
      expect(noNote.note).toBeUndefined()
      expect(noNote.countsInCash).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('the app path takes a set-aside, and refuses a bad one in plain words', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'app@example.test', 'Acme')
      const E = await entities(s)
      await world(srv, s, E['Acme'] as string)
      const ai = await connectAi(srv, s)
      const id = await accountId(ai, 'Savings')
      const ok = await s.post<{ id: string; setAside: { held: { minor: number } } }>('/api/buckets', { entityId: E['Acme'], name: 'Taxes', setAside: { allocations: [{ accountId: id, amount: usd(500_000) }], countsInCash: false }, idempotencyKey: 'app-bucket-0001' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      expect(ok.body.setAside.held.minor).toBe(500_000)
      const bad = await s.post('/api/buckets', { entityId: E['Acme'], name: 'Both', setAside: { allocations: [{ accountId: id, percent: 10, amount: usd(1) }] }, idempotencyKey: 'app-bucket-0002' })
      expect(bad.status).toBeGreaterThanOrEqual(400)
    } finally {
      await srv.close()
    }
  })
})
