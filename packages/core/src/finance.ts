// One call to get the ledger's FinanceReader + RecordWriter (what S7's tools and the server use).
import type { EntityId, Id, IsoDate, Money, WorkspaceId } from '@agfn/contracts'
import type { LedgerEngine } from './engine.ts'
import { bankRows, LedgerFinanceReader, type ReaderProviders, type TxnUpsertWithId } from './finance-reader.ts'
import { LedgerRecordWriter, type WriterOptions } from './record-writer.ts'

export interface Finance {
  reader: LedgerFinanceReader
  writer: LedgerRecordWriter
  /** True when the ledger created or holds this id (record, bucket, rule, or a write it applied), so undo routes here. */
  owns(workspaceId: WorkspaceId, id: Id): Promise<boolean>
  bankRows(workspaceId: WorkspaceId, entityId: EntityId, since: IsoDate): Promise<TxnUpsertWithId[]>
  /** An amount in another currency at that day's rate, from the ledger's own rates. */
  toCurrency(workspaceId: WorkspaceId, amount: Money, to: string, date: IsoDate): Promise<Money>
}

export function createFinance(engine: LedgerEngine, opts: { providers?: ReaderProviders; writer?: WriterOptions } = {}): Finance {
  const reader = new LedgerFinanceReader(engine, opts.providers)
  const writer = new LedgerRecordWriter(engine, opts.writer)
  return {
    reader,
    writer,
    owns: async (ws, id) =>
      Boolean((await engine.store.latestWriteFor(ws, id)) ?? (await engine.store.getRecord(ws, id)) ?? (await engine.store.getBucket(ws, id)) ?? (await engine.store.getRule(ws, id))),
    bankRows: (ws, entityId, since) => bankRows(engine, ws, entityId, since),
    toCurrency: async (ws, amount, to, date) => {
      const { minor, currency } = await engine.metricContext(ws).toCurrency(amount, to, date)
      return { minor, currency }
    },
  }
}
