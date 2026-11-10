// A source must never count twice. Two ways a connection's records stop counting:
// - disconnect with "delete its data": all of them, now;
// - a reconnect: when a newer connection reads the same provider company (Xero organisation, QuickBooks company,
//   Finch company, Stripe account) or the same bank accounts (institution + last 4 + type + currency) as one that was
//   disconnected, the old one's records from the newer one's first day on are retired, and its accounts closed.
// Both go through the ledger's normal reversal (closed periods stay as reported) and are written to the activity log.
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import { appendActivity } from '@agfn/mcp'
import type { Services } from './services.ts'
import { financeFor } from './finance.ts'

/** settings key (per account) recording that the person explicitly uploaded a statement "as a new, separate account". */
export const keepSeparateKey = (accountId: string) => `stmt:keep_separate:${accountId}`

type Deps = Pick<Services, 'db' | 'ledger' | 'syncDeps'>

/**
 * The provider company or account a connection reads, when its connector names one in config: Xero organisation,
 * QuickBooks company, Finch company, Stripe account, Square merchant, BILL or Polar organisation, Gumroad seller, Shopify
 * store. (BILL keeps its organisation in the secret; finish reads it there.)
 */
const ORG_KEYS = ['tenantId', 'realmId', 'companyId', 'accountId', 'merchantId', 'organizationId', 'sellerId', 'shop'] as const
export function providerOrgOf(configJson: string): string | null {
  const c = JSON.parse(configJson || '{}') as Record<string, unknown>
  for (const k of ORG_KEYS) if (typeof c[k] === 'string' && c[k]) return `${k}:${c[k] as string}`
  return null
}

const NAME: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks', finch: 'payroll', plaid: 'bank', stripe: 'Stripe' }

async function log(s: Deps, ws: string, connectionId: string, entityId: string | null, detail: string): Promise<void> {
  await appendActivity(s.db as never, { workspaceId: ws, actorKind: 'system', actorLabel: 'Aggregate', action: 'connection.retired', targetType: 'connection', targetId: connectionId, ...(entityId ? { entityIds: [entityId] } : {}), status: 'ok', detail }, new Date())
}

/** Who connected, added or disconnected a source: connecting accounts is a re-checked action, so it leaves a row. */
export async function logConnectionChange(s: Pick<Services, 'db'>, ws: string, connectionId: string, personId: string, action: 'connection.connected' | 'connection.added' | 'connection.disconnected', detail: string): Promise<void> {
  const conn = await s.db.selectFrom('connections').select('entity_id').where('id', '=', connectionId).executeTakeFirst()
  const person = await s.db.selectFrom('people').select('name').where('id', '=', personId).executeTakeFirst()
  await appendActivity(s.db as never, { workspaceId: ws, actorKind: 'person', personId, actorLabel: person?.name || 'someone', action, targetType: 'connection', targetId: connectionId, ...(conn?.entity_id ? { entityIds: [conn.entity_id] } : {}), status: 'ok', detail }, new Date())
}

/** A note in the activity log about a connection (e.g. the warning before a provider-requested erasure). */
export async function noteConnection(s: Pick<Services, 'db'>, ws: string, connectionId: string, detail: string): Promise<void> {
  const conn = await s.db.selectFrom('connections').select('entity_id').where('id', '=', connectionId).executeTakeFirst()
  await appendActivity(s.db as never, { workspaceId: ws, actorKind: 'system', actorLabel: 'Aggregate', action: 'connection.notice', targetType: 'connection', targetId: connectionId, ...(conn?.entity_id ? { entityIds: [conn.entity_id] } : {}), status: 'ok', detail }, new Date())
}

