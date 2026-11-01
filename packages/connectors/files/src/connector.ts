// File import connector: bank/card statements the person uploads (CSV, OFX/QFX/QBO, ISO 20022 camt.053, PDF/images).
// There's no provider API. The platform keeps an upload queue and exposes it through FileSource; sync() processes one
// file per page and the cursor is the last processed fileId, so a crash resumes at the next file and re-importing
// is harmless (stable ids).

import { randomUUID } from 'node:crypto'
import type {
  AccountType,
  ConnectBegin,
  ConnectBeginContext,
  Connector,
  ConnectionRef,
  ConnectorDescription,
  ConnectorHealth,
  SyncResult,
} from '@agfn/contracts'
import { ConnectorError, cursorCodec, isConnectorError, isRecord, str, type ConnectorDeps } from '@agfn/connector-sdk'
import { isColumnMapping, type ColumnMapping } from './csv.ts'
import type { DocumentDescriptor } from './document.ts'
import type { PriorRow } from './events.ts'
import { plainImportError } from './plain.ts'
import { importFile, type ImportResult } from './import.ts'
import { PROVIDER, invalid } from './text.ts'

export interface PendingFile {
  fileId: string
  filename: string
  bytes: Uint8Array
  /** CSV column mapping chosen by the person (or found via findImportMapping). */
  mapping?: ColumnMapping
}

/** Implemented by the platform: the connection's upload queue, in a stable order. */
export interface FileSource {
  /** Files uploaded after `afterCursor` (a fileId; null = from the beginning), oldest first. */
  list(connectionId: string, afterCursor: string | null): Promise<PendingFile[]>
  /** Optional: rows earlier files of this connection imported for one account in a date range (FITID re-issue guard). */
  priorRows?(connectionId: string, accountExternalId: string, from: string, to: string): Promise<PriorRow[]>
  /** Optional: told what happened to each file (balance check, warnings, documents to store, files that failed). */
  report?(connectionId: string, fileId: string, outcome: FileOutcome): Promise<void>
}

export type FileOutcome =
  /** eventCount = statement rows (transactions) only; the account and balance lines aren't counted. */
  | { status: 'imported'; result: Omit<ImportResult, 'events'> & { eventCount: number } }
  | { status: 'document'; document: DocumentDescriptor }
  | { status: 'failed'; error: { kind: string; code?: string; message: string } }

export interface FilesConfig {
  accountExternalId: string
  name: string
  accountType: AccountType
  currency: string
  institution?: string
  /** Default CSV mapping for this account's files. */
  mapping?: ColumnMapping
  /** Statements for an account another connection already reads: OFX files post into this connection's account. */
  forAccountId?: string
  /** A company's catch-all "Uploaded statements": a known bank's CSV goes to its own account (ImportOptions.presetAccounts). */
  catchAll?: boolean
}

export interface FilesConnectorOptions {
  source: FileSource
  /** Auto-mapping threshold for CSVs without a mapping (default 0.7). */
  minConfidence?: number
}

const ACCOUNT_TYPES: readonly AccountType[] = [
  'depository', 'credit_card', 'processor_balance', 'cash_on_hand', 'loan', 'investment', 'crypto', 'owner_payable',
  'intercompany', 'clearing', 'other',
]

/** What the upload picker accepts. */
export const FILE_ACCEPT =
  '.csv,.tsv,.txt,.ofx,.qfx,.qbo,.xml,.pdf,.png,.jpg,.jpeg,.heic,.heif,' +
  'text/csv,text/plain,text/tab-separated-values,application/x-ofx,application/vnd.intu.qfx,application/xml,text/xml,application/pdf,image/png,image/jpeg,image/heic,image/heif'

interface FilesCursor {
  after: string
}
const isFilesCursor = (v: unknown): v is FilesCursor => isRecord(v) && typeof v.after === 'string' && v.after !== ''

export function filesConfigOf(conn: ConnectionRef): FilesConfig {
  const c = conn.config
  const accountExternalId = str(c.accountExternalId)
  const name = str(c.name)
  const accountType = ACCOUNT_TYPES.find((t) => t === c.accountType)
  const currency = str(c.currency)
  if (!accountExternalId || !name || !accountType || !currency) {
    throw new ConnectorError('permanent', 'file connection config is incomplete', { provider: PROVIDER })
  }
  const institution = str(c.institution)
  return {
    accountExternalId,
    name,
    accountType,
    currency,
    ...(institution ? { institution } : {}),
    ...(isColumnMapping(c.mapping) ? { mapping: c.mapping } : {}),
    ...(str(c.forAccountId) ? { forAccountId: str(c.forAccountId) as string } : {}),
    ...(c.catchAll === true ? { catchAll: true } : {}),
  }
}

const MAX_WARNINGS = 5
const shortName = (filename: string) => {
  const base = filename.split(/[\\/]/).pop() || 'file'
  return base.length > 60 ? `${base.slice(0, 57)}...` : base
}

