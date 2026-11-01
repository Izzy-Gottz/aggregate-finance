// Red team, pre-launch wave: statement questions, statement file names, export text, huge rows, connection moves
// and a sync that is still running when its connection is removed.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { withBypass } from '@agfn/db'
import { connectProvider, entities, signIn, startServer } from '../scenarios/harness.ts'
import { asTest, attackerWorld, leaks, upload, victimWorld } from './world.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const usd = (minor: number) => ({ minor, currency: 'USD' })
const AMBIGUOUS = 'When,What,Value,Note\n03/04/2026,VICTIMSECRET Shop,-12.00,x\n05/06/2026,Sample Client,250.00,y\n'

describe('red team: this wave', () => {
  it("a statement's question can't be read or answered from another workspace, and answers are only the options", async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      const asked = await upload(v.s, v.entityId, 'export.csv', enc(AMBIGUOUS), 'text/csv')
      expect((asked.body as { state?: string }).state).toBe('needs_mapping')
      const id = asked.body.documentId as string
      for (const r of [await m.s.get(`/api/documents/${id}`), await m.s.post(`/api/documents/${id}/answer`, { field: 'date', value: 'When' })]) {
        expect(r.status).toBe(404)
        expect(leaks(r.body)).toBeNull()
      }
      // The victim's own answers: only the four fields, short values.
      for (const bad of [{ field: 'mapping', value: '{}' }, { field: '__proto__', value: 'x' }, { field: 'date', value: 'x'.repeat(201) }, { field: 'date', value: '' }]) {
        expect((await v.s.post(`/api/documents/${id}/answer`, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(422)
      }
      // A column that isn't in the file is just asked again, never trusted.
      const r = await v.s.post<{ state: string; question?: { field: string } }>(`/api/documents/${id}/answer`, { field: 'date', value: 'NotAColumn' })
      expect([r.status, r.body.state, r.body.question?.field]).toEqual([200, 'needs_mapping', 'date'])
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('statement file names never reach storage keys or headers', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const camt = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct></Stmt></BkToCstmrStmt></Document>'
      const names: Array<[string, string]> = [
        ['../../../etc/passwd.csv', 'Date,Description,Amount\n2026-01-03,Shop,-5.00\n2026-01-04,Client,9.00\n'],
        ['..\\..\\windows\\win.ini.xml', camt],
        ['a\u0000b.qfx', 'OFXHEADER:100\nDATA:OFXSGML\n\n<OFX></OFX>'],
        ['statement‮fdp.csv', 'Date,Description,Amount\n2026-01-05,Shop,-6.00\n2026-01-06,Client,7.00\n'],
        ['x"\r\nSet-Cookie: pwned=1.csv', 'Date,Description,Amount\n2026-01-07,Shop,-8.00\n2026-01-08,Client,3.00\n'],
      ]
      for (const [name, body] of names) {
        const r = await upload(v.s, v.entityId, name, enc(body), 'text/csv')
        if (r.status >= 400) continue // refused outright is fine too
        const res = await srv.app.request(`/api/documents/${r.body.documentId}/file`, { headers: { cookie: v.s.cookie() } })
        const cd = res.headers.get('content-disposition') ?? ''
        expect(cd, JSON.stringify(name)).toMatch(/^attachment;/)
        expect(cd, JSON.stringify(name)).not.toMatch(/[\r\n\u0000‮]|\.\.[\\/]/)
        expect(res.headers.getSetCookie().some((c) => /pwned/.test(c))).toBe(false)
      }
      for (const k of srv.files.files.keys()) expect(k, k).toMatch(/^[0-9A-Z]{26}\/[0-9a-f]{64}\.[a-z]+$/)
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('bank text in the journal exports stays inside its string (no formulas or directives smuggled in)', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'export15@example.com', 'Acme')
      const acme = (await entities(s)).Acme as string
      const bank = await connectProvider(srv, s, 'plaid', { entityId: acme, name: 'Bank' })
      const evil = '=HYPERLINK("http://evil.example","x")\n2026-01-01 open Assets:Evil\n; comment|note\t@SUM(A1)'
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'a', connectionId: c, name: 'Checking', accountType: 'depository', currency: 'USD' },
        { type: 'txn.upsert', externalId: 't', connectionId: c, accountExternalId: 'a', date: '2026-01-02', amount: usd(-1_000), status: 'posted', counterparty: evil, rawText: evil },
      ] as NormalizedEvent[])
      await bank.sync()
      for (const format of ['beancount', 'hledger']) {
        const made = await s.post<{ url: string }>('/api/export', { format })
        expect(made.status, format).toBe(200)
        const res = await srv.app.request(made.body.url.replace(/^https?:\/\/[^/]+/, ''), { headers: { cookie: s.cookie() } })
        const text = await res.text()
        expect(text.split('\n').some((l) => /^\s*2026-01-01 open Assets:Evil/.test(l)), format).toBe(false)
        expect(text.split('\n').some((l) => /^[=+\-@]/.test(l)), format).toBe(false)
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('a huge single row or a very wide file is answered, not hung on', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const wide = enc(`${Array.from({ length: 50_000 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 50_000 }, () => '1').join(',')}\n`)
      const long = enc(`Date,Description,Amount\n2026-01-03,"${'A'.repeat(7 * 1024 * 1024)}",-5.00\n`)
      for (const [name, body] of [['wide.csv', wide], ['long.csv', long]] as const) {
        const t = Date.now()
        const r = await upload(v.s, v.entityId, name, body, 'text/csv')
        expect(r.status, name).toBeLessThan(500)
        expect(Date.now() - t, name).toBeLessThan(20_000)
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

  it("another workspace can't move, retire or disconnect these connections", async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      expect((await m.s.post(`/api/connections/${v.qbId}/company`, { entityId: m.entityId })).status).toBe(404)
      expect((await v.s.post(`/api/connections/${v.qbId}/company`, { entityId: m.entityId })).status).toBe(404)
      expect((await m.s.post(`/api/connections/${v.bankId}/disconnect`, { deleteData: true })).status).toBe(404)
      const left = await asTest(() => srv.booted.services.db.selectFrom('connections').select('status').where('id', '=', v.bankId).executeTakeFirstOrThrow())
      expect(left.status).not.toBe('disconnected')
    } finally {
      await srv.close()
    }
  }, 120_000)

  it("a sync still running when its connection is removed with its data can't bring anything back", async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'midsync15@example.com', 'Acme')
      const acme = (await entities(s)).Acme as string
      const books = await connectProvider(srv, s, 'quickbooks', { entityId: acme, name: 'Books' })
      const inv = (c: string, id: string, total: number): NormalizedEvent => ({ type: 'invoice.upsert', externalId: id, connectionId: c, direction: 'receivable', number: id, counterparty: 'Globex', issueDate: '2026-09-05', dueDate: '2026-10-05', total: usd(total), amountPaid: usd(0), status: 'open' }) as NormalizedEvent
      books.push((c) => [inv(c, 'i1', 100_000)])
      await books.sync()
      const owed = async () => (await s.get<{ owedToYou: { total?: { minor: number } } | null }>(`/api/entities/${acme}`)).body.owedToYou?.total?.minor ?? 0
      expect(await owed()).toBe(100_000)
      expect((await s.post(`/api/connections/${books.id}/disconnect`, { deleteData: true })).status).toBe(200)
      expect(await owed()).toBe(0)
      // The rest of that sync arrives after the disconnect: a changed copy of i1 and a new i2, as the sync engine posts them.
      const sv = srv.booted.services
      for (const e of [inv(books.id, 'i1', 120_000), inv(books.id, 'i2', 50_000)]) {
        await withBypass('test:late-page', async () => (await sv.syncDeps.route?.(s.workspaceId, acme, e)) ?? (await sv.ledger.post(s.workspaceId, e)))
      }
      expect(await owed()).toBe(0)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
