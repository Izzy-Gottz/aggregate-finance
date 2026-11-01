// S6 wiring: one EquityService per database, posting cap-table money to the ledger.
import { EquityService, equityFinancePart, type EquityLedgerPort, type EquityRatePort, type EquityTables } from '@agfn/equity'
import type { CoreTables } from '@agfn/db'
import type { Kysely } from 'kysely'
import type { Services } from './services.ts'

const built = new WeakMap<object, EquityService>()

export function equityFor(s: Pick<Services, 'db' | 'ledger'>): EquityService {
  let svc = built.get(s.db)
  if (!svc) {
    // Totals across currencies use the ledger's own FX rates.
    const rates = (s.ledger as unknown as { rates?: EquityRatePort }).rates
    svc = new EquityService({ db: s.db as unknown as Kysely<CoreTables & EquityTables>, ledger: s.ledger as unknown as EquityLedgerPort, ...(rates ? { rates } : {}) })
    built.set(s.db, svc)
  }
  return svc
}

export const equityPartFor = (s: Pick<Services, 'db' | 'ledger'>) => equityFinancePart(equityFor(s))
