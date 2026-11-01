// The parts of the demo that aren't bank or payment data: buckets with rules, and a cap table on the SaaS company.
// Run right after the workspace is created and before its first sync, so rules route transactions as they post.

import type { EquityObject } from '@agfn/equity/math'
import type { LedgerEngine } from '@agfn/core'
import { SAFE_WIRES } from '@agfn/connector-demo'
import type { DemoWorkspace } from './index.ts'

export interface DemoExtrasPorts {
  buckets?: Pick<LedgerEngine, 'createBucket' | 'createRule'>
  equity?: { add(ws: string, entityId: string, objects: EquityObject[], meta: { origin: 'import'; createdBy: string | null; label: string }): Promise<unknown> }
  /** Upload (the server's Documents.upload, in the workspace's context): adds one unread receipt. */
  documents?: { upload(input: { workspaceId: string; entityId: string; personId: string | null; filename: string; bytes: Uint8Array; arrivedVia: 'upload' }): Promise<unknown> }
}

/** A one-page PDF receipt for Harbor Coffee: "ABC Printing, menus, $86.40, paid by card". */
export const DEMO_RECEIPT = new TextEncoder().encode(
  [
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>> endobj',
    '4 0 obj <</Length 96>> stream',
    'BT /F1 12 Tf 20 160 Td (ABC Printing - Receipt) Tj 0 -24 Td (Menus, 200 copies) Tj 0 -24 Td (Total $86.40 - paid by card) Tj ET',
    'endstream endobj',
    '5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj',
    'trailer <</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
)

const DAY = 86_400_000
const shift = (start: string, days: number) => new Date(Date.parse(start + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10)
const usd = (dollars: number) => ({ minor: Math.round(dollars * 100 * 10_000) / 10_000, currency: 'USD' })
const fourYears = (start: string) => ({ start, months: 48, cliffMonths: 12 })

/** Northwind's cap table (made-up people). Dates are relative to the demo history so the SAFE wires line up with the bank. */
export function demoCapTable(start: string): EquityObject[] {
  const safe = (i: number) => {
    const w = SAFE_WIRES[i]
    if (!w) throw new Error('missing SAFE wire')
    return { date: shift(start, w.offset), amount: usd(w.minor / 100) }
  }
  const founded = shift(start, -620)
  const seed = shift(start, -140)
  return [
    { type: 'STOCK_CLASS', id: 'cs', name: 'Common', classType: 'COMMON', authorized: 15_000_000, seniority: 0, liquidationPrefMultiple: 0, participating: false, participationCapMultiple: null, conversionRatio: 1 },
    { type: 'STOCK_CLASS', id: 'seed', name: 'Seed Preferred', classType: 'PREFERRED', authorized: 2_500_000, seniority: 1, pricePerShare: usd(0.6522), liquidationPrefMultiple: 1, participating: false, participationCapMultiple: null, conversionRatio: 1 },
    { type: 'STAKEHOLDER', id: 'am', name: 'Alex Morgan', stakeholderType: 'INDIVIDUAL', relationship: 'FOUNDER' },
    { type: 'STAKEHOLDER', id: 'dr', name: 'Dana Ruiz', stakeholderType: 'INDIVIDUAL', relationship: 'EMPLOYEE' },
    { type: 'STAKEHOLDER', id: 'sl', name: 'Sam Lee', stakeholderType: 'INDIVIDUAL', relationship: 'EMPLOYEE' },
    { type: 'STAKEHOLDER', id: 'nf', name: 'North Fund LP', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'ha', name: 'Harbor Angels', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'mo', name: 'M. Okafor', stakeholderType: 'INDIVIDUAL', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'kv', name: 'Kite Ventures', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'rc', name: 'R. Cohen', stakeholderType: 'INDIVIDUAL', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'ps', name: 'Priya Shah', stakeholderType: 'INDIVIDUAL', relationship: 'EMPLOYEE' },
    { type: 'STAKEHOLDER', id: 'wb', name: 'Westlake Bank', stakeholderType: 'INSTITUTION', relationship: 'OTHER' },
    { type: 'STOCK_PLAN', id: 'plan', name: 'Stock Plan', stockClassId: 'cs', size: 1_500_000 },
    { type: 'VALUATION', id: 'v1', date: shift(start, 150), stockClassId: 'cs', pricePerShare: usd(0.21), kind: '409A', provider: 'Demo Valuations' },
    { type: 'TX_STOCK_ISSUANCE', id: 'i1', date: founded, securityId: 'CS-1', stakeholderId: 'am', stockClassId: 'cs', quantity: 6_200_000, pricePerShare: usd(0.0001), vesting: fourYears(founded) },
    { type: 'TX_STOCK_ISSUANCE', id: 'i2', date: seed, securityId: 'PS-1', stakeholderId: 'nf', stockClassId: 'seed', quantity: 1_533_272, pricePerShare: usd(0.6522) },
    { type: 'TX_STOCK_ISSUANCE', id: 'i3', date: seed, securityId: 'PS-2', stakeholderId: 'ha', stockClassId: 'seed', quantity: 460_000, pricePerShare: usd(0.6522) },
    { type: 'TX_STOCK_ISSUANCE', id: 'i4', date: seed, securityId: 'PS-3', stakeholderId: 'mo', stockClassId: 'seed', quantity: 306_728, pricePerShare: usd(0.6522) },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: shift(start, -400), securityId: 'O-1', stakeholderId: 'dr', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'OPTION_ISO', quantity: 250_000, exercisePrice: usd(0.08), vesting: fourYears(shift(start, -400)) },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g2', date: shift(start, 160), securityId: 'O-2', stakeholderId: 'sl', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'OPTION_ISO', quantity: 160_000, exercisePrice: usd(0.21), vesting: fourYears(shift(start, 160)) },
    // RSUs, partly vested (about 20 months in), with the first year's units released net of tax withholding.
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g3', date: shift(start, -245), securityId: 'RSU-1', stakeholderId: 'ps', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'RSU', quantity: 48_000, vesting: fourYears(shift(start, -245)) },
    { type: 'TX_EQUITY_COMPENSATION_RELEASE', id: 'r1', date: shift(start, 120), securityId: 'RSU-1', quantity: 12_000, withheld: 3_000, resultingSecurityId: 'RSU-1:stock' },
    // A lender's warrant on the seed preferred, issued with the venture loan; nothing paid for it (no cash posts).
    { type: 'TX_WARRANT_ISSUANCE', id: 'w1', date: shift(start, 60), securityId: 'W-1', stakeholderId: 'wb', stockClassId: 'seed', quantity: 50_000, exercisePrice: usd(0.6522), expirationDate: shift(start, 60 + 7 * 365) },
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c1', date: safe(1).date, securityId: 'SAFE-1', stakeholderId: 'kv', kind: 'SAFE', amount: safe(1).amount, valuationCap: usd(8_000_000), timing: 'POST_MONEY' },
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c2', date: safe(0).date, securityId: 'SAFE-2', stakeholderId: 'rc', kind: 'SAFE', amount: safe(0).amount, valuationCap: usd(6_000_000), discountPct: 20, timing: 'POST_MONEY' },
  ] as EquityObject[]
}

export async function addDemoExtras(ports: DemoExtrasPorts, demo: DemoWorkspace, start: string): Promise<{ buckets: number; capTable: boolean; receipt: boolean }> {
  const ent = (p: string) => demo.entities.find((e) => e.profile === p)?.id
  const ws = demo.workspaceId
  let buckets = 0
  if (ports.buckets) {
    const nw = ent('northwind')
    const bb = ent('bluebird')
    const hc = ent('harbor')
    if (nw) {
      const rent = await ports.buckets.createBucket(ws, {
        entityId: nw,
        name: 'Rent',
        fields: [{ key: 'landlord', label: 'Landlord', type: 'text' }],
        values: { landlord: 'Commonspace' },
        schedule: { amount: { minor: 8_500_00, currency: 'USD' }, direction: 'out', cadence: 'monthly', dueDay: 1, startDate: start },
        origin: 'import',
      })
      await ports.buckets.createRule(ws, { name: 'Commonspace → Rent', conditions: { textPatterns: ['*COMMONSPACE*'], direction: 'out', entityIds: [nw] }, actions: { bucketId: rent.id, category: 'rent' }, origin: 'user' })
      buckets++
    }
    if (bb) {
      const c = await ports.buckets.createBucket(ws, { entityId: bb, name: 'Contractors', origin: 'import' })
      await ports.buckets.createRule(ws, { name: 'Zelle to contractors', conditions: { textPatterns: ['ZELLE TO *'], direction: 'out', entityIds: [bb] }, actions: { bucketId: c.id, category: 'contractors' }, origin: 'user' })
      buckets++
    }
    if (hc) {
      const s = await ports.buckets.createBucket(ws, { entityId: hc, name: 'Suppliers', origin: 'import' })
      await ports.buckets.createRule(ws, { name: 'Coffee and dairy suppliers', conditions: { textPatterns: ['ROASTWORKS*', 'VALLEY DAIRY*'], direction: 'out', entityIds: [hc] }, actions: { bucketId: s.id, category: 'cogs' }, origin: 'user' })
      buckets++
    }
  }
  let capTable = false
  const nw = ent('northwind')
  if (ports.equity && nw) {
    await ports.equity.add(ws, nw, demoCapTable(start), { origin: 'import', createdBy: null, label: 'Demo cap table' })
    capTable = true
  }
  // One unread receipt, so the documents screen and the AI's document tools (listed only when there are documents)
  // have something to show.
  const hc = ent('harbor')
  let receipt = false
  if (ports.documents && hc) {
    await ports.documents.upload({ workspaceId: ws, entityId: hc, personId: null, filename: 'receipt-abc-printing.pdf', bytes: DEMO_RECEIPT, arrivedVia: 'upload' })
    receipt = true
  }
  return { buckets, capTable, receipt }
}

/** Ledger calls the tidy step needs (S1 LedgerEngine). */
export interface DemoReviewPort {
  reviewItems(ws: string, opts?: { entityIds?: string[] }): Promise<Array<{ kind: string; entityId: string | null; detail: string; recordIds: string[]; linkId?: string }>>
  decideLink(ws: string, linkId: string, decision: 'confirmed' | 'rejected' | 'proposed', decidedBy: string | null): Promise<unknown>
  setOverride(ws: string, recordId: string, patch: { category?: string; note?: string }, updatedBy: string | null): Promise<unknown>
}

/**
 * Answer the demo's own review questions the way its founder would, keeping a realistic few: the newest transfer
 * match, the newest unexplained deposit (a Venmo cash-out when there is one: whose money it is is a fair question), and
 * the founder-loan question. Everything else is confirmed (transfers between
 * the demo's accounts) or filed as other income.
 */
export async function tidyDemoReview(ledger: DemoReviewPort, workspaceId: string, keep = { matches: 1, unexplained: 1 }): Promise<{ confirmed: number; categorized: number }> {
  const items = await ledger.reviewItems(workspaceId)
  const newestFirst = (a: { detail: string }, b: { detail: string }) => b.detail.localeCompare(a.detail)
  const matches = items.filter((i) => i.kind === 'suggested_match' && i.linkId).sort(newestFirst)
  const venmoFirst = (a: { detail: string }, b: { detail: string }) => Number(/venmo/i.test(b.detail)) - Number(/venmo/i.test(a.detail)) || newestFirst(a, b)
  const unexplained = items.filter((i) => i.kind === 'unexplained_money').sort(venmoFirst)
  let confirmed = 0
  let categorized = 0
  for (const m of matches.slice(keep.matches)) {
    try {
      await ledger.decideLink(workspaceId, m.linkId as string, 'confirmed', null)
      confirmed++
    } catch {
      // Already explained by another link (e.g. an auto-confirmed transfer): leave it to the ledger, never reject, since
      // rejecting can release a held copy.
    }
  }
  for (const u of unexplained.slice(keep.unexplained)) {
    for (const r of u.recordIds) await ledger.setOverride(workspaceId, r, { category: 'other_income', note: 'Demo data' }, null)
    categorized++
  }
  return { confirmed, categorized }
}
