import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { createFilesConnector } from '@agfn/connector-files'
import { chaseChecking } from '@agfn/connector-files/pdf-samples'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor, mcpFor } from './modules.ts'
import { financeFor } from './finance.ts'
import { adoptStatementAccounts } from './retire.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

// A synced bank: Checking ··0000 with two United Airlines refunds and a $1,520.00 balance.
const bank = (deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'fakebank', name: 'Fake Bank', group: 'banks', provides: ['balances', 'transactions'], freshness: 'instant', auth: 'api_key' }),
  connect: async () => ({ secret: { k: 1 }, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async (conn: ConnectionRef) => {
    const r = (id: string) => deps.raw.put(conn.id, 'x', id, {})
    const events = [
      { type: 'account.upsert', externalId: 'chk', name: 'Plaid Checking', accountType: 'depository', currency: 'USD', mask: '0000', institution: 'First Platypus Bank', rawRef: await r('a') },
      { type: 'txn.upsert', externalId: 't1', accountExternalId: 'chk', date: '2026-10-09', amount: { minor: 50_000, currency: 'USD' }, status: 'posted', description: 'United Airlines', rawRef: await r('t1') },
      { type: 'txn.upsert', externalId: 't2', accountExternalId: 'chk', date: '2026-09-09', amount: { minor: 50_000, currency: 'USD' }, status: 'posted', description: 'United Airlines', rawRef: await r('t2') },
      { type: 'balance.snapshot', externalId: 'chk@1', accountExternalId: 'chk', at: '2026-10-10T00:00:00.000Z', current: { minor: 152_000, currency: 'USD' }, rawRef: await r('b') },
    ].map((e) => ({ ...e, connectionId: conn.id })) as NormalizedEvent[]
    return { events, cursor: null, hasMore: false }
  },
})

// The Chase account the uploaded QFX is for (••4421), now connected through a bank feed: the same January rows under
// the bank's own ids, one later row, and today's balance.
const chase = (deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'chasefeed', name: 'Chase feed', group: 'banks', provides: ['balances', 'transactions'], freshness: 'instant', auth: 'api_key' }),
  connect: async () => ({ secret: { k: 1 }, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async (conn: ConnectionRef) => {
    const r = (id: string) => deps.raw.put(conn.id, 'x', id, {})
    const rows: Array<[string, string, number, string]> = [['p1', '2026-01-05', -4_210, 'SAMPLE GROCER'], ['p2', '2026-01-09', 150_000, 'SAMPLE EMPLOYER PAYROLL'], ['p3', '2026-01-09', -4_210, 'SAMPLE GROCER'], ['p4', '2026-01-12', -25_000, 'CHECK 1044'], ['p5', '2026-01-18', -999, 'SAMPLE STREAMING']]
    const events = [
      { type: 'account.upsert', externalId: 'chk', name: 'TOTAL CHECKING', accountType: 'depository', currency: 'USD', mask: '4421', institution: 'Chase', rawRef: await r('a') },
      ...(await Promise.all(rows.map(async ([id, date, minor, text]) => ({ type: 'txn.upsert', externalId: id, accountExternalId: 'chk', date, amount: { minor, currency: 'USD' }, status: 'posted', counterparty: text, rawText: text, rawRef: await r(id) })))),
      { type: 'balance.snapshot', externalId: 'chk@1', accountExternalId: 'chk', at: '2026-01-20T00:00:00.000Z', current: { minor: 315_571, currency: 'USD' }, rawRef: await r('b') },
    ].map((e) => ({ ...e, connectionId: conn.id })) as NormalizedEvent[]
    return { events, cursor: null, hasMore: false }
  },
})

