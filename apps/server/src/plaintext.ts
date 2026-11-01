// Beancount / hledger export of a workspace's books (Preferences → Export, and `agfn export`).
import { toPlainText, type Company, type Format, type JournalEntry } from '@agfn/plaintext'
import type { Services } from './services.ts'

export const PLAINTEXT_EXT: Record<Format, string> = { beancount: 'beancount', hledger: 'journal' }

/**
 * The books of these companies as journal text. `entityIds` defaults to every company (Personal spaces are left
 * out unless named). Needs the S1 ledger's journal().
 */
export async function plainTextExport(s: Pick<Services, 'db' | 'ledger'>, workspaceId: string, opts: { format: Format; entityIds?: string[]; basis?: 'cash' | 'accrual'; now?: Date }): Promise<string> {
  const journal = (s.ledger as { journal?: (ws: string, o: { entityIds?: string[]; basis?: 'cash' | 'accrual' }) => Promise<JournalEntry[]> }).journal
  if (!journal) throw new Error('Plain-text export needs the ledger (it is not installed on this server).')
  const ws = await s.db.selectFrom('workspaces').select(['name']).where('id', '=', workspaceId).executeTakeFirst()
  const rows = await s.db.selectFrom('entities').select(['id', 'name', 'kind', 'base_currency']).where('workspace_id', '=', workspaceId).where('archived_at', 'is', null).execute()
  const chosen = rows.filter((e) => (opts.entityIds ? opts.entityIds.includes(e.id) : e.kind === 'company'))
  const companies: Company[] = chosen.map((e) => ({ id: e.id, name: e.kind === 'personal' ? 'Personal' : e.name, baseCurrency: e.base_currency }))
  const entries = chosen.length ? await journal.call(s.ledger, workspaceId, { entityIds: chosen.map((e) => e.id), basis: opts.basis ?? 'accrual' }) : []
  return toPlainText(entries, { format: opts.format, companies, title: `${ws?.name ?? 'Aggregate'} books`, generatedAt: (opts.now ?? new Date()).toISOString() })
}
