// Demo cap table for Acme (made-up people and numbers), as the same OCF-shaped objects the server stores.
import type { EquityObject } from '@agfn/equity/math'

const usd = (d: number) => ({ minor: Math.round(d * 100 * 10_000) / 10_000, currency: 'USD' })
const v4 = (start: string) => ({ start, months: 48, cliffMonths: 12 })

export function demoCapTable(): EquityObject[] {
  return [
    { type: 'STOCK_CLASS', id: 'cs', name: 'Common', classType: 'COMMON', authorized: 15_000_000, seniority: 0, liquidationPrefMultiple: 0, participating: false, participationCapMultiple: null, conversionRatio: 1 },
    { type: 'STOCK_CLASS', id: 'seed', name: 'Seed Preferred', classType: 'PREFERRED', authorized: 2_500_000, seniority: 1, pricePerShare: usd(0.6522), liquidationPrefMultiple: 1, participating: false, participationCapMultiple: null, conversionRatio: 1 },
    { type: 'STAKEHOLDER', id: 'yg', name: 'Dana Reyes', stakeholderType: 'INDIVIDUAL', relationship: 'FOUNDER' },
    { type: 'STAKEHOLDER', id: 'dr', name: 'Dana Ruiz', stakeholderType: 'INDIVIDUAL', relationship: 'EMPLOYEE' },
    { type: 'STAKEHOLDER', id: 'sl', name: 'Sam Lee', stakeholderType: 'INDIVIDUAL', relationship: 'EMPLOYEE' },
    { type: 'STAKEHOLDER', id: 'nf', name: 'North Fund LP', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'ha', name: 'Harbor Angels', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'mo', name: 'M. Okafor', stakeholderType: 'INDIVIDUAL', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'kv', name: 'Kite Ventures', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    { type: 'STAKEHOLDER', id: 'rc', name: 'R. Cohen', stakeholderType: 'INDIVIDUAL', relationship: 'INVESTOR' },
    { type: 'STOCK_PLAN', id: 'plan', name: '2024 Stock Plan', stockClassId: 'cs', size: 1_500_000 },
    { type: 'VALUATION', id: 'v1', date: '2026-03-01', stockClassId: 'cs', pricePerShare: usd(0.21), kind: '409A', provider: 'Northline Valuations' },
    { type: 'TX_STOCK_ISSUANCE', id: 'i1', date: '2024-02-01', securityId: 'CS-1', stakeholderId: 'yg', stockClassId: 'cs', quantity: 6_200_000, pricePerShare: usd(0.0001), vesting: v4('2024-02-01') },
    { type: 'TX_STOCK_ISSUANCE', id: 'i2', date: '2025-05-20', securityId: 'PS-1', stakeholderId: 'nf', stockClassId: 'seed', quantity: 1_533_272, pricePerShare: usd(0.6522) },
    { type: 'TX_STOCK_ISSUANCE', id: 'i3', date: '2025-05-20', securityId: 'PS-2', stakeholderId: 'ha', stockClassId: 'seed', quantity: 460_000, pricePerShare: usd(0.6522) },
    { type: 'TX_STOCK_ISSUANCE', id: 'i4', date: '2025-05-20', securityId: 'PS-3', stakeholderId: 'mo', stockClassId: 'seed', quantity: 306_728, pricePerShare: usd(0.6522) },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: '2024-09-01', securityId: 'O-1', stakeholderId: 'dr', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'OPTION_ISO', quantity: 250_000, exercisePrice: usd(0.08), vesting: v4('2024-09-01') },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g2', date: '2025-07-15', securityId: 'O-2', stakeholderId: 'sl', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'OPTION_ISO', quantity: 160_000, exercisePrice: usd(0.21), vesting: v4('2025-07-15') },
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c1', date: '2026-03-28', securityId: 'SAFE-1', stakeholderId: 'kv', kind: 'SAFE', amount: usd(250_000), valuationCap: usd(8_000_000), timing: 'POST_MONEY' },
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c2', date: '2026-01-12', securityId: 'SAFE-2', stakeholderId: 'rc', kind: 'SAFE', amount: usd(50_000), valuationCap: usd(6_000_000), discountPct: 20, timing: 'POST_MONEY' },
  ]
}