/** Disconnect + delete its data: every record of the connection stops counting (ledger first, then the books store). */
export async function retireDeleted(s: Deps, ws: string, connectionId: string): Promise<number> {
  const n = (await s.ledger.connectionRemoved?.(ws, connectionId)) ?? 0
  await financeFor(s).books.retireConnection(ws, connectionId)
  const conn = await s.db.selectFrom('connections').select(['display_name', 'entity_id']).where('id', '=', connectionId).executeTakeFirst()
  if (n) await log(s, ws, connectionId, conn?.entity_id ?? null, `${conn?.display_name ?? 'A connection'} was removed with its data: ${n} record${n === 1 ? '' : 's'} no longer count.`)
  return n
}

/**
 * Providers whose terms require their data deleted when the person disconnects (Wefunder's acceptable use; Intuit's
 * Developer Terms 8.2(f), within 30 days of a disconnect): on disconnect everything the connection brought is deleted,
 * not just retired. Raw payloads too (the route). BigCommerce's API Terms s.2.1 (revised 2025-07-31): "You must delete all
 * personal data you have collected from Your User through your API client (i) upon request from Your User, or (ii) when
 * Your User deauthorizes your application or closes its account with you." Amazon's Data Protection Policy s.1.7: delete all
 * Information within 30 days of the earliest of Amazon's notice, the seller revoking authorization or "otherwise
 * remov[ing]" our access, or our own access ending (a disconnect is that). Etsy's API Terms: Aggregate acts as the
 * seller's service provider (s.4), keeps Etsy content no longer than reasonably necessary to serve them (s.5), and stops
 * using it when access ends (s.6); a disconnect is that end. (Section numbers unconfirmed: packages/connectors/etsy/README.md.)
 */
export const ERASE_ON_DISCONNECT: ReadonlySet<string> = new Set(['wefunder', 'quickbooks', 'freshbooks', 'squarespace', 'youtube', 'pinterest', 'whop', 'bigcommerce', 'amazon', 'etsy'])

/** Shown in the activity log when a store uninstalls the Shopify app. */
export const SHOPIFY_ERASE_WARNING =
  'The Aggregate app was removed from this Shopify store. In 48 hours Shopify asks us to erase the store’s data: its payouts will then be removed from your books. Export your books before then if you need them.'

/**
 * Providers where ending access at the source erases too. Shopify: disconnect uninstalls, and shop/redact arrives 48
 * hours later and deletes the store's data anyway, so it goes now and the person is told, whatever they picked.
 */
export const ERASE_WHEN_REVOKED: ReadonlySet<string> = new Set(['shopify'])

/**
 * The provider says the person revoked Aggregate there (a sync failed with code 'revoked'): for ERASE_ON_DISCONNECT
 * providers that ends the connection exactly like disconnecting here, data deleted, and the activity log says why.
 * Returns false when it isn't one of those (the connection then just needs reconnecting, as any lost sign-in).
 */
export async function eraseRevoked(s: Deps, ws: string, connectionId: string): Promise<boolean> {
  const conn = await s.db.selectFrom('connections').select(['connector_key', 'display_name', 'status']).where('id', '=', connectionId).where('workspace_id', '=', ws).executeTakeFirst()
  if (!conn || !ERASE_ON_DISCONNECT.has(conn.connector_key) || conn.status === 'disconnected') return false
  await s.db.updateTable('connections').set({ status: 'disconnected', secret_enc: null, disconnected_at: new Date().toISOString() }).where('id', '=', connectionId).execute()
  await eraseConnectionData(s, ws, connectionId)
  const db = s.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  await db.deleteFrom('raw_records').where('connection_id', '=', connectionId).execute()
  await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('connection_id', '=', connectionId).execute()
  await noteConnection(s, ws, connectionId, `${conn.display_name || 'This connection'} was removed and its data deleted: access to Aggregate was revoked at the provider.`)
  return true
}

/**
 * Delete what a connection brought (ERASE_ON_DISCONNECT): its ledger records and everything posted from them (the
 * engine), its documents and payroll runs, then its accounts. An account goes with everything kept about it (holdings,
 * liabilities, balance pins, its own ledger accounts) when nothing else points at it; it stays, closed, when another
 * source still does: another account marks itself a copy of it, or other sources' ledger lines post to it. The
 * activity log lines naming the connection stay. Returns how many ledger records went.
 */
