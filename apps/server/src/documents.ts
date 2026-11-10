import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { AccountType } from '@agfn/contracts'
import { newId, nowIso, type CoreTables } from '@agfn/db'
import { MIME, sniffKind, type FileStore } from '@agfn/files'
import type { KeyRing } from '@agfn/security'
import { createConnection, institutionsCompatible, type SyncEngine } from '@agfn/sync'
import { extractPdfText, parsePdfStatement, isColumnMapping, planCsvImport, type ColumnMapping, type MappingAnswers, type MappingQuestion, type PdfText } from '@agfn/connector-files'
import { keepSeparateKey } from './retire.ts'

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const STATEMENT_KINDS = new Set(['csv', 'ofx', 'qfx', 'qbo', 'xml'])

export interface UploadInput {
  workspaceId: string
  entityId: string
  personId: string | null
  filename: string
  bytes: Uint8Array
  arrivedVia: 'upload' | 'agent' | 'email'
  /**
   * Statements only: the account this file is for (an existing account id), or 'new' for a separate "Uploaded
   * statements" account. Omitted: OFX/QFX are matched by account number; otherwise, when the company already has
   * accounts, the file waits with state 'needs_account' until someone answers.
   */
  accountId?: string
}

export interface StatementAccountChoice {
  id: string
  name: string
  mask?: string
  institution?: string
}

export interface UploadOutcome {
  documentId: string
  name: string
  state: 'imported' | 'unread' | 'needs_account' | 'needs_mapping'
  message: string
  duplicate: boolean
  /** With state 'needs_mapping': one plain question about the file's columns (answer with answerMapping). */
  question?: MappingQuestion
  /** With state 'needs_account': the company's accounts to choose from (or 'new'). */
  accounts?: StatementAccountChoice[]
}

/** The "Uploaded statements" connection for a company: statements that aren't for an account we already read. */
async function statementConnection(db: Kysely<CoreTables>, keys: KeyRing, workspaceId: string, entityId: string, personId: string | null): Promise<string> {
  const existing = await db
    .selectFrom('connections')
    .select(['id', 'config_json'])
    .where('workspace_id', '=', workspaceId)
    .where('connector_key', '=', 'files')
    .where('entity_id', '=', entityId)
    .where('status', '!=', 'disconnected')
    .execute()
  const generic = existing.find((c) => !(JSON.parse(c.config_json) as { forAccountId?: string }).forAccountId)
  if (generic) {
    await placeholderFor(db, generic.id)
    return generic.id
  }
  const entity = await db.selectFrom('entities').select(['base_currency']).where('id', '=', entityId).executeTakeFirstOrThrow()
  const accountExternalId = `upload_${entityId}`
  const id = await createConnection(db, keys, {
    workspaceId,
    connectorKey: 'files',
    displayName: 'Uploaded statements',
    secret: null,
    config: { accountExternalId, name: 'Uploaded statements', accountType: 'depository', currency: entity.base_currency, catchAll: true },
    createdBy: personId,
    entityId,
  })
  await placeholderFor(db, id)
  return id
}

/**
 * The catch-all account ("Uploaded statements") a statement that names no account of its own imports into, made just
 * before an import that may use it. Not counted as cash until a statement gives a balance: a few rows alone would make
 * the balance up from zero. A statement that names its own account (OFX, camt, a known bank's CSV or PDF) leaves it
 * empty, and it goes again after the import (dropUnusedPlaceholder).
 */
async function placeholderFor(db: Kysely<CoreTables>, connectionId: string): Promise<void> {
  const c = await db.selectFrom('connections').select(['workspace_id', 'entity_id', 'config_json']).where('id', '=', connectionId).executeTakeFirst()
  const cfg = c ? (JSON.parse(c.config_json) as { accountExternalId?: string; name?: string; currency?: string; catchAll?: boolean }) : {}
  if (!c || !c.entity_id || !cfg.catchAll || !cfg.accountExternalId) return
  const there = await db.selectFrom('accounts').select('id').where('connection_id', '=', connectionId).where('external_id', '=', cfg.accountExternalId).executeTakeFirst()
  if (there) return
  await db
    .insertInto('accounts')
    .values({ id: newId(), workspace_id: c.workspace_id, entity_id: c.entity_id, connection_id: connectionId, external_id: cfg.accountExternalId, name: cfg.name ?? 'Uploaded statements', account_type: 'depository', currency: cfg.currency ?? 'USD', mask: null, institution: null, business_hint: null, include_in_cash: 0, duplicate_of: null, created_at: nowIso(), closed_at: null })
    .execute()
}