/** A short summary of a file's balance-check mismatches and row warnings for SyncResult.warnings (full detail goes to report). */
export function importWarnings(filename: string, result: Pick<ImportResult, 'balanceCheck' | 'warnings'>): string[] {
  const name = shortName(filename)
  const out: string[] = []
  for (const c of result.balanceCheck) {
    if (c.status !== 'mismatch') continue
    if (c.method === 'running_balance') {
      const n = c.mismatches.length
      const first = c.mismatches[0]
      out.push(`${name}: the running balance doesn't add up on ${n} row${n === 1 ? '' : 's'}${first ? ` (first at line ${first.line})` : ''}; some rows may be missing or wrong.`)
    } else {
      out.push(`${name}: the closing balance doesn't match the opening balance plus the transactions; some rows may be missing.`)
    }
  }
  const rows = [...new Set(result.warnings)]
  if (rows.length === 1) out.push(`${name}: ${rows[0]!.slice(0, 160)}`)
  else if (rows.length > 1) out.push(`${name}: ${rows.length} import warnings, e.g. ${rows[0]!.slice(0, 120)}`)
  return [...new Set(out)].slice(0, MAX_WARNINGS)
}

export interface FilesConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
}

export function createFilesConnector(opts: FilesConnectorOptions, deps: ConnectorDeps): FilesConnector {
  const codec = cursorCodec<FilesCursor>(PROVIDER, 1, isFilesCursor)
  const description: ConnectorDescription = {
    key: 'files',
    name: 'Statement files (CSV, OFX, camt.053, PDF)',
    group: 'files',
    provides: ['balances', 'transactions', 'documents'],
    freshness: 'updates when you upload a statement',
    auth: 'file',
  }

  return {
    describe: () => description,

    async begin() {
      return { kind: 'upload', accept: FILE_ACCEPT }
    },

    async connect(input) {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (!name || name.length > 200) throw invalid('name is required')
      const accountType = ACCOUNT_TYPES.find((t) => t === input.accountType)
      if (!accountType) throw invalid(`accountType must be one of ${ACCOUNT_TYPES.join(', ')}`)
      const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
      if (!/^[A-Z]{3}$/.test(currency)) throw invalid('currency must be an ISO 4217 code like USD')
      let accountExternalId: string
      if (input.accountExternalId === undefined || input.accountExternalId === null || input.accountExternalId === '') {
        accountExternalId = `file_${randomUUID()}`
      } else if (typeof input.accountExternalId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input.accountExternalId)) {
        accountExternalId = input.accountExternalId
      } else throw invalid('accountExternalId must be 1-128 letters, digits, or _ . : -')
      if (input.mapping !== undefined && !isColumnMapping(input.mapping)) throw invalid('mapping is not a valid ColumnMapping')
      const institution = typeof input.institution === 'string' && input.institution.trim() ? input.institution.trim() : undefined
      const config: FilesConfig = {
        accountExternalId,
        name,
        accountType,
        currency,
        ...(institution ? { institution } : {}),
        ...(isColumnMapping(input.mapping) ? { mapping: input.mapping } : {}),
      }
      // No credential: file connections have nothing secret.
      return { secret: null, config: { ...config } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const config = filesConfigOf(conn)
      const after = codec.decode(cursor)?.after ?? null
      const pending = await opts.source.list(conn.id, after)
      const file = pending[0]
      if (!file) return { events: [], cursor, hasMore: false }
      if (!file.fileId || file.fileId === after) {
        throw new ConnectorError('permanent', 'FileSource returned a file at or before the cursor', { provider: PROVIDER })
      }
      const next = codec.encode({ after: file.fileId })
      const hasMore = pending.length > 1

      let result: ImportResult
      try {
        result = await importFile(file.bytes, file.filename, {
          connectionId: conn.id,
          raw: deps.raw,
          accountExternalId: config.accountExternalId,
          account: config,
          ...(config.forAccountId ? { ofxIntoFileAccount: true } : {}),
          ...(config.catchAll ? { presetAccounts: true } : {}),
          ...(opts.source.priorRows ? { prior: (acct: string, from: string, to: string) => opts.source.priorRows!(conn.id, acct, from, to) } : {}),
          ...(file.mapping ?? config.mapping ? { mapping: file.mapping ?? config.mapping } : {}),
          ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
        })
      } catch (e) {
        // A bad file must not block the queue: report it and move on. Without a report hook, surface the error.
        if (isConnectorError(e) && e.kind === 'invalid_input' && opts.source.report) {
          await opts.source.report(conn.id, file.fileId, {
            status: 'failed',
            // The person sees plain words; the parser's own message stays in the warning below (logs, the AI).
            error: { kind: e.kind, message: plainImportError(e.code, e.message), ...(e.code ? { code: e.code } : {}) },
          })
          return { events: [], cursor: next, hasMore, warnings: [`${shortName(file.filename)} couldn't be imported: ${e.message.slice(0, 160)}`] }
        }
        throw e
      }
      if (result.document) await opts.source.report?.(conn.id, file.fileId, { status: 'document', document: result.document })
      else {
        const { events, ...rest } = result
        await opts.source.report?.(conn.id, file.fileId, { status: 'imported', result: { ...rest, eventCount: events.filter((e) => e.type === 'txn.upsert').length } })
      }
      const warnings = result.document ? [] : importWarnings(file.filename, result)
      return { events: result.events, cursor: next, hasMore, ...(warnings.length ? { warnings } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        filesConfigOf(conn)
        return { status: 'ok' }
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : 'bad config' }
      }
    },
  }
}
