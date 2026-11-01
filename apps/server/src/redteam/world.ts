// Red-team world: a victim workspace full of data with marker strings, and an attacker in a second workspace with
// their own session, data and a full-access agent key. Tests aim the attacker at the victim's ids and check that
// nothing answers, nothing changes, and no marker string ever shows up in a response.
import { expect } from 'vitest'
import { withBypass } from '@agfn/db'
import { accountIds, connectAi, connectProvider, entities, signIn, type Ai, type Server, type Session } from '../scenarios/harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
export const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')

/** Direct database reads/writes a test makes (setup, surgery, checks) run outside any workspace, as maintenance does. */
export const asTest = <T>(fn: () => Promise<T>): Promise<T> => withBypass('test:redteam', fn)

/** Strings that only exist in the victim's workspace. */
export const MARKERS = ['VICTIMSECRET', '4321.09', '9876.54', '777.77', 'Victim Co']

/** The first victim marker found in a response; markers the attacker sent themselves (`sent`) don't count. */
export function leaks(x: unknown, sent?: unknown): string | null {
  const s = typeof x === 'string' ? x : JSON.stringify(x)
  const own = sent === undefined ? '' : JSON.stringify(sent)
  return MARKERS.find((m) => s?.includes(m) && !own.includes(m)) ?? null
}

export interface Victim {
  s: Session
  ws: string
  entityId: string
  personalId: string
  bankId: string
  qbId: string
  accountId: string
  txnId: string
  inflowId: string
  invoiceId: string
  documentId: string
  bucketId: string
  grantId: string
  reviewId: string
  ai: Ai
}

export async function upload(s: Session, entityId: string, name: string, bytes: Uint8Array, type = 'application/pdf') {
  const form = new FormData()
  form.set('file', new File([new Uint8Array(bytes)], name, { type }))
  form.set('entityId', entityId)
  return s.post<{ documentId?: string; name?: string; message?: string }>('/api/documents', undefined, { raw: form })
}