/**
 * After an import: the catch-all account goes if nothing is in it (no rows, balances or lines, nothing marked as its
 * copy, no balance pinned or account settings), so a statement that named its own account doesn't leave an empty
 * "Uploaded statements" beside it. The next statement without an account of its own makes it again.
 */
async function dropUnusedPlaceholder(db: Kysely<CoreTables>, connectionId: string): Promise<void> {
  const c = await db.selectFrom('connections').select(['workspace_id', 'config_json']).where('id', '=', connectionId).executeTakeFirst()
  const cfg = c ? (JSON.parse(c.config_json) as { accountExternalId?: string; catchAll?: boolean }) : {}
  if (!c || !cfg.catchAll || !cfg.accountExternalId) return
  const ws = c.workspace_id
  const a = await db.selectFrom('accounts').select('id').where('connection_id', '=', connectionId).where('external_id', '=', cfg.accountExternalId).executeTakeFirst()
  if (!a) return
  const q = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const any = async (t: string, col: string, op: '=' | 'like', v: string) => !!(await q.selectFrom(t).select(col).where('workspace_id', '=', ws).where(col, op, v).limit(1).executeTakeFirst())
  if (await any('ledger_records', 'source_account_id', '=', a.id)) return
  if (await any('accounts', 'duplicate_of', '=', a.id)) return
  if (await any('ledger_assertions', 'account_id', '=', a.id)) return
  for (const t of ['account_reassignments', 'account_holdings', 'account_liabilities']) {
    if (await q.selectFrom(t).select('account_id').where('account_id', '=', a.id).limit(1).executeTakeFirst().catch(() => undefined)) return
  }
  // Its own ledger accounts (cash:/card:… <id>, coa.ts cashRole): none may carry a line.
  const own = ((await q.selectFrom('ledger_accounts').select('id').where('workspace_id', '=', ws).where('role', 'like', `%:${a.id}`).execute()) as Array<{ id: string }>).map((r) => r.id)
  if (own.length && (await q.selectFrom('journal_lines').select('id').where('workspace_id', '=', ws).where('ledger_account_id', 'in', own).limit(1).executeTakeFirst())) return
  if (own.length) await q.deleteFrom('ledger_accounts').where('workspace_id', '=', ws).where('id', 'in', own).execute()
  await db.deleteFrom('accounts').where('id', '=', a.id).execute()
}

const FILE_ACCOUNT_TYPES = new Set(['depository', 'credit_card', 'processor_balance', 'cash_on_hand', 'loan', 'investment', 'crypto', 'owner_payable', 'intercompany', 'clearing', 'other'])

/**
 * Statements for an account we already read (e.g. a Plaid checking account): their own files connection whose
 * account is marked as the same real account (duplicate_of), so its rows merge into that account and its balance
 * never counts twice. Statements uploaded to a files account just go to that account's connection.
 */
async function statementConnectionFor(db: Kysely<CoreTables>, keys: KeyRing, workspaceId: string, accountId: string, personId: string | null): Promise<string | null> {
  const a = await db.selectFrom('accounts').selectAll().where('id', '=', accountId).where('workspace_id', '=', workspaceId).where('closed_at', 'is', null).executeTakeFirst()
  if (!a || !a.entity_id) return null
  const owner = await db.selectFrom('connections').select(['connector_key']).where('id', '=', a.connection_id).executeTakeFirst()
  if (owner?.connector_key === 'files') return a.connection_id
  const twins = await db.selectFrom('connections').select(['id', 'config_json']).where('workspace_id', '=', workspaceId).where('connector_key', '=', 'files').where('status', '!=', 'disconnected').execute()
  const twin = twins.find((c) => (JSON.parse(c.config_json) as { forAccountId?: string }).forAccountId === a.id)
  if (twin) return twin.id
  const accountExternalId = `stmt_${a.id}`
  const id = await createConnection(db, keys, {
    workspaceId,
    connectorKey: 'files',
    displayName: `Statements · ${a.name}`,
    secret: null,
    config: { accountExternalId, name: a.name, accountType: FILE_ACCOUNT_TYPES.has(a.account_type) ? a.account_type : 'other', currency: a.currency, ...(a.institution ? { institution: a.institution } : {}), forAccountId: a.id },
    createdBy: personId,
    entityId: a.entity_id,
  })
  await db
    .insertInto('accounts')
    .values({ id: newId(), workspace_id: workspaceId, entity_id: a.entity_id, connection_id: id, external_id: accountExternalId, name: a.name, account_type: a.account_type, currency: a.currency, mask: a.mask, institution: a.institution, business_hint: a.business_hint, include_in_cash: 0, duplicate_of: a.id, created_at: nowIso(), closed_at: null })
    .execute()
  return id
}