/** The upload queue the files connector reads (captured at boot). */
let source: { list(connectionId: string, after: string | null): Promise<Array<{ fileId: string }>>; report(c: string, f: string, o: unknown): Promise<void> }

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push(m.text) },
    ledger: (h) => ledgerFor(h.db),
    mcp: (s) => mcpFor(s, financeFor(s)),
    connectors: ({ fileSource }) => ((source = fileSource as never), [bank, chase, (d) => createFilesConnector({ source: fileSource as never }, d)]),
    fileStore: new MemoryFileStore(),
  })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const db = booted.services.db
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
const csv = 'Date,Description,Amount\n2026-10-09,United Airlines,500.00\n2026-09-09,United Airlines,500.00\n2026-10-05,Corner Hardware,-42.17\n'

async function setup(withBank: boolean, email = withBank ? 'bank@example.com' : 'nobank@example.com') {
  const cookie = await signIn(email)
  const ws = (await (await app.request('/api/workspaces', post(cookie, { companyName: 'Testco' }))).json()) as { workspaceId: string; companyId: string }
  if (withBank) {
    const start = (await (await app.request('/api/connectors/fakebank/start', post(cookie, { entityId: ws.companyId }))).json()) as { state: string }
    const fin = (await (await app.request('/api/connectors/fakebank/finish', post(cookie, { state: start.state, apiKey: 'k' }))).json()) as { accounts: Array<{ id: string }> }
    await app.request('/api/accounts/assign', post(cookie, { assignments: fin.accounts.map((a) => ({ accountId: a.id, entityId: ws.companyId })) }))
  }
  const upload = (name: string, body: string | Uint8Array, accountId?: string) => {
    const fd = new FormData()
    fd.set('file', new File([typeof body === 'string' ? body : new Uint8Array(body)], name))
    fd.set('entityId', ws.companyId)
    if (accountId) fd.set('accountId', accountId)
    return app.request('/api/documents', { method: 'POST', headers: { origin: BASE, cookie }, body: fd })
  }
  const cash = async () => {
    const v = (await booted.services.ledger.metric('cash', { workspaceId: ws.workspaceId, entityIds: [ws.companyId] })).value
    return v && typeof v === 'object' && 'minor' in v ? v.minor : null
  }
  return { cookie, ws, upload, cash }
}