export async function eraseConnectionData(s: Deps, ws: string, connectionId: string): Promise<{ records: number; accountsDeleted: number; accountsKept: number }> {
  const records = (await s.ledger.connectionErased?.(ws, connectionId)) ?? (await s.ledger.connectionRemoved?.(ws, connectionId)) ?? 0
  const db = s.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  for (const t of ['books_documents', 'payroll_runs']) await db.deleteFrom(t).where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute().catch(() => undefined)
  let accountsDeleted = 0
  let accountsKept = 0
  const accounts = (await db.selectFrom('accounts').select('id').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute()) as Array<{ id: string }>
  for (const { id } of accounts) {
    // Its own ledger accounts: cash:/card:/loan:/processor:<id> (coa.ts cashRole).
    const ledgerAccounts = ((await db.selectFrom('ledger_accounts').select('id').where('workspace_id', '=', ws).where('role', 'like', `%:${id}`).execute()) as Array<{ id: string }>).map((a) => a.id)
    const copy = await db.selectFrom('accounts').select('id').where('workspace_id', '=', ws).where('duplicate_of', '=', id).executeTakeFirst()
    const lines = ledgerAccounts.length ? await db.selectFrom('journal_lines').select('id').where('workspace_id', '=', ws).where('ledger_account_id', 'in', ledgerAccounts).executeTakeFirst() : undefined
    if (copy || lines) {
      accountsKept++
      await db.deleteFrom('account_holdings').where('account_id', '=', id).execute().catch(() => undefined)
      continue
    }
    for (const t of ['account_holdings', 'account_liabilities', 'account_reassignments']) await db.deleteFrom(t).where('account_id', '=', id).execute().catch(() => undefined)
    await db.deleteFrom('ledger_assertions').where('workspace_id', '=', ws).where('account_id', '=', id).execute()
    if (ledgerAccounts.length) await db.deleteFrom('ledger_accounts').where('workspace_id', '=', ws).where('id', 'in', ledgerAccounts).execute()
    await db.deleteFrom('accounts').where('workspace_id', '=', ws).where('id', '=', id).execute()
    accountsDeleted++
  }
  const conn = await s.db.selectFrom('connections').select(['display_name', 'entity_id']).where('id', '=', connectionId).executeTakeFirst()
  await log(s, ws, connectionId, conn?.entity_id ?? null, `${conn?.display_name ?? 'A connection'} was removed and its data deleted, as its provider requires.`)
  return { records, accountsDeleted, accountsKept }
}

/**
 * The files a connection brought (uploaded statements: documents whose record is the connection), deleted with "delete
 * its data": the stored bytes and the row. A bill or receipt that pointed at one keeps its row, without the file.
 */
export async function deleteConnectionFiles(db: Kysely<CoreTables>, files: FileStore, ws: string, connectionId: string, warn?: (msg: string, f?: Record<string, unknown>) => void): Promise<number> {
  const docs = await db.selectFrom('documents').select(['id', 'storage_key']).where('workspace_id', '=', ws).where('record_type', '=', 'connection').where('record_id', '=', connectionId).execute()
  if (!docs.length) return 0
  const ids = docs.map((d) => d.id)
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  await anyDb.updateTable('books_documents').set({ document_id: null }).where('workspace_id', '=', ws).where('document_id', 'in', ids).execute().catch(() => undefined)
  for (const d of docs) await files.delete(d.storage_key).catch((err: unknown) => warn?.('file delete failed', { error: err instanceof Error ? err.message : 'unknown' }))
  await db.deleteFrom('documents').where('workspace_id', '=', ws).where('id', 'in', ids).execute()
  return docs.length
}

/**
 * After a sync of `connectionId`: retire what a disconnected connection for the same provider company or accounts
 * still counts from this connection's first day on. Idempotent; a no-op when nothing overlaps.
 */