/** OFX/QFX carry the account number: its last 4 digits pick the account when exactly one matches. */
function ofxAccountMask(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024))
  const m = /<ACCTID>\s*([^<\s]+)/i.exec(text)
  const digits = m?.[1]?.replace(/\D/g, '')
  return digits && digits.length >= 4 ? digits.slice(-4) : undefined
}

/** OFX/QFX name the bank in <FI><ORG> (or a bare <ORG>). Absent in many files — then we can't confirm which account
 *  it is by the last 4 alone, so the upload is never silently merged (see the mask gate in the upload flow). */
function ofxAccountInstitution(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024))
  const m = /<ORG>\s*([^<\r\n]+?)\s*(?:<|$)/i.exec(text)
  const org = m?.[1]?.trim()
  return org || undefined
}

/** camt.053 names the account by IBAN (or another account number): its last 4 pick the account the same way. */
function camtAccountMask(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024))
  const m = /<(?:\w+:)?IBAN>\s*([A-Za-z0-9 ]+?)\s*</.exec(text) ?? /<(?:\w+:)?Othr>\s*<(?:\w+:)?Id>\s*([^<\s]+)\s*</.exec(text)
  const n = m?.[1]?.replace(/\s/g, '')
  return n && n.length >= 4 ? n.slice(-4) : undefined
}