describe('uploaded statements never count an account twice', () => {
  it('asks which account a statement is for, and a statement for a synced account leaves cash unchanged', async () => {
    const { cookie, upload, cash } = await setup(true)
    expect(await cash()).toBe(152_000)
    const r = await upload('checking-oct.csv', csv)
    expect(r.status).toBe(201)
    const out = (await r.json()) as { documentId: string; state: string; message: string; accounts: Array<{ id: string; name: string; mask?: string }> }
    expect(out).toMatchObject({ state: 'needs_account', message: 'Which account is this statement for?' })
    expect(out.accounts).toEqual([expect.objectContaining({ name: 'Plaid Checking', mask: '0000' })])
    expect(await cash()).toBe(152_000)

    // The same bytes again (another name) bring the same question back, not a dead end.
    const again = (await (await upload('checking-oct (1).csv', csv)).json()) as { documentId: string; state: string; accounts?: unknown[] }
    expect(again).toMatchObject({ documentId: out.documentId, state: 'needs_account', accounts: out.accounts })

    // Waiting statements can be listed (email-in has no upload drawer) and fetched one by one.
    const get = (path: string) => app.request(path, { headers: { origin: BASE, cookie } })
    const waiting = (await (await get('/api/documents?state=needs_account')).json()) as Array<{ documentId: string; accounts: unknown[] }>
    expect(waiting).toEqual([expect.objectContaining({ documentId: out.documentId, name: 'checking-oct.csv', accounts: out.accounts })])
    expect(await (await get(`/api/documents/${out.documentId}`)).json()).toMatchObject({ state: 'needs_account', accounts: out.accounts })

    const chosen = await app.request(`/api/documents/${out.documentId}/account`, post(cookie, { accountId: out.accounts[0]!.id }))
    expect(chosen.status).toBe(200)
    expect(await chosen.json()).toMatchObject({ state: 'imported', message: 'Imported 3 rows.' })
    // The statement's account is the same real account: its balance never adds to cash.
    expect(await cash()).toBe(152_000)
    expect(await (await get('/api/documents?state=needs_account')).json()).toEqual([])
    expect(await (await get(`/api/documents/${out.documentId}`)).json()).toMatchObject({ state: 'imported' })
  })

  // The account we sync is "Plaid Checking ••0000" at First Platypus Bank.
  const ofxFor = (org: string) =>
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>${org ? `<SIGNONMSGSRSV1><SONRS><FI><ORG>${org}</ORG></FI></SONRS></SIGNONMSGSRSV1>` : ''}<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>011000015<ACCTID>9876540000<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261001<DTEND>20261010<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-42.17<FITID>f1<NAME>Corner Hardware</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>1477.83<DTASOF>20261010</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

  it('matches an OFX/QFX to an account when the file names the same bank', async () => {
    const { upload, cash } = await setup(true)
    const out = (await (await upload('checking.ofx', ofxFor('First Platypus Bank'))).json()) as { state: string; message: string }
    expect(out).toMatchObject({ state: 'imported', message: 'Imported 1 row.' })
    expect(await cash()).toBe(152_000)
  })

  it('an OFX with no bank name is not merged into a synced account by its last 4 alone (money stays in cash)', async () => {
    const { upload, cash } = await setup(true)
    const before = await cash()
    // Same ACCTID ••0000 as the synced account, but no <FI><ORG> — we can't confirm it's that account, so we ask
    // instead of silently marking it a duplicate (which hid the upload's money). 43's exact case.
    const out = (await (await upload('mystery.ofx', ofxFor(''))).json()) as { documentId: string; state: string; message: string }
    expect(out).toMatchObject({ state: 'needs_account', message: 'Which account is this statement for?' })
    expect(await cash()).toBe(before)
    // Nothing was linked as a duplicate behind the person's back.
    const dupes = await booted.handle.db.selectFrom('accounts').select('id').where('duplicate_of', 'is not', null).execute()
    expect(dupes).toHaveLength(0)
  })

  const bankConnId = (wsId: string) => booted.handle.db.selectFrom('connections').select('id').where('connector_key', '=', 'fakebank').where('workspace_id', '=', wsId).executeTakeFirstOrThrow().then((r) => r.id)
  const dupeIds = () => booted.handle.db.selectFrom('accounts').select('id').where('duplicate_of', 'is not', null).execute().then((rs) => rs.map((r) => r.id))

  it("a no-bank-name OFX chosen 'new' is never adopted by a later bank sync (43's second path; money stays in cash)", async () => {
    const { cookie, ws, upload, cash } = await setup(true)
    // Explicitly choose "new": a separate account, same ••0000 as the synced Plaid account but no <ORG>.
    const up = (await (await upload('mystery.ofx', ofxFor(''))).json()) as { documentId: string; state: string }
    expect(up.state).toBe('needs_account')
    expect(await (await app.request(`/api/documents/${up.documentId}/account`, post(cookie, { accountId: 'new' }))).json()).toMatchObject({ state: 'imported' })
    const withUpload = await cash()
    const dupesBefore = await dupeIds()
    // adoptStatementAccounts runs on every bank sync. It must NOT adopt the account the person kept separate, by last 4
    // alone, and hide its balance (the bug). 43's exact sequence.
    expect(await adoptStatementAccounts(booted.services, ws.workspaceId, await bankConnId(ws.workspaceId))).toBe(0)
    expect(await dupeIds()).toEqual(dupesBefore)
    expect(await cash()).toBe(withUpload)

    // The lock is the only thing holding it apart: clear the "keep separate" marker and the same sync now adopts it by
    // last 4 (the ordinary "statement first, bank later" behaviour still works — it was the explicit choice we honoured).
    await booted.handle.db.deleteFrom('settings').where('key', 'like', 'stmt:keep_separate:%').execute()
    expect(await adoptStatementAccounts(booted.services, ws.workspaceId, await bankConnId(ws.workspaceId))).toBe(1)
    expect((await dupeIds()).length).toBe(1)
    expect(await cash()).toBe(152_000)
  })

  it('a date-only month-end balance stays on its day in New York (OFX DTASOF 20261031 → Oct 31)', async () => {
    const { ws, upload } = await setup(false, 'tz-ny@example.com')
    const db = booted.services.db as unknown as { updateTable(t: string): { set(v: object): { where(a: string, b: string, c: string): { execute(): Promise<unknown> } } } }
    await db.updateTable('workspaces').set({ time_zone: 'America/New_York' }).where('id', '=', ws.workspaceId).execute()
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>011000015<ACCTID>5550001031<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261001<DTEND>20261031<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261031<TRNAMT>-42.17<FITID>m1<NAME>Corner Hardware</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>1477.83<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(((await (await upload('oct.ofx', ofx)).json()) as { state: string }).state).toBe('imported')
    const engine = booted.services.ledger as unknown as { store: { listRecords(ws: string, q: object): Promise<Array<{ date: string; externalId: string }>> } }
    const snaps = await engine.store.listRecords(ws.workspaceId, { eventTypes: ['balance.snapshot'] })
    expect(snaps.map((r) => [r.date, r.externalId.slice(-10)])).toEqual([['2026-10-31', '2026-10-31']])
  })

  it('a date-only camt.053 closing balance stays on its day in Berlin (2026-10-31 → Oct 31, not Nov 1)', async () => {
    const { ws, upload } = await setup(false, 'tz-berlin@example.com')
    const db = booted.services.db as unknown as { updateTable(t: string): { set(v: object): { where(a: string, b: string, c: string): { execute(): Promise<unknown> } } } }
    await db.updateTable('workspaces').set({ time_zone: 'Europe/Berlin' }).where('id', '=', ws.workspaceId).execute()
    const camt =
      `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>DE89 3704 0044 0532 0130 00</IBAN></Id><Ccy>EUR</Ccy></Acct>` +
      `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1477.83</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>` +
      `<Ntry><Amt Ccy="EUR">42.17</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-30</Dt></BookgDt><AcctSvcrRef>B1</AcctSvcrRef></Ntry></Stmt></BkToCstmrStmt></Document>`
    expect(((await (await upload('oktober.xml', camt)).json()) as { state: string }).state).toBe('imported')
    const engine = booted.services.ledger as unknown as { store: { listRecords(ws: string, q: object): Promise<Array<{ date: string }>> } }
    expect((await engine.store.listRecords(ws.workspaceId, { eventTypes: ['balance.snapshot'] })).map((r) => r.date)).toEqual(['2026-10-31'])
  })

  it('matches camt.053 statements by IBAN; the same file twice adds nothing; entity tricks are refused', async () => {
    const { upload, cash } = await setup(true)
    const camt = (iban: string, pre = '') =>
      `<?xml version="1.0"?>${pre}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>USD</Ccy></Acct>` +
      `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1477.83</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-10</Dt></Dt></Bal>` +
      `<Ntry><Amt Ccy="USD">42.17</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-05</Dt></BookgDt><AcctSvcrRef>R1</AcctSvcrRef></Ntry></Stmt></BkToCstmrStmt></Document>`
    const out = (await (await upload('auszug.xml', camt('XX00 1234 5678 0000'))).json()) as { state: string; message: string }
    expect(out).toMatchObject({ state: 'imported', message: 'Imported 1 row.' })
    expect(await cash()).toBe(152_000)
    const again = await upload('auszug-copy.xml', camt('XX00 1234 5678 0000'))
    expect([again.status, ((await again.json()) as { message: string }).message]).toEqual([200, 'You already uploaded this file.'])
    // External entities (XXE) and entity expansion: the DOCTYPE is refused before anything is resolved.
    for (const pre of ['<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>', '<!DOCTYPE d [<!ENTITY a "a"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>']) {
      const r = (await (await upload('xxe.xml', camt('XX00 1234 5678 0000', pre).replace('<Ccy>', '<Nm>&x;</Nm><Ccy>'))).json()) as { state: string; message: string }
      expect(r.state).toBe('unread')
      expect(r.message).toBe('This bank XML file is damaged or incomplete (around line 1). Download it from your bank again, or upload a CSV export.')
    }
    expect(await cash()).toBe(152_000)
  })

  it('a bank that re-issues FITIDs on a re-download (Chase) still counts each row once', async () => {
    const { upload } = await setup(false)
    const fixture = (n: string) => readFileSync(new URL(`../../../packages/connectors/files/fixtures/redacted/${n}`, import.meta.url), 'utf8')
    expect(((await (await upload('jan.qfx', fixture('chase-checking.qfx'))).json()) as { message: string }).message).toBe('Imported 4 rows.')
    expect(((await (await upload('jan-again.qfx', fixture('chase-checking-redownload.qfx'))).json()) as { message: string }).message).toBe('Imported 1 new row (4 already here).')
    const db = booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const live = await db.selectFrom('ledger_records').select('external_id').where('event_type', '=', 'txn.upsert').where('status', '!=', 'void').execute()
    expect(live).toHaveLength(5)
  })

  it('statements first, the bank feed later: the account counts once (balance from the feed, rows matched)', async () => {
    const fixture = (n: string) => readFileSync(new URL(`../../../packages/connectors/files/fixtures/redacted/${n}`, import.meta.url), 'utf8')
    const burn = async (ws: string, entityId: string) => (await booted.services.ledger.metric('net_burn', { workspaceId: ws, entityIds: [entityId], from: '2026-01-01', to: '2026-01-31' })).value
    const connectChase = async (cookie: string, entityId: string) => {
      const start = (await (await app.request('/api/connectors/chasefeed/start', post(cookie, { entityId }))).json()) as { state: string }
      expect((await app.request('/api/connectors/chasefeed/finish', post(cookie, { state: start.state, apiKey: 'k' }))).status).toBe(200)
    }
    // Control: the bank feed alone.
    const solo = await setup(false)
    await connectChase(solo.cookie, solo.ws.companyId)
    const once = { cash: await solo.cash(), burn: await burn(solo.ws.workspaceId, solo.ws.companyId) }
    expect(once.cash).toBe(315_571)
    // The same account, statement uploaded first.
    const both = await setup(false, 'both@example.com')
    expect(((await (await both.upload('jan.qfx', fixture('chase-checking.qfx'))).json()) as { state: string }).state).toBe('imported')
    const statementOnly = await burn(both.ws.workspaceId, both.ws.companyId)
    expect(statementOnly).not.toBeNull()
    await connectChase(both.cookie, both.ws.companyId)
    expect({ cash: await both.cash(), burn: await burn(both.ws.workspaceId, both.ws.companyId) }).toEqual(once)
  })

  it('a CSV with unknown columns asks one plain question at a time, then imports', async () => {
    const { cookie, upload } = await setup(false, 'columns@example.com')
    const ask = async (id: string, field: string, value: string) => (await (await app.request(`/api/documents/${id}/answer`, post(cookie, { field, value }))).json()) as { state: string; message: string; question?: { field: string; options: Array<{ value: string }> } }
    const first = (await (await upload('export.csv', 'When,What,Value,Note\n03/04/2026,Sample Shop,-12.00,x\n05/06/2026,Sample Client,250.00,y\n')).json()) as { documentId: string; state: string; message: string; question: { field: string; headers: string[] } }
    expect(first).toMatchObject({ state: 'needs_mapping', message: 'Which column is the date?', question: { field: 'date', headers: ['When', 'What', 'Value', 'Note'] } })
    expect(await ask(first.documentId, 'date', 'When')).toMatchObject({ state: 'needs_mapping', message: 'Which column is the amount?' })
    expect(await ask(first.documentId, 'amount', 'Value')).toMatchObject({ state: 'needs_mapping', question: { field: 'dateFormat' } })
    expect(await ask(first.documentId, 'dateFormat', 'DD/MM/YYYY')).toMatchObject({ state: 'imported', message: 'Imported 2 rows.' })
    const db = booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const rows = await db.selectFrom('ledger_records').select(['date', 'amount_minor']).where('event_type', '=', 'txn.upsert').orderBy('date').execute()
    expect(rows.map((r) => [r.date, Number(r.amount_minor)])).toEqual([['2026-04-03', -1200], ['2026-06-05', 25_000]])
    // A file that isn't waiting can't be answered; a known bank export never asks.
    expect((await app.request(`/api/documents/${first.documentId}/answer`, post(cookie, { field: 'date', value: 'When' }))).status).toBe(422)
    const fixture = readFileSync(new URL('../../../packages/connectors/files/fixtures/redacted/pnc.csv', import.meta.url), 'utf8')
    expect(((await (await upload('pnc.csv', fixture)).json()) as { state: string }).state).toBe('imported')
  })

  it('a company with no accounts yet imports straight away, and counts the statement as cash only once it has a balance', async () => {
    const { upload, cash } = await setup(false)
    const out = (await (await upload('first.csv', csv)).json()) as { state: string; message: string }
    expect(out).toMatchObject({ state: 'imported', message: 'Imported 3 rows.' })
    // No balance yet: three rows alone don't make a cash figure.
    expect(await cash()).toBeNull()
    const withBalance = 'Date,Description,Amount,Balance\n2026-10-11,Coffee,-5.00,995.00\n2026-10-12,Refund,5.00,1000.00\n'
    expect(((await (await upload('second.csv', withBalance)).json()) as { state: string }).state).toBe('imported')
    expect(await cash()).not.toBeNull()
  })
})