export async function retireReplaced(s: Deps, ws: string, connectionId: string): Promise<number> {
  const db = s.db as unknown as Kysely<CoreTables & { ledger_records: { connection_id: string; workspace_id: string; event_type: string; date: string; status: string } }>
  const conn = await db.selectFrom('connections').select(['id', 'connector_key', 'config_json', 'status', 'entity_id', 'display_name']).where('id', '=', connectionId).where('workspace_id', '=', ws).executeTakeFirst()
  if (!conn || conn.status === 'disconnected') return 0
  const olds = await db.selectFrom('connections').select(['id', 'config_json', 'display_name', 'entity_id']).where('workspace_id', '=', ws).where('connector_key', '=', conn.connector_key).where('status', '=', 'disconnected').where('id', '!=', conn.id).execute()
  if (!olds.length) return 0
  const first = await db.selectFrom('ledger_records').select((eb) => eb.fn.min<string>('date').as('d')).where('workspace_id', '=', ws).where('connection_id', '=', conn.id).where('event_type', 'not in', ['account.upsert', 'balance.snapshot', 'report.snapshot']).executeTakeFirst()
  const from = first?.d ?? undefined
  const org = providerOrgOf(conn.config_json)
  const mine = await db.selectFrom('accounts').select(['id', 'institution', 'mask', 'account_type', 'currency', 'duplicate_of', 'entity_id']).where('workspace_id', '=', ws).where('connection_id', '=', conn.id).execute()
  const promoted: string[] = []
  const sameAccount = (a: { institution: string | null; mask: string | null; account_type: string; currency: string }) =>
    !!a.mask && mine.some((m) => m.mask === a.mask && m.account_type === a.account_type && m.currency === a.currency && (m.institution ?? '') === (a.institution ?? ''))
  let total = 0
  for (const old of olds) {
    let n = 0
    let what: string
    if (org && providerOrgOf(old.config_json) === org) {
      if (!from) continue // nothing synced yet: nothing counts twice yet
      n = (await s.ledger.retireRecords?.(ws, { connectionId: old.id, from })) ?? 0
      await financeFor(s).books.retireConnection(ws, old.id, from)
      await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('connection_id', '=', old.id).where('closed_at', 'is', null).execute()
      what = `the same ${NAME[conn.connector_key] ?? conn.connector_key} company`
    } else {
      const theirs = await db.selectFrom('accounts').select(['id', 'institution', 'mask', 'account_type', 'currency', 'closed_at', 'entity_id', 'include_in_cash']).where('connection_id', '=', old.id).execute()
      const accts = theirs.filter((a) => !a.closed_at && (mine.some((m) => m.duplicate_of === a.id) || sameAccount(a)))
      if (!accts.length) continue
      // The sync marked our copies duplicates of the old accounts (same institution and last 4): ours become the
      // accounts that count, in the old one's company, and the old ones close.
      for (const a of accts) {
        const twin = mine.find((m) => m.duplicate_of === a.id) ?? mine.find((m) => m.mask === a.mask && m.account_type === a.account_type && m.currency === a.currency)
        if (!twin) continue
        await db.updateTable('accounts').set({ duplicate_of: null, include_in_cash: a.include_in_cash, ...(twin.entity_id ? {} : { entity_id: a.entity_id }) }).where('id', '=', twin.id).execute()
        await db.updateTable('accounts').set({ duplicate_of: twin.id }).where('duplicate_of', '=', a.id).where('id', '!=', twin.id).execute()
        promoted.push(twin.id)
      }
      n = (await s.ledger.retireRecords?.(ws, { connectionId: old.id, sourceAccountIds: accts.map((a) => a.id), ...(from ? { from } : {}) })) ?? 0
      await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('id', 'in', accts.map((a) => a.id)).execute()
      what = `${accts.length === 1 ? 'an account' : `${accts.length} accounts`} it also reads`
    }
    if (n) {
      // Records with no date of their own (contacts, chart accounts) sit at the ledger's 1970-01-01 placeholder:
      // that's no date to show a person.
      const since = from && from > '1970-01-01' ? ` from ${from} on` : ''
      const count = `${n} record${n === 1 ? '' : 's'}`
      const line =
        conn.display_name === old.display_name
          ? `${conn.display_name} was connected again, so the earlier, disconnected one stopped counting ${count}${since}.`
          : `${conn.display_name} now reads ${what}, so ${old.display_name} (disconnected) stopped counting ${count}${since}.`
      await log(s, ws, old.id, old.entity_id, line)
    }
    total += n
  }
  // Rows held as duplicates of the old accounts now post as these accounts' own.
  for (const id of promoted) await s.ledger.accountChanged?.(ws, id)
  return total
}

