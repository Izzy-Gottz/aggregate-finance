// ISO 20022 bank statements: camt.053 (end-of-day statement) and camt.052 (intraday report), any version from 001.02
// on. One file can carry several statements (one per account and currency). Each entry (Ntry) becomes one row:
// booking date, signed amount (CRDT = in, DBIT = out), the bank's reference for dedupe, the other party and the
// remittance text. Booked entries post; pending ones are recorded; information-only ones are left out.

import { createHash } from 'node:crypto'
import type { Money } from '@agfn/contracts'
import { isConnectorError, isoTimestamp, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import type { ClosingBalance, FileAccount, ParsedRow } from './events.ts'
import { invalid } from './text.ts'
import { child, children, parseXml, textAt, type XmlNode } from './xml.ts'

export interface CamtBalance {
  code: string
  amount: Money
  date: string
  at: string
}

export interface CamtStatement {
  /** The statement's own id (Stmt/Id). */
  id?: string
  iban?: string
  /** Non-IBAN account id (Othr/Id), e.g. a US account number. */
  otherId?: string
  currency: string
  accountName?: string
  accountTypeCode?: string
  institution?: string
  balances: CamtBalance[]
  entries: XmlNode[]
  line: number
}

export interface CamtDocument {
  kind: 'camt.053' | 'camt.052'
  statements: CamtStatement[]
  warnings: string[]
}

/** True when the head of a file looks like a camt.052/053 document. */
export function looksLikeCamt(head: string): boolean {
  return /<(\w+:)?Document[\s>]/.test(head) && /camt\.05[23]|BkToCstmr(Stmt|AcctRpt)/.test(head)
}

/** First IBAN or other account id in a camt file (for matching the statement to an account by its last 4). */
export function camtAccountNumber(text: string): string | undefined {
  // Bounded, no nested spaces: the file is the uploader's, and a run of spaces must not stall the server.
  const m = /<(?:\w+:)?IBAN>([^<]{1,64})</.exec(text) ?? /<(?:\w+:)?Othr>[^<]{0,64}<(?:\w+:)?Id>([^<]{1,64})</.exec(text)
  return m?.[1]?.replace(/\s/g, '') || undefined
}

function amountOf(node: XmlNode | undefined, fallbackCurrency: string | undefined, where: string): Money {
  const amt = node && (node.name === 'Amt' ? node : child(node, 'Amt'))
  const raw = amt?.text.trim()
  if (!amt || !raw) throw invalid(`${where}: amount is missing`, 'camt_malformed')
  const currency = normalizeCurrency(amt.attrs.Ccy ?? fallbackCurrency ?? '')
  if (!/^\d+(\.\d+)?$/.test(raw)) throw invalid(`${where}: amount ${JSON.stringify(raw.slice(0, 30))} isn't a plain decimal`, 'ambiguous_amount')
  try {
    return { minor: toMinor(raw, currency), currency }
  } catch (e) {
    if (isConnectorError(e)) throw invalid(`${where}: ${e.message}`, 'ambiguous_amount')
    throw e
  }
}

function signed(m: Money, ind: string | undefined, where: string): Money {
  if (ind === 'CRDT') return m
  if (ind === 'DBIT') return { minor: m.minor === 0 ? 0 : -m.minor, currency: m.currency }
  throw invalid(`${where}: CdtDbtInd must be CRDT or DBIT`, 'camt_malformed')
}

/** <Dt>2026-09-30</Dt> or <DtTm>2026-09-30T23:59:59+02:00</DtTm> under `node`. */
function dateOf(node: XmlNode | undefined): { date: string; at: string } | undefined {
  const d = textAt(node, 'Dt')
  if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) return { date: d.slice(0, 10), at: isoTimestamp(`${d.slice(0, 10)}T12:00:00Z`) }
  const dt = textAt(node, 'DtTm')
  if (dt && /^\d{4}-\d{2}-\d{2}T/.test(dt)) return { date: dt.slice(0, 10), at: isoTimestamp(/[zZ]|[+-]\d\d:?\d\d$/.test(dt) ? dt : `${dt}Z`) }
  return undefined
}