describe('the "Uploaded statements" account', () => {
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>011000015<ACCTID>9876544421<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261001<DTEND>20261010<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-42.17<FITID>f1<NAME>Corner Hardware</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>1477.83<DTASOF>20261010</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  const names = async () => (await booted.services.db.selectFrom('accounts').select('name').orderBy('name').execute()).map((a) => a.name)

  it('is not left behind, empty, when the statement names its own account', async () => {
    const { upload, cash } = await setup(false, 'own@example.com')
    expect(((await (await upload('checking.ofx', ofx)).json()) as { state: string }).state).toBe('imported')
    expect(await names()).not.toContain('Uploaded statements')
    expect(await names()).toHaveLength(1)
    expect(await cash()).toBe(147_783)
  })

  it('stays when a statement without an account of its own imports into it, and comes back for one after it went', async () => {
    const { upload } = await setup(false, 'plain@example.com')
    expect(((await (await upload('checking.ofx', ofx)).json()) as { state: string }).state).toBe('imported')
    expect(await names()).not.toContain('Uploaded statements')
    expect(((await (await upload('first.csv', csv)).json()) as { message: string }).message).toBe('Imported 3 rows.')
    expect(await names()).toContain('Uploaded statements')
    const anyDb = booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const rows = await anyDb.selectFrom('accounts').innerJoin('ledger_records', 'ledger_records.source_account_id', 'accounts.id').select('accounts.include_in_cash').where('accounts.name', '=', 'Uploaded statements').where('ledger_records.event_type', '=', 'txn.upsert').execute()
    // Its rows are there, and without a balance it isn't counted as cash.
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.include_in_cash === 0)).toBe(true)
  })
})