export function createDocuments(deps: { db: Kysely<CoreTables>; store: FileStore; keys: KeyRing; sync: SyncEngine }) {
  const { db, store, keys, sync } = deps

  /** The company's accounts a statement could be for (accounts another source already covers are left out). */
  async function statementChoices(workspaceId: string, entityId: string): Promise<{ choices: StatementAccountChoice[]; hasReal: boolean }> {
    const rows = await db
      .selectFrom('accounts')
      .innerJoin('connections', 'connections.id', 'accounts.connection_id')
      .select(['accounts.id', 'accounts.name', 'accounts.mask', 'accounts.institution', 'accounts.account_type', 'connections.connector_key', 'connections.config_json'])
      .where('accounts.workspace_id', '=', workspaceId)
      .where('accounts.entity_id', '=', entityId)
      .where('accounts.closed_at', 'is', null)
      .where('accounts.duplicate_of', 'is', null)
      .where('connections.status', '!=', 'disconnected')
      .execute()
    // A bank statement is never for a processor's balance (Stripe, Square…): those aren't offered, nor do they make
    // a new statement ambiguous.
    const listed = rows.filter((r) => r.connector_key !== 'manual' && r.account_type !== 'processor_balance')
    return {
      choices: listed.map((r) => ({ id: r.id, name: r.name, ...(r.mask ? { mask: r.mask } : {}), ...(r.institution ? { institution: r.institution } : {}) })),
      // Only the generic "Uploaded statements" account so far: nothing to confuse a new statement with.
      hasReal: listed.some((r) => r.connector_key !== 'files' || !!(JSON.parse(r.config_json) as { forAccountId?: string }).forAccountId),
    }
  }

  /** Statements waiting for "which account is this for?" (e.g. from email-in), with the accounts to choose from. */
  async function waitingStatements(workspaceId: string, documentId?: string): Promise<Array<{ documentId: string; name: string; entityId: string; arrivedVia: string; createdAt: string; accounts: StatementAccountChoice[] }>> {
    let q = db
      .selectFrom('documents')
      .select(['id', 'original_name', 'entity_id', 'arrived_via', 'created_at', 'extracted_json'])
      .where('workspace_id', '=', workspaceId)
      .where('record_id', 'is', null)
      .where('extracted_json', 'like', '%needs_account%')
      .orderBy('created_at')
    if (documentId) q = q.where('id', '=', documentId)
    const out = []
    for (const d of await q.execute()) {
      if (!d.entity_id || (JSON.parse(d.extracted_json ?? '{}') as { status?: string }).status !== 'needs_account') continue
      out.push({ documentId: d.id, name: d.original_name ?? 'statement', entityId: d.entity_id, arrivedVia: d.arrived_via, createdAt: d.created_at, accounts: (await statementChoices(workspaceId, d.entity_id)).choices })
    }
    return out
  }

  async function insertDoc(a: { id: string; input: UploadInput; storageKey: string; sha256: string; kind: keyof typeof MIME; name: string; extracted: Record<string, unknown> | null; connectionId: string | null }): Promise<void> {
    await db
      .insertInto('documents')
      .values({
        id: a.id,
        workspace_id: a.input.workspaceId,
        entity_id: a.input.entityId,
        storage_key: a.storageKey,
        sha256: a.sha256,
        mime_type: MIME[a.kind],
        size_bytes: a.input.bytes.byteLength,
        original_name: a.name,
        arrived_via: a.input.arrivedVia,
        status: 'unread',
        extracted_json: a.extracted ? JSON.stringify(a.extracted) : null,
        record_type: a.connectionId ? 'connection' : null,
        record_id: a.connectionId,
        created_by: a.input.personId,
        created_at: nowIso(),
      })
      .execute()
  }

  /** The kind of account a statement is for, when the person said: a card export reads its signs differently. */
  async function hintFor(accountId: string | null | undefined): Promise<{ accountType?: AccountType }> {
    if (!accountId || accountId === 'new') return {}
    const a = await db.selectFrom('accounts').select('account_type').where('id', '=', accountId).executeTakeFirst()
    return a ? { accountType: a.account_type as AccountType } : {}
  }

  /** One answer to the file's question; the next question, or the file goes on to "which account?" and imports. */
  async function answerMapping(input: { workspaceId: string; documentId: string; field: string; value: string; personId: string | null }): Promise<UploadOutcome> {
    const d = await db.selectFrom('documents').select(['id', 'entity_id', 'original_name', 'extracted_json', 'storage_key', 'record_id']).where('id', '=', input.documentId).where('workspace_id', '=', input.workspaceId).executeTakeFirst()
    if (!d || !d.entity_id) throw new UploadError('That file no longer exists.')
    const st = JSON.parse(d.extracted_json ?? '{}') as { status?: string; answers?: MappingAnswers; accountId?: string | null }
    if (st.status !== 'needs_mapping' || d.record_id) throw new UploadError('That statement isn’t waiting for an answer.')
    if (!['date', 'amount', 'sign', 'dateFormat'].includes(input.field) || !input.value || input.value.length > 200) throw new UploadError('Choose one of the options.')
    const bytes = await store.get(d.storage_key)
    if (!bytes) throw new UploadError('That file no longer exists.')
    const answers = { ...st.answers, [input.field]: input.value } as MappingAnswers
    const plan = planCsvImport(bytes, answers, await hintFor(st.accountId))
    const name = d.original_name ?? 'statement'
    if ('question' in plan) {
      await db.updateTable('documents').set({ extracted_json: JSON.stringify({ ...st, answers, question: plan.question }) }).where('id', '=', d.id).execute()
      return { documentId: d.id, name, state: 'needs_mapping', message: plan.question.text, duplicate: false, question: plan.question }
    }
    let target = st.accountId ?? undefined
    const { choices, hasReal } = await statementChoices(input.workspaceId, d.entity_id)
    if (!target && !hasReal) target = 'new'
    if (!target) {
      await db.updateTable('documents').set({ extracted_json: JSON.stringify({ status: 'needs_account', mapping: plan.mapping }) }).where('id', '=', d.id).execute()
      return { documentId: d.id, name, state: 'needs_account', message: 'Which account is this statement for?', duplicate: false, accounts: choices }
    }
    const connectionId = target === 'new' ? await statementConnection(db, keys, input.workspaceId, d.entity_id, input.personId) : await statementConnectionFor(db, keys, input.workspaceId, target, input.personId)
    if (!connectionId) throw new UploadError('That account no longer exists. Choose another one.')
    await db.updateTable('documents').set({ record_type: 'connection', record_id: connectionId, extracted_json: JSON.stringify({ mapping: plan.mapping }) }).where('id', '=', d.id).execute()
    return importStatement(d.id, name, connectionId)
  }

  async function upload(input: UploadInput): Promise<UploadOutcome> {
    if (input.bytes.byteLength === 0) throw new UploadError('That file is empty.')
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError('That file is too large (8 MB max).')
    const kind = sniffKind(input.filename, input.bytes)
    if (!kind) throw new UploadError('Upload a PDF, a photo (JPG, PNG, HEIC) or a statement file (CSV, OFX, QFX, QBO, camt.053 XML).')
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const name = input.filename.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 200) || `upload.${kind}`

    // The same file twice returns the first one (MASTER §6: files hashed).
    const dup = await db.selectFrom('documents').select(['id', 'status', 'original_name', 'extracted_json']).where('workspace_id', '=', input.workspaceId).where('sha256', '=', sha256).executeTakeFirst()
    if (dup && dup.extracted_json && (JSON.parse(dup.extracted_json) as { status?: string }).status === 'needs_account' && input.accountId) {
      return chooseAccount({ workspaceId: input.workspaceId, documentId: dup.id, accountId: input.accountId, personId: input.personId })
    }
    if (dup && dup.extracted_json && (JSON.parse(dup.extracted_json) as { status?: string }).status === 'needs_account') {
      // Same bytes again while the first copy still waits for its account: show that question again.
      const [w] = await waitingStatements(input.workspaceId, dup.id)
      if (w) return { documentId: dup.id, name: w.name, state: 'needs_account', message: 'Which account is this statement for?', duplicate: true, accounts: w.accounts }
    }
    if (dup) {
      return { documentId: dup.id, name: dup.original_name ?? name, state: dup.status === 'unread' ? 'unread' : 'imported', message: 'You already uploaded this file.', duplicate: true }
    }

    // A PDF's text layer is read once, here, so the person's AI can read it (get_document). A locked one is refused
    // when someone uploads it (we never take passwords); one that arrived by email is kept and says why.
    const pdf = kind === 'pdf' ? await extractPdfText(input.bytes) : null
    if (pdf?.status === 'locked' && input.arrivedVia === 'upload') throw new UploadError('This PDF is locked with a password. Download it again without one, or export a CSV.', 'locked_document')

    const id = newId()
    const storageKey = `${input.workspaceId}/${sha256}.${kind}`
    await store.put(storageKey, input.bytes)
    // A text PDF from a bank we know, whose rows add up to its balances, is a statement like an OFX file.
    const pdfStatement = pdf?.status === 'text' ? parsePdfStatement(pdf.lines) : null
    const isStatement = STATEMENT_KINDS.has(kind) || pdfStatement?.ok === true
    // A CSV we can't read with confidence waits with one question ("Which column is the amount?").
    const plan = kind === 'csv' ? planCsvImport(input.bytes, {}, await hintFor(input.accountId)) : null
    if (plan && 'question' in plan) {
      await insertDoc({ id, input, storageKey, sha256, kind, name, extracted: { status: 'needs_mapping', question: plan.question, answers: {}, accountId: input.accountId ?? null }, connectionId: null })
      return { documentId: id, name, state: 'needs_mapping', message: plan.question.text, duplicate: false, question: plan.question }
    }
    let target = input.accountId
    let choices: StatementAccountChoice[] = []
    if (isStatement && !target) {
      // Which account is this statement for? Counting it as a new account next to the one we already sync would
      // double the cash.
      const { choices: found, hasReal } = await statementChoices(input.workspaceId, input.entityId)
      choices = found
      const mask = kind === 'csv' ? undefined : kind === 'xml' ? camtAccountMask(input.bytes) : kind === 'pdf' ? (pdfStatement?.ok ? pdfStatement.statement.account.mask : undefined) : ofxAccountMask(input.bytes)
      // The bank the file names, when it says. A PDF matched a known layout; an OFX/QFX/QBO may carry <FI><ORG>.
      const fileInstitution = kind === 'pdf' ? (pdfStatement?.ok ? pdfStatement.statement.layout.institution : undefined) : kind === 'ofx' || kind === 'qfx' || kind === 'qbo' ? ofxAccountInstitution(input.bytes) : undefined
      const byMask = mask ? choices.filter((c) => c.mask === mask) : []
      const single = byMask.length === 1 ? byMask[0]! : undefined
      // Last-4 alone is too weak to merge an upload into an account we already sync (it would hide the upload's money
      // under duplicate_of). For the formats that name their bank (OFX family, PDF) only auto-link when that name is
      // present and compatible with the account's — the same rule the sync engine uses (3a); otherwise ask, or keep it
      // separate ('new') so 3b can flag a true match. camt (IBAN) keeps its existing match for now — its damaged-file
      // path makes the same tightening a separate change (flagged to 34).
      const mustNameBank = kind === 'pdf' || kind === 'ofx' || kind === 'qfx' || kind === 'qbo'
      const linkOk = !!single && (!mustNameBank || !!(fileInstitution && single.institution && institutionsCompatible(fileInstitution, single.institution)))
      if (single && linkOk) target = single.id
      else if (!hasReal) target = 'new'
    }
    const connectionId = !isStatement || !target ? null : target === 'new' ? await statementConnection(db, keys, input.workspaceId, input.entityId, input.personId) : await statementConnectionFor(db, keys, input.workspaceId, target, input.personId)
    if (isStatement && target && target !== 'new' && !connectionId) throw new UploadError('That account no longer exists. Choose another one.')
    const waiting = isStatement && !connectionId
    const pdfInfo = pdf ? { ...pdfExtract(pdf), ...(pdfStatement && !pdfStatement.ok && pdfStatement.layout ? { statement: { layout: pdfStatement.layout, reason: pdfStatement.reason, ...(pdfStatement.diffMinor !== undefined ? { diffMinor: pdfStatement.diffMinor } : {}) } } : {}) } : null
    await insertDoc({ id, input, storageKey, sha256, kind, name, extracted: waiting ? { status: 'needs_account' } : pdfInfo, connectionId })

    if (waiting) {
      return { documentId: id, name, state: 'needs_account', message: 'Which account is this statement for?', duplicate: false, accounts: choices }
    }
    // A long PDF is cut at upload (past 60 pages or 60,000 characters): say so, so the person can send the rest.
    const cut = pdf?.status === 'text' && pdf.truncated ? ' This PDF is long, so only its first part was read. Upload the rest as a separate file of 60 pages or fewer.' : ''
    if (!connectionId) {
      const message =
        pdf?.status === 'scanned'
          ? 'Saved. This PDF is a scan, so it has no text to read. If your bank offers a downloaded statement or a CSV, upload that.'
          : pdf?.status === 'unreadable' || pdf?.status === 'locked'
            ? 'Saved, but we couldn’t read this PDF. If your bank offers a CSV, upload that.'
            : pdfStatement && !pdfStatement.ok && pdfStatement.layout
              ? 'Saved. This looks like a bank statement, but its rows don’t add up to its balances, so nothing was imported. Ask your AI to read it, or upload a CSV.'
              : 'Saved. Ask your AI to read it and add what it finds.'
      return { documentId: id, name, state: 'unread', message: message + cut, duplicate: false }
    }
    const done = await importStatement(id, name, connectionId)
    return cut ? { ...done, message: done.message + cut } : done
  }

  /** Statements import right away so the person sees the result. */
  async function importStatement(id: string, name: string, connectionId: string): Promise<UploadOutcome> {
    // Rows already here from an overlapping file keep their ids, so the file's row count isn't what was added.
    const before = await txnCount(connectionId)
    await sync.sync(connectionId).catch(() => undefined)
    await countOnceBalanceKnown(connectionId)
    await dropUnusedPlaceholder(db, connectionId)
    const after = await db.selectFrom('documents').select(['status', 'extracted_json']).where('id', '=', id).executeTakeFirstOrThrow()
    const report = after.extracted_json ? (JSON.parse(after.extracted_json) as { status?: string; message?: string; eventCount?: number }) : {}
    if (report.status === 'failed') return { documentId: id, name, state: 'unread', message: report.message ?? 'We couldn’t read that statement.', duplicate: false }
    // The import didn't run or didn't finish (the sync failed): don't say it was imported.
    if (after.status !== 'processed') return { documentId: id, name, state: 'unread', message: 'Saved, but it couldn’t be imported right now. It will be tried again on the next sync.', duplicate: false }
    const n = report.eventCount ?? 0
    const added = Math.min(n, Math.max(0, (await txnCount(connectionId)) - before))
    const rows = (k: number) => `${k} ${k === 1 ? 'row' : 'rows'}`
    const message = !n ? 'Imported.' : added === n ? `Imported ${rows(n)}.` : added === 0 ? `Nothing new: ${n === 1 ? 'its row was' : `all ${n} rows were`} already here.` : `Imported ${added} new ${added === 1 ? 'row' : 'rows'} (${n - added} already here).`
    return { documentId: id, name, state: 'imported', message, duplicate: false }
  }

  async function txnCount(connectionId: string): Promise<number> {
    const q = db as unknown as Kysely<{ ledger_records: { connection_id: string; event_type: string } }>
    const r = await q.selectFrom('ledger_records').select((e) => e.fn.countAll().as('n')).where('connection_id', '=', connectionId).where('event_type', '=', 'txn.upsert').executeTakeFirstOrThrow()
    return Number(r.n)
  }

  /** The "Uploaded statements" account counts as cash once any statement gave it a balance. */
  async function countOnceBalanceKnown(connectionId: string): Promise<void> {
    const balance = await db.selectFrom('raw_records').select('id').where('connection_id', '=', connectionId).where('kind', '=', 'files.balance').executeTakeFirst()
    if (!balance) return
    // Only accounts a statement gave a balance: an OFX/camt file names its own account, so the empty placeholder
    // ("Uploaded statements") would otherwise count as cash with no balance (cash unknown).
    const q = db as unknown as Kysely<CoreTables & { ledger_records: { connection_id: string; event_type: string; source_account_id: string | null } }>
    const withBalance = (await q.selectFrom('ledger_records').select('source_account_id').where('connection_id', '=', connectionId).where('event_type', '=', 'balance.snapshot').execute()).map((r) => r.source_account_id).filter((x): x is string => !!x)
    if (!withBalance.length) return
    await db.updateTable('accounts').set({ include_in_cash: 1 }).where('connection_id', '=', connectionId).where('id', 'in', [...new Set(withBalance)]).where('duplicate_of', 'is', null).where('include_in_cash', '=', 0).where('account_type', 'in', ['depository', 'cash_on_hand']).where('closed_at', 'is', null).execute()
  }

  /** Answer "which account is this statement for?" (an account id, or 'new'), then import it. */
  async function chooseAccount(input: { workspaceId: string; documentId: string; accountId: string; personId: string | null }): Promise<UploadOutcome> {
    const d = await db.selectFrom('documents').select(['id', 'entity_id', 'original_name', 'extracted_json', 'record_id']).where('id', '=', input.documentId).where('workspace_id', '=', input.workspaceId).executeTakeFirst()
    if (!d || !d.entity_id) throw new UploadError('That file no longer exists.')
    const waiting = d.extracted_json && (JSON.parse(d.extracted_json) as { status?: string }).status === 'needs_account'
    if (!waiting || d.record_id) throw new UploadError('That statement is already imported.')
    const connectionId = input.accountId === 'new' ? await statementConnection(db, keys, input.workspaceId, d.entity_id, input.personId) : await statementConnectionFor(db, keys, input.workspaceId, input.accountId, input.personId)
    if (!connectionId) throw new UploadError('That account no longer exists. Choose another one.')
    const mapping = (JSON.parse(d.extracted_json ?? '{}') as { mapping?: ColumnMapping }).mapping
    await db.updateTable('documents').set({ record_type: 'connection', record_id: connectionId, extracted_json: mapping ? JSON.stringify({ mapping }) : null }).where('id', '=', d.id).execute()
    // The person explicitly chose "new": the account(s) this import creates are kept separate forever, so a later bank
    // sync never adopts them and hides their balance (adoptStatementAccounts reads these markers). Diff the files
    // connection's accounts across the import to find exactly the ones this statement added.
    const isNew = input.accountId === 'new'
    const before = isNew ? new Set((await db.selectFrom('accounts').select('id').where('connection_id', '=', connectionId).execute()).map((r) => r.id)) : null
    const outcome = await importStatement(d.id, d.original_name ?? 'statement', connectionId)
    if (before) {
      const created = (await db.selectFrom('accounts').select('id').where('connection_id', '=', connectionId).where('duplicate_of', 'is', null).where('closed_at', 'is', null).execute()).filter((a) => !before.has(a.id))
      for (const a of created) await db.insertInto('settings').values({ workspace_id: input.workspaceId, key: keepSeparateKey(a.id), value_json: '{}', updated_at: nowIso() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing()).execute()
    }
    return outcome
  }

  /** The upload queue the files connector reads (S3 connector-files FileSource). */
  const fileSource = {
    async list(connectionId: string, afterCursor: string | null) {
      const ofConnection = () =>
        db
          .selectFrom('documents')
          .select(['id', 'original_name', 'storage_key', 'extracted_json'])
          .where('record_type', '=', 'connection')
          .where('record_id', '=', connectionId)
      let q = ofConnection().orderBy('id').limit(25)
      if (afterCursor) q = q.where('id', '>', afterCursor)
      const rows = await q.execute()
      // Ids are only ordered within one machine: a statement another machine saved at about the same time can sort
      // before the cursor and would never be read. Anything just before the cursor's own upload that has no import
      // report yet comes too (re-reading the files after it is harmless: their rows have stable ids).
      if (afterCursor) {
        const at = await db.selectFrom('documents').select('created_at').where('id', '=', afterCursor).executeTakeFirst()
        if (at) {
          const since = new Date(Date.parse(at.created_at) - LATE_UPLOAD_MS).toISOString()
          const late = (await ofConnection().where('id', '<', afterCursor).where('created_at', '>=', since).orderBy('id').execute()).filter((r) => !reported(r.extracted_json))
          if (late.length) rows.unshift(...late)
        }
      }
      const out: Array<{ fileId: string; filename: string; bytes: Uint8Array; mapping?: ColumnMapping }> = []
      for (const r of rows) {
        const bytes = await store.get(r.storage_key)
        // The columns the person chose for this file ("Which column is the amount?"), until the import report replaces it.
        const mapping = (JSON.parse(r.extracted_json ?? '{}') as { mapping?: unknown }).mapping
        if (bytes) out.push({ fileId: r.id, filename: r.original_name ?? r.id, bytes, ...(isColumnMapping(mapping) ? { mapping } : {}) })
      }
      return out
    },
    /** Rows earlier statements of this connection brought in (so a bank's re-issued FITIDs don't count twice). */
    async priorRows(connectionId: string, accountExternalId: string, from: string, to: string) {
      const q = db as unknown as Kysely<{ ledger_records: { connection_id: string; event_type: string; external_id: string; date: string; status: string; event_json: string } }>
      const rows = await q.selectFrom('ledger_records').select(['external_id', 'status', 'event_json']).where('connection_id', '=', connectionId).where('event_type', '=', 'txn.upsert').where('date', '>=', from).where('date', '<=', to).execute()
      const out: Array<{ externalId: string; date: string; amountMinor: number; text: string }> = []
      for (const r of rows) {
        if (r.status === 'void') continue
        const e = JSON.parse(r.event_json) as { accountExternalId?: string; date: string; amount: { minor: number }; rawText?: string }
        if (e.accountExternalId === accountExternalId) out.push({ externalId: r.external_id, date: e.date, amountMinor: e.amount.minor, text: e.rawText ?? '' })
      }
      return out
    },

    async report(_connectionId: string, fileId: string, outcome: { status: string; result?: { eventCount?: number }; error?: { message: string }; document?: unknown }) {
      const summary =
        outcome.status === 'imported'
          ? { status: 'imported', eventCount: outcome.result?.eventCount ?? 0, result: outcome.result }
          : outcome.status === 'failed'
            ? { status: 'failed', message: outcome.error?.message ?? 'We couldn’t read that file.' }
            : { status: 'document', document: outcome.document }
      // A PDF's text layer (and why its statement did or didn't import) stays with the import report: the AI still
      // reads it, and the "looks like instructions" flag still sees it.
      const prev = await db.selectFrom('documents').select('extracted_json').where('id', '=', fileId).executeTakeFirst()
      const old = prev?.extracted_json ? (JSON.parse(prev.extracted_json) as Record<string, unknown>) : {}
      const kept = Object.fromEntries(['pdf', 'text', 'statement'].filter((k) => k in old).map((k) => [k, old[k]]))
      await db
        .updateTable('documents')
        .set({ status: outcome.status === 'imported' ? 'processed' : 'unread', extracted_json: JSON.stringify({ ...kept, ...summary }) })
        .where('id', '=', fileId)
        .execute()
    },
  }

  async function read(workspaceId: string, documentId: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const d = await db.selectFrom('documents').select(['storage_key', 'mime_type', 'original_name']).where('id', '=', documentId).where('workspace_id', '=', workspaceId).executeTakeFirst()
    if (!d) return null
    const bytes = await store.get(d.storage_key)
    return bytes ? { bytes, mime: d.mime_type, name: d.original_name ?? documentId } : null
  }

  return { upload, chooseAccount, answerMapping, waitingStatements, fileSource, read }
}

/** How long before the cursor's own upload a statement from another machine can still land unread. */
const LATE_UPLOAD_MS = 60_000
/** The files connector already reported on this document (imported, failed, or kept as a document). */
function reported(extractedJson: string | null): boolean {
  if (!extractedJson) return false
  try {
    const s = (JSON.parse(extractedJson) as { status?: unknown }).status
    return s === 'imported' || s === 'failed' || s === 'document'
  } catch {
    return false
  }
}

export class UploadError extends Error {
  /** A machine-readable reason for the client, when there is one ("locked_document"). */
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/** What a PDF's text layer gave, as kept in documents.extracted_json (text for get_document, capped). */
export function pdfExtract(r: PdfText): { pdf: { status: PdfText['status']; pages?: number; truncated?: boolean; reason?: string }; text?: string } {
  if (r.status === 'text') return { pdf: { status: 'text', pages: r.pages, ...(r.truncated ? { truncated: true } : {}) }, text: r.text }
  if (r.status === 'scanned') return { pdf: { status: 'scanned', pages: r.pages } }
  if (r.status === 'unreadable') return { pdf: { status: 'unreadable', reason: r.reason } }
  return { pdf: { status: 'locked' } }
}

export type Documents = ReturnType<typeof createDocuments>