export function parseCamt(text: string): CamtDocument {
  const root = parseXml(text)
  if (root.name !== 'Document') throw invalid('not an ISO 20022 document (no <Document> root)', 'camt_malformed')
  const stmt = child(root, 'BkToCstmrStmt')
  const rpt = child(root, 'BkToCstmrAcctRpt')
  if (!stmt && !rpt) {
    const what = root.children[0]?.name ?? 'nothing'
    throw invalid(`this ISO 20022 file is ${what}, not a bank statement (camt.053) or account report (camt.052)`, 'camt_unsupported')
  }
  const kind = stmt ? 'camt.053' : 'camt.052'
  const warnings: string[] = []
  const statements: CamtStatement[] = []
  for (const s of stmt ? children(stmt, 'Stmt') : children(rpt, 'Rpt')) {
    const acct = child(s, 'Acct')
    const iban = textAt(acct, 'Id/IBAN')?.replace(/\s/g, '').toUpperCase()
    const otherId = textAt(acct, 'Id/Othr/Id')
    if (!iban && !otherId) throw invalid(`line ${s.line}: statement has no account id (IBAN or Othr/Id)`, 'camt_malformed')
    const balNodes = children(s, 'Bal')
    const entries = children(s, 'Ntry')
    const ccy = textAt(acct, 'Ccy') ?? child(balNodes[0], 'Amt')?.attrs.Ccy ?? child(entries[0], 'Amt')?.attrs.Ccy
    if (!ccy) throw invalid(`line ${s.line}: statement doesn't say its currency`, 'camt_malformed')
    const currency = normalizeCurrency(ccy)
    const balances: CamtBalance[] = []
    for (const b of balNodes) {
      const code = textAt(b, 'Tp/CdOrPrtry/Cd') ?? textAt(b, 'Tp/CdOrPrtry/Prtry') ?? ''
      const when = dateOf(child(b, 'Dt'))
      if (!when) {
        warnings.push(`line ${b.line}: balance ${code} has no date; left out`)
        continue
      }
      balances.push({ code, amount: signed(amountOf(b, currency, `line ${b.line}`), textAt(b, 'CdtDbtInd'), `line ${b.line}`), ...when })
    }
    const institution = textAt(acct, 'Svcr/FinInstnId/Nm') ?? textAt(acct, 'Svcr/FinInstnId/BICFI') ?? textAt(acct, 'Svcr/FinInstnId/BIC')
    const accountName = textAt(acct, 'Nm')
    const accountTypeCode = textAt(acct, 'Tp/Cd')
    const id = textAt(s, 'Id')
    statements.push({
      ...(id ? { id } : {}),
      ...(iban ? { iban } : {}),
      ...(otherId ? { otherId } : {}),
      currency,
      ...(accountName ? { accountName } : {}),
      ...(accountTypeCode ? { accountTypeCode } : {}),
      ...(institution ? { institution } : {}),
      balances,
      entries,
      line: s.line,
    })
  }
  if (!statements.length) throw invalid('the file has no statements', 'empty_file')
  return { kind, statements, warnings }
}

/** Stable account id: sha256 of the account number and currency, so the full number is never stored in an id. */
export function camtAccountExternalId(st: Pick<CamtStatement, 'iban' | 'otherId' | 'currency'>): string {
  const h = createHash('sha256').update(`camt|${st.iban ?? st.otherId ?? ''}|${st.currency}`).digest('hex')
  return `camt_${h.slice(0, 24)}`
}

const TYPE_LABEL: Record<string, string> = { CACC: 'Current account', SVGS: 'Savings', CARD: 'Card account', LOAN: 'Loan', MOMA: 'Money market', CASH: 'Cash account' }
const NOT_PROVIDED = /^not\s?provided$/i

function party(tx: XmlNode | undefined, role: 'Dbtr' | 'Cdtr'): string | undefined {
  const p = child(tx, 'RltdPties')
  return textAt(p, `${role}/Nm`) ?? textAt(p, `${role}/Pty/Nm`) ?? textAt(p, `Ultmt${role}/Nm`) ?? textAt(p, `Ultmt${role}/Pty/Nm`)
}

export interface CamtStatementRows {
  account: FileAccount
  rows: ParsedRow[]
  opening?: Money
  closing?: ClosingBalance
  warnings: string[]
}