/** Institution names as files and providers write them ("Chase", "JPMorgan Chase Bank, N.A.", OFX's "B1"). */
function sameBank(a: string | null, b: string | null): boolean {
  const words = (s: string | null) => new Set((s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['bank', 'the', 'n.a', 'na', 'inc', 'corp', 'national', 'association'].includes(w)))
  const [x, y] = [words(a), words(b)]
  // An OFX FI code (B1, HAN) or no name at all can't contradict: the last 4, type, currency and company decide.
  if (x.size === 0 || y.size === 0) return true
  return [...x].some((w) => y.has(w))
}

/**
 * After a bank sync: an account the person already uploaded statements for (same company, last 4, type, currency,
 * and a bank name that doesn't contradict) becomes a second source of the synced account, so its rows post into it
 * (rows both report are matched as duplicates) and its balances don't count twice. Statement first, bank later.
 */
export async function adoptStatementAccounts(s: Deps, ws: string, connectionId: string): Promise<number> {
  const db = s.db
  const conn = await db.selectFrom('connections').select(['connector_key', 'status']).where('id', '=', connectionId).where('workspace_id', '=', ws).executeTakeFirst()
  if (!conn || conn.connector_key === 'files' || conn.status === 'disconnected') return 0
  const synced = await db.selectFrom('accounts').select(['id', 'entity_id', 'mask', 'account_type', 'currency', 'institution']).where('connection_id', '=', connectionId).where('workspace_id', '=', ws).where('duplicate_of', 'is', null).where('closed_at', 'is', null).execute()
  if (!synced.some((a) => a.mask)) return 0
  const uploaded = await db
    .selectFrom('accounts')
    .innerJoin('connections', 'connections.id', 'accounts.connection_id')
    .select(['accounts.id', 'accounts.entity_id', 'accounts.mask', 'accounts.account_type', 'accounts.currency', 'accounts.institution'])
    .where('accounts.workspace_id', '=', ws)
    .where('connections.connector_key', '=', 'files')
    .where('accounts.duplicate_of', 'is', null)
    .where('accounts.closed_at', 'is', null)
    .execute()
  // Accounts the person explicitly uploaded "as a new, separate account" are never adopted: they chose to keep them
  // apart, so a later bank sync must not merge them and hide their balance (43's case — an explicit "new" OFX with no
  // bank name became a duplicate of the Plaid ••0000, its $1,234.56 dropped from cash). 3b still flags a true match.
  const keptSeparate = new Set((await db.selectFrom('settings').select('key').where('workspace_id', '=', ws).where('key', 'like', 'stmt:keep_separate:%').execute()).map((r) => r.key.slice('stmt:keep_separate:'.length)))
  let n = 0
  for (const u of uploaded) {
    if (keptSeparate.has(u.id)) continue
    const twin = synced.find((a) => a.mask && a.mask === u.mask && a.account_type === u.account_type && a.currency === u.currency && a.entity_id === u.entity_id && sameBank(a.institution, u.institution))
    if (!twin) continue
    await db.updateTable('accounts').set({ duplicate_of: twin.id, include_in_cash: 0 }).where('id', '=', u.id).execute()
    await s.ledger.accountChanged?.(ws, u.id)
    await log(s, ws, connectionId, u.entity_id, `Uploaded statements for ••${u.mask} now count as the same account as the synced one, so nothing is counted twice.`)
    n++
  }
  return n
}