describe('the upload queue', () => {
  it('a statement another machine saved at the same moment, sorting before the cursor, is still read once', async () => {
    const { upload } = await setup(false)
    expect(((await (await upload('first.csv', csv)).json()) as { state: string }).state).toBe('imported')
    const db = booted.services.db
    const first = await db.selectFrom('documents').selectAll().where('original_name', '=', 'first.csv').executeTakeFirstOrThrow()
    expect(first.record_type).toBe('connection')
    // Same connection, same millisecond, an id that sorts before the one the cursor already passed; not imported yet.
    const lateId = '0'.repeat(first.id.length)
    await db.insertInto('documents').values({ ...first, id: lateId, original_name: 'late.csv', sha256: 'f'.repeat(64), extracted_json: null }).execute()
    expect((await source.list(first.record_id!, first.id)).map((f) => f.fileId)).toEqual([lateId])
    // Once the connector reports on it, it's done: the queue past the cursor is empty again.
    await source.report(first.record_id!, lateId, { status: 'imported', result: { eventCount: 0 } })
    expect(await source.list(first.record_id!, first.id)).toEqual([])
    // A statement saved long before the cursor's upload isn't a late arrival.
    await db.updateTable('documents').set({ extracted_json: null, created_at: new Date(Date.parse(first.created_at) - 3_600_000).toISOString() }).where('id', '=', lateId).execute()
    expect(await source.list(first.record_id!, first.id)).toEqual([])
  })
})