export function camtStatementRows(doc: CamtDocument, st: CamtStatement, opts: { sameNumberCount?: number } = {}): CamtStatementRows {
  const warnings: string[] = []
  const number = st.iban ?? st.otherId ?? ''
  const mask = number.replace(/[^0-9A-Za-z]/g, '').slice(-4)
  const label = st.accountName ?? TYPE_LABEL[st.accountTypeCode ?? ''] ?? 'Account'
  const multi = (opts.sameNumberCount ?? 1) > 1
  const account: FileAccount = {
    externalId: camtAccountExternalId(st),
    name: `${st.institution ? st.institution + ' ' : ''}${label} ••${mask}${multi ? ` (${st.currency})` : ''}`,
    accountType: st.accountTypeCode === 'LOAN' ? 'loan' : 'depository',
    currency: st.currency,
    mask,
    ...(st.institution ? { institution: st.institution } : {}),
    source: { format: doc.kind, statementId: st.id ?? null, mask, currency: st.currency, institution: st.institution ?? null, typeCode: st.accountTypeCode ?? null, balances: st.balances },
  }

  const rows: ParsedRow[] = []
  for (const n of st.entries) {
    const where = `line ${n.line}`
    const status = textAt(n, 'Sts/Cd') ?? textAt(n, 'Sts/Prtry') ?? textAt(n, 'Sts')
    if (status !== 'BOOK' && status !== 'PDNG') {
      if (status !== 'INFO' && status !== 'FUTR') warnings.push(`${where}: entry status ${JSON.stringify(status ?? '')} isn't booked or pending; left out`)
      continue
    }
    const amount = signed(amountOf(n, st.currency, where), textAt(n, 'CdtDbtInd'), where)
    if (amount.currency !== st.currency) warnings.push(`${where}: amount is in ${amount.currency}, not the account currency ${st.currency}`)
    const when = dateOf(child(n, 'BookgDt')) ?? dateOf(child(n, 'ValDt'))
    if (!when) throw invalid(`${where}: entry has no booking or value date`, 'camt_malformed')
    const txs = children(child(n, 'NtryDtls'), 'TxDtls')
    const only = txs.length === 1 ? txs[0] : undefined
    const credit = amount.minor >= 0
    const counterparty = only ? party(only, credit ? 'Dbtr' : 'Cdtr') : undefined
    const remit = (only ? children(child(only, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()) : []).filter(Boolean).join(' ')
    const description = remit || textAt(n, 'AddtlNtryInf') || textAt(only, 'AddtlTxInf') || (txs.length > 1 ? `${txs.length} payments` : undefined)
    const e2e = textAt(only, 'Refs/EndToEndId')
    const svcr = textAt(n, 'AcctSvcrRef') ?? textAt(only, 'Refs/AcctSvcrRef')
    const txId = textAt(only, 'Refs/TxId')
    // The bank's own reference is unique per account; an end-to-end id is the payer's, so it's qualified.
    const ref = svcr && !NOT_PROVIDED.test(svcr) ? svcr : e2e && !NOT_PROVIDED.test(e2e) ? `e2e:${e2e}:${when.date}:${amount.minor}` : txId && !NOT_PROVIDED.test(txId) ? `tx:${txId}` : undefined
    const linkRefs: Record<string, string> = {}
    if (e2e && !NOT_PROVIDED.test(e2e)) linkRefs.end_to_end_id = e2e
    const mandate = textAt(only, 'Refs/MndtId')
    if (mandate) linkRefs.mandate_id = mandate
    const cheque = textAt(only, 'Refs/ChqNb')
    if (cheque) linkRefs.check_number = cheque
    const bt = child(n, 'BkTxCd/Domn')
    const code = bt ? [textAt(bt, 'Cd'), textAt(bt, 'Fmly/Cd'), textAt(bt, 'Fmly/SubFmlyCd')].filter(Boolean).join('-') : textAt(n, 'BkTxCd/Prtry/Cd')
    rows.push({
      line: n.line,
      kind: 'txn',
      date: when.date,
      amount,
      status: status === 'BOOK' ? 'posted' : 'pending',
      ...(description ? { description } : {}),
      ...(counterparty ? { counterparty } : {}),
      ...(code ? { category: `camt:${code.toLowerCase()}` } : {}),
      ...(ref ? { ref } : {}),
      ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
      cells: { status, amount: amount.minor, currency: amount.currency, date: when.date, ref: ref ?? null, counterparty: counterparty ?? null, text: description ?? null, code: code ?? null, reversal: textAt(n, 'RvslInd') === 'true' },
    })
  }

  // Opening: OPBD (or the previous closing, PRCD); closing: CLBD, with CLAV as available. 052 reports: interim ITBD.
  const pick = (...codes: string[]) => {
    for (const c of codes) {
      const hits = st.balances.filter((b) => b.code === c)
      if (hits.length) return c.startsWith('OP') || c === 'PRCD' ? hits[0] : hits[hits.length - 1]
    }
    return undefined
  }
  const open = pick('OPBD', 'PRCD')
  const close = pick('CLBD', 'ITBD')
  const avail = pick('CLAV', 'ITAV')
  const closing: ClosingBalance | undefined = close ? { current: close.amount, at: close.at, date: close.date, ...(avail ? { available: avail.amount } : {}) } : undefined
  return { account, rows, ...(open ? { opening: open.amount } : {}), ...(closing ? { closing } : {}), warnings }
}