export async function victimWorld(srv: Server): Promise<Victim> {
  const s = await signIn(srv, 'victim@a.example', 'Victim Co')
  const E = await entities(s)
  const entityId = E['Victim Co'] as string
  const bank = await connectProvider(srv, s, 'plaid', { entityId, name: 'Chase' })
  bank.push((c) => [
    { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Victim Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
    { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(5_000_000) },
    { type: 'txn.upsert', externalId: 't1', connectionId: c, accountExternalId: 'chk', date: '2026-10-02', amount: usd(-432_109), status: 'posted', counterparty: 'VICTIMSECRET Vendor', rawText: 'VICTIMSECRET VENDOR ACH' },
    { type: 'txn.upsert', externalId: 't2', connectionId: c, accountExternalId: 'chk', date: '2026-10-03', amount: usd(77_777), status: 'posted', counterparty: 'VICTIMSECRET Payer', rawText: 'VICTIMSECRET WIRE IN' },
  ])
  expect((await bank.sync()).status).toBe('ok')
  const qb = await connectProvider(srv, s, 'quickbooks', { entityId, name: 'QuickBooks' })
  qb.push((c) => [{ type: 'invoice.upsert', externalId: 'i1', connectionId: c, direction: 'receivable', number: 'V-1', counterparty: 'VICTIMSECRET Customer', issueDate: '2026-09-01', dueDate: '2026-09-30', total: usd(987_654), amountPaid: usd(0), status: 'open' }] as never)
  expect((await qb.sync()).status).toBe('ok')
  const doc = await upload(s, entityId, 'victimsecret-invoice.pdf', PDF)
  expect(doc.status, JSON.stringify(doc.body)).toBe(201)

  const ai = await connectAi(srv, s, undefined, 'Victim bot')
  const bucket = await ai.call<{ record_id: string }>('create_bucket', { company: 'Victim Co', name: 'VICTIMSECRET fund', idempotency_key: 'victim-bucket-0001' })
  const txns = (await ai.call<{ transactions: Array<{ id: string; amount: { amount: string } }> }>('search_transactions', { company: 'Victim Co' })).transactions
  const inv = (await ai.call<{ owed_to_you: { invoices: Array<{ id: string }> } }>('search_invoices', { company: 'Victim Co', side: 'owed_to_you' })).owed_to_you.invoices
  const review = (await s.get<Array<{ id: string }>>('/api/review')).body
  expect(review.length).toBeGreaterThan(0)
  return {
    s,
    ws: s.workspaceId,
    entityId,
    personalId: E.Personal as string,
    bankId: bank.id,
    qbId: qb.id,
    accountId: (await accountIds(srv, bank.id)).chk as string,
    txnId: txns.find((t) => t.amount.amount === '-4321.09')?.id as string,
    inflowId: txns.find((t) => t.amount.amount === '777.77')?.id as string,
    invoiceId: inv[0]?.id as string,
    documentId: doc.body.documentId as string,
    bucketId: bucket.record_id,
    grantId: ai.grantId,
    reviewId: review[0]?.id as string,
    ai,
  }
}

export interface Attacker {
  s: Session
  entityId: string
  ownTxnId: string
  ownInvoiceId: string
  ai: Ai
}

export async function attackerWorld(srv: Server): Promise<Attacker> {
  const s = await signIn(srv, 'mallory@b.example', 'Mallory LLC')
  const E = await entities(s)
  const entityId = E['Mallory LLC'] as string
  const bank = await connectProvider(srv, s, 'plaid', { entityId, name: 'Mallory Bank' })
  bank.push((c) => [
    { type: 'account.upsert', externalId: 'm', connectionId: c, name: 'Mallory Checking', accountType: 'depository', currency: 'USD', institution: 'Mallory Bank' },
    { type: 'balance.snapshot', externalId: 'mb', connectionId: c, accountExternalId: 'm', at: '2026-10-09T08:00:00Z', current: usd(100_000) },
    { type: 'txn.upsert', externalId: 'mt', connectionId: c, accountExternalId: 'm', date: '2026-10-02', amount: usd(-1_000), status: 'posted', counterparty: 'Coffee', rawText: 'COFFEE' },
  ])
  expect((await bank.sync()).status).toBe('ok')
  expect((await upload(s, entityId, 'mallory.pdf', PDF)).status).toBe(201)
  const ai = await connectAi(srv, s, undefined, 'Mallory bot')
  await ai.call('create_bucket', { company: 'Mallory LLC', name: 'Mallory fund', idempotency_key: 'mallory-bucket-01' })
  const inv = await ai.call<{ record_id: string }>('add_invoice', { company: 'Mallory LLC', side: 'owed_to_you', counterparty: 'Someone', issue_date: '2026-10-01', currency: 'USD', lines: [{ description: 'Work', quantity: 1, unit_price: '10.00' }], total: '10.00', idempotency_key: 'mallory-inv-0001' })
  const ownTxnId = (await ai.call<{ transactions: Array<{ id: string }> }>('search_transactions', {})).transactions[0]?.id as string
  return { s, entityId, ownTxnId, ownInvoiceId: inv.record_id, ai }
}

/** The victim's numbers and settings, to prove nothing changed. */
export async function victimState(srv: Server, v: Victim) {
  const db = srv.booted.services.db
  const m = async (metric: string) => JSON.stringify((await v.ai.call<{ value: unknown }>('get_metric', { metric, company: 'Victim Co' })).value)
  return {
    cash: await m('cash'),
    arOpen: await m('ar_open'),
    txns: (await v.ai.call<{ total_count: number }>('search_transactions', { company: 'Victim Co' })).total_count,
    connections: await asTest(() => db.selectFrom('connections').select(['id', 'status', 'entity_id']).where('workspace_id', '=', v.ws).orderBy('id').execute()),
    accounts: await asTest(() => db.selectFrom('accounts').select(['id', 'entity_id']).where('workspace_id', '=', v.ws).orderBy('id').execute()),
    grants: (await asTest(() => db.selectFrom('grants' as never).select(['id', 'revoked_at', 'paused_at'] as never).where('workspace_id' as never, '=', v.ws as never).orderBy('id' as never).execute())) as unknown[],
    bucket: JSON.stringify(await v.ai.call('get_bucket', { id: v.bucketId })),
    review: (await v.s.get<unknown[]>('/api/review')).body.length,
    docs: await asTest(() => db.selectFrom('documents').select(['id', 'entity_id']).where('workspace_id', '=', v.ws).execute()),
  }
}