// One synthetic month for a small company, exported the way each bank exports it (no real statements, ever).
const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/07/2026,"MONTHLY SERVICE FEE",-15.00,FEE_TRANSACTION,7788.12,,
CREDIT,10/06/2026,"INTEREST PAYMENT",3.12,MISC_CREDIT,7803.12,,
DEBIT,10/05/2026,"GUSTO PAYROLL",-5000.00,ACH_DEBIT,7800.00,,
DEBIT,10/03/2026,"AMERICAN EXPRESS ACH PMT",-800.00,ACH_DEBIT,12800.00,,
DEBIT,10/02/2026,"Payment to Chase card ending in 1234",-1200.00,LOAN_PMT,13600.00,,
CREDIT,10/01/2026,"ACME CORP ACH CREDIT",4800.00,ACH_CREDIT,14800.00,,
`
const CHASE_CARD = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/04/2026,10/04/2026,Payment Thank You-Mobile,,Payment,1200.00,
10/02/2026,10/03/2026,SAMPLE SOFTWARE CO,Shopping,Sale,-49.00,
10/01/2026,10/02/2026,SAMPLE COFFEE ROASTERS,Food & Drink,Sale,-12.40,
`
const AMEX = `Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
10/04/2026,AUTOPAY PAYMENT - THANK YOU,A CARDHOLDER,-0042,-800.00,,AUTOPAY PAYMENT - THANK YOU,,,,,'AX2610040001',
10/02/2026,SAMPLE AIRLINE,A CARDHOLDER,-0042,412.30,SAMPLE AIR,SAMPLE AIRLINE,,,,,'AX2610020002',Travel-Airline
`
// QuickBooks Web Connect (.qbo): OFX with Intuit's header, as most US banks offer it.
const WELLS_QBO = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261008120000[0:GMT]<LANGUAGE>ENG<FI><ORG>WF<FID>3000</FI><INTU.BID>3000</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>000000000<ACCTID>XXXXXX5566<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261008
<STMTTRN><TRNTYPE>INT<DTPOSTED>20261007120000[0:GMT]<TRNAMT>21.40<FITID>2026100701<NAME>INTEREST PAID</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>25021.40<DTASOF>20261008120000[0:GMT]</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`

describe('a month of statements from several banks, with no bank connected', () => {
  it('each bank and card gets its own account, card payments match, and only real unknowns are asked', async () => {
    const { cookie, upload } = await setup(false, 'month@example.com')
    for (const [name, body] of [['Chase.csv', CHASE_CHECKING], ['Chase card.csv', CHASE_CARD], ['activity.csv', AMEX], ['wells.qbo', WELLS_QBO]] as const) {
      expect(((await (await upload(name, body)).json()) as { state: string }).state).toBe('imported')
    }
    const accounts = async () =>
      (await booted.services.db.selectFrom('accounts').select(['name', 'account_type']).orderBy('name').execute()).map((a) => `${a.name}|${a.account_type}`)
    expect(await accounts()).toEqual(['American Express|credit_card', 'Chase checking|depository', 'Chase credit card|credit_card', 'WF Savings ••5566|depository'])
    const review = async () => (await (await app.request('/api/review', { headers: { origin: BASE, cookie } })).json()) as Array<{ kind: string; detail: string }>
    const asked = (await review()).map((r) => r.detail)
    // The customer's deposit is the one real unknown. Paying each card is a transfer; interest is income.
    expect(asked).toEqual([expect.stringContaining('ACME CORP')])
    const anyDb = booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const rows = async () => Number((await anyDb.selectFrom('ledger_records').select((e) => e.fn.countAll().as('n')).where('event_type', '=', 'txn.upsert').executeTakeFirstOrThrow()).n)
    const before = await rows()
    // The same files again, and a later Chase export that overlaps the first: nothing counts twice.
    for (const [name, body] of [['Chase.csv', CHASE_CHECKING], ['Chase card.csv', CHASE_CARD], ['activity.csv', AMEX], ['wells.qbo', WELLS_QBO]] as const) await upload(name, body)
    const later = CHASE_CHECKING.replace('Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,10/09/2026,"SAMPLE INSURANCE CO",-120.00,ACH_DEBIT,7668.12,,\n')
    const overlap = (await (await upload('Chase (1).csv', later)).json()) as { state: string; message: string }
    expect(overlap.state).toBe('imported')
    expect(overlap.message).toMatch(/^Imported 1 new row \(\d+ already here\)\.$/)
    expect(await rows()).toBe(before + 1)
    // The same rows once more, in a file with different bytes: nothing new, and it says so.
    const again = (await (await upload('Chase (2).csv', later + '\n')).json()) as { state: string; message: string }
    expect(again.message).toMatch(/^Nothing new: all \d+ rows were already here\.$/)
    expect(await rows()).toBe(before + 1)
    expect((await review()).length).toBe(1)
  })
})

describe('PDF statements from known banks', () => {
  it('a Chase checking PDF that reconciles imports with its closing balance; the same file again is a duplicate', async () => {
    const { upload, cash } = await setup(false)
    const r = await upload('Statement_Sep_2026.pdf', chaseChecking())
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ state: 'imported', message: 'Imported 3 rows.' })
    expect(await cash()).toBe(249_550)
    const acct = await booted.services.db.selectFrom('accounts').select(['name', 'mask']).where('mask', '=', '6789').executeTakeFirstOrThrow()
    expect(acct.name).toBe('Chase checking ••6789')
    expect(await (await upload('copy.pdf', chaseChecking())).json()).toMatchObject({ message: 'You already uploaded this file.' })
    expect(await cash()).toBe(249_550)
  }, 60_000)

  it('next to a synced account it asks which account it is for; one that does not add up is kept for the AI, not imported', async () => {
    const { upload, cash } = await setup(true)
    const out = (await (await upload('chase.pdf', chaseChecking())).json()) as { state: string; accounts: Array<{ id: string }> }
    expect(out.state).toBe('needs_account')
    expect(await cash()).toBe(152_000)
    const off = (await (await upload('chase-off.pdf', chaseChecking({ closing: '2,495.51' }))).json()) as { state: string; message: string; documentId: string }
    expect(off).toMatchObject({ state: 'unread', message: expect.stringMatching(/don’t add up/) })
    const row = await booted.services.db.selectFrom('documents').select('extracted_json').where('id', '=', off.documentId).executeTakeFirstOrThrow()
    expect(JSON.parse(row.extracted_json!)).toMatchObject({ pdf: { status: 'text' }, statement: { layout: 'chase-checking-pdf', diffMinor: 1 } })
    expect(await cash()).toBe(152_000)
  }, 60_000)
})
