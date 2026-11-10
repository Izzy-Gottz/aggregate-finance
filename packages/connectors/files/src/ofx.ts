// OFX statements: 1.x (SGML, leaf tags usually unclosed), 2.x (XML), QFX (OFX + Intuit <INTU.BID>) and QBO.
// We read bank statements (BANKMSGSRSV1/STMTTRNRS/STMTRS) and card statements (CREDITCARDMSGSRSV1/CCSTMTTRNRS/CCSTMTRS).
//
// Sign: per OFX spec §3.2.9.2 amounts are signed from the customer's perspective, and STMTTRN amounts by their effect
// on the account: + increases the balance (deposit, card payment/refund), − decreases it (debit, card purchase).
// TRNTYPE never changes the direction. That's already our sign rule (+ = money in), so TRNAMT passes through as is,
// for cards too: a purchase is negative and a card balance owed (LEDGERBAL) is negative. Some banks violate this;
// `invertSign` exists for them and is never applied automatically.
//
// Amounts: the spec allows '.' or ',' as the decimal point and no thousands separators, so a comma-only amount
// is read as comma-decimal (that's the spec, not a guess). Anything else malformed throws.

import { createHash } from 'node:crypto'
import type { AccountType, Money } from '@agfn/contracts'
import { isConnectorError, isoTimestamp, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import type { ClosingBalance, FileAccount, ParsedRow } from './events.ts'
import { invalid } from './text.ts'

// ---------- Tree ----------

export interface OfxNode {
  name: string
  value?: string
  children: OfxNode[]
  line: number
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

const AGGREGATES = new Set(['OFX', 'SONRS', 'STATUS', 'FI', 'STMTTRN', 'LEDGERBAL', 'AVAILBAL', 'PAYEE', 'CURRENCY',
  'ORIGCURRENCY', 'BAL', 'MKTGINFO', 'SECLIST', 'STMTENDRS', 'CCSTMTENDRS', 'CLOSING', 'INVPOS', 'INVTRAN'])
const isAggregate = (name: string) =>
  AGGREGATES.has(name) || /(MSGSRSV\d|MSGSRQV\d|TRNRS|TRNRQ|RS|RQ|LIST|ACCTFROM|ACCTTO|INFO)$/.test(name)

/** Parse the OFX body (SGML or XML) into a tree. Unclosed leaf tags (`<TRNAMT>-12.00`) close at the next tag. */
interface OfxToken { index: number; cdata?: string; slash?: string; rawName?: string; selfClose?: string; chars?: string }

/**
 * Walks instructions, comments, CDATA, tags and text. Hand-written so an upload full of unclosed `<?` or `<!--` stays
 * linear: a closer's position is remembered, so no stretch of the file is searched twice. A `<` that opens nothing is skipped.
 */
function* ofxTokens(text: string): Generator<OfxToken> {
  const seen = new Map<string, number>()
  const closeAt = (closer: string, from: number) => {
    const known = seen.get(closer)
    if (known === -1 || (known !== undefined && known >= from)) return known!
    const at = text.indexOf(closer, from)
    seen.set(closer, at)
    return at
  }
  const tag = /<(\/?)([A-Za-z0-9._]+)[^>]*?(\/?)>/y
  let i = 0
  while (i < text.length) {
    if (text[i] !== '<') {
      const next = text.indexOf('<', i)
      const end = next < 0 ? text.length : next
      yield { index: i, chars: text.slice(i, end) }
      i = end
      continue
    }
    const skipped = text.startsWith('<?', i) ? ['?>', 2] as const : text.startsWith('<!--', i) ? ['-->', 4] as const : null
    if (skipped) {
      const end = closeAt(skipped[0], i + skipped[1])
      if (end >= 0) { yield { index: i }; i = end + skipped[0].length; continue }
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = closeAt(']]>', i + 9)
      if (end >= 0) { yield { index: i, cdata: text.slice(i + 9, end) }; i = end + 3; continue }
    } else if (closeAt('>', i) >= 0) {
      tag.lastIndex = i
      const m = tag.exec(text)
      if (m) { yield { index: i, slash: m[1]!, rawName: m[2]!, selfClose: m[3]! }; i = tag.lastIndex; continue }
    }
    i++
  }
}

export function parseOfxTree(text: string): OfxNode {
  const root: OfxNode = { name: '#root', children: [], line: 1 }
  const stack: OfxNode[] = [root]
  const top = () => stack[stack.length - 1] as OfxNode
  let line = 1
  let last = 0
  for (const m of ofxTokens(text)) {
    for (let i = last; i < m.index; i++) if (text.charCodeAt(i) === 10) line++
    last = m.index
    const { cdata, slash, rawName, selfClose, chars } = m
    const textValue = cdata ?? (chars !== undefined ? decodeEntities(chars) : undefined)
    if (textValue !== undefined) {
      const v = textValue.trim()
      if (v && stack.length > 1) {
        const t = top()
        t.value = (t.value ?? '') + v
      }
      continue
    }
    if (!rawName) continue
    const name = rawName.toUpperCase()
    if (slash) {
      if (top().value !== undefined && top().name !== name && stack.length > 1) stack.pop()
      const at = stack.map((n) => n.name).lastIndexOf(name)
      if (at > 0) stack.length = at
      continue
    }
    // A leaf with a value, or an empty SGML leaf (`<MEMO>` straight before the next tag), closes here.
    if (stack.length > 1 && (top().value !== undefined || (!top().children.length && !isAggregate(top().name)))) stack.pop()
    const node: OfxNode = { name, children: [], line }
    top().children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root
}

const child = (n: OfxNode | undefined, name: string) => n?.children.find((c) => c.name === name)
const val = (n: OfxNode | undefined, name: string) => child(n, name)?.value
function* descendants(n: OfxNode, name: string): Generator<OfxNode> {
  for (const c of n.children) {
    if (c.name === name) yield c
    else yield* descendants(c, name)
  }
}

// ---------- Document ----------

export interface OfxTransaction {
  line: number
  trnType?: string
  posted: string
  amount: string
  fitId?: string
  name?: string
  memo?: string
  checkNum?: string
  refNum?: string
  /** <CURRENCY><CURSYM>: the amount is in this currency instead of CURDEF. */
  currency?: string
  correctFitId?: string
  correctAction?: string
  /** Every leaf field of the STMTTRN, verbatim (raw capture). */
  fields: Record<string, string>
}

export interface OfxBalance {
  amount: string
  asOf?: string
}

export interface OfxStatement {
  kind: 'bank' | 'creditcard'
  line: number
  currency: string
  bankId?: string
  branchId?: string
  accountId: string
  accountType?: string
  start?: string
  end?: string
  transactions: OfxTransaction[]
  ledger?: OfxBalance
  available?: OfxBalance
}

export interface OfxDocument {
  version: 1 | 2
  header: Record<string, string>
  institution?: string
  /** QFX/QBO: Intuit bank id. */
  intuBid?: string
  statements: OfxStatement[]
  warnings: string[]
}

/** True when text looks like OFX/QFX/QBO. */
export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096)
  return /OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(head)
}

/** Declared charset of an OFX 1.x header or 2.x XML prolog. */
export function ofxDeclaredCharset(asciiHead: string): 'windows-1252' | 'utf-8' | undefined {
  const charset = /CHARSET:\s*([^\s]+)/i.exec(asciiHead)?.[1] ?? /encoding="([^"]+)"/i.exec(asciiHead)?.[1]
  if (!charset) return undefined
  if (/^(1252|windows-1252|iso-8859-1|latin-?1|8859-1)$/i.test(charset)) return 'windows-1252'
  if (/utf-?8/i.test(charset)) return 'utf-8'
  return undefined
}

function leafFields(n: OfxNode, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of n.children) {
    if (c.value !== undefined) out[prefix + c.name] = c.value
    if (c.children.length) Object.assign(out, leafFields(c, prefix + c.name + '.'))
  }
  return out
}

export function parseOfx(text: string): OfxDocument {
  const start = text.search(/<OFX>/i)
  if (start < 0) throw invalid('not an OFX file: no <OFX> element', 'ofx_malformed')
  const headText = text.slice(0, start)
  const header: Record<string, string> = {}
  for (const m of headText.matchAll(/^\s*([A-Z]+):(.*)$/gm)) header[(m[1] as string).toUpperCase()] = (m[2] as string).trim()
  for (const m of headText.matchAll(/([A-Z]+)="([^"]*)"/g)) header[(m[1] as string).toUpperCase()] = m[2] as string
  const version: 1 | 2 = /<\?xml|OFXHEADER="?2/i.test(headText) || header.OFXHEADER === '200' ? 2 : 1

  // Parse from the start so line numbers match the file.
  const tree = parseOfxTree(text)
  const ofx = child(tree, 'OFX') ?? [...descendants(tree, 'OFX')][0]
  if (!ofx) throw invalid('not an OFX file: <OFX> element is empty', 'ofx_malformed')
  const warnings: string[] = []
  const sonrs = child(child(ofx, 'SIGNONMSGSRSV1'), 'SONRS')
  const institution = val(child(sonrs, 'FI'), 'ORG')
  const intuBid = val(sonrs, 'INTU.BID')

  const statements: OfxStatement[] = []
  const readStatement = (rs: OfxNode, kind: OfxStatement['kind']) => {
    const from = kind === 'bank' ? child(rs, 'BANKACCTFROM') : child(rs, 'CCACCTFROM')
    const accountId = val(from, 'ACCTID')
    if (!accountId) throw invalid(`OFX statement on line ${rs.line} has no ACCTID`, 'ofx_malformed')
    const list = child(rs, 'BANKTRANLIST')
    const transactions: OfxTransaction[] = []
    for (const t of list?.children.filter((c) => c.name === 'STMTTRN') ?? []) {
      const posted = val(t, 'DTPOSTED')
      const amount = val(t, 'TRNAMT')
      if (!posted || !amount) {
        warnings.push(`line ${t.line}: STMTTRN without DTPOSTED or TRNAMT skipped`)
        continue
      }
      const opt = (k: string, v: string | undefined) => (v ? { [k]: v } : {})
      transactions.push({
        line: t.line,
        posted,
        amount,
        ...opt('trnType', val(t, 'TRNTYPE')?.toUpperCase()),
        ...opt('fitId', val(t, 'FITID')),
        ...opt('name', val(t, 'NAME') ?? val(child(t, 'PAYEE'), 'NAME')),
        ...opt('memo', val(t, 'MEMO')),
        ...opt('checkNum', val(t, 'CHECKNUM')),
        ...opt('refNum', val(t, 'REFNUM')),
        ...opt('currency', val(child(t, 'CURRENCY'), 'CURSYM')),
        ...opt('correctFitId', val(t, 'CORRECTFITID')),
        ...opt('correctAction', val(t, 'CORRECTACTION')?.toUpperCase()),
        fields: leafFields(t),
      })
    }
    const bal = (name: string): OfxBalance | undefined => {
      const b = child(rs, name)
      const amount = val(b, 'BALAMT')
      if (!amount) return undefined
      const asOf = val(b, 'DTASOF')
      return asOf ? { amount, asOf } : { amount }
    }
    const opt = (k: string, v: string | undefined) => (v ? { [k]: v } : {})
    const ledger = bal('LEDGERBAL')
    const available = bal('AVAILBAL')
    statements.push({
      kind,
      line: rs.line,
      currency: normalizeCurrency(val(rs, 'CURDEF'), 'USD'),
      accountId,
      ...opt('bankId', val(from, 'BANKID')),
      ...opt('branchId', val(from, 'BRANCHID')),
      ...opt('accountType', val(from, 'ACCTTYPE')?.toUpperCase()),
      ...opt('start', val(list, 'DTSTART')),
      ...opt('end', val(list, 'DTEND')),
      transactions,
      ...(ledger ? { ledger } : {}),
      ...(available ? { available } : {}),
    })
    if (!val(rs, 'CURDEF')) warnings.push(`statement on line ${rs.line} has no CURDEF; assuming USD`)
  }
  for (const rs of descendants(ofx, 'STMTRS')) readStatement(rs, 'bank')
  for (const rs of descendants(ofx, 'CCSTMTRS')) readStatement(rs, 'creditcard')
  if (child(ofx, 'INVSTMTMSGSRSV1')) warnings.push('investment statements (INVSTMTMSGSRSV1) are not imported')
  if (!statements.length) throw invalid('OFX file has no bank or credit card statement', 'ofx_no_statement')
  return {
    version,
    header,
    ...(institution ? { institution } : {}),
    ...(intuBid ? { intuBid } : {}),
    statements,
    warnings,
  }
}

// ---------- Values ----------

export interface OfxDateTime {
  /** YYYY-MM-DD as written (the bank's local date). */
  date: string
  /** UTC ISO timestamp (GMT when the file gives no offset, per spec). */
  at: string
}

/** "20260131120000.000[-5:EST]" → {date: '2026-01-31', at: '2026-01-31T17:00:00.000Z'}. */
export function parseOfxDate(s: string): OfxDateTime {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.(\d{1,3}))?)?\s*(?:\[\s*([+-]?)(\d{1,2})(?:[.:](\d{1,2}))?(?::[^\]]*)?\])?/.exec(s.trim())
  if (!m) throw invalid(`bad OFX date ${JSON.stringify(s.slice(0, 30))}`, 'ofx_bad_date')
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', , sign, oh, om] = m
  const date = `${y}-${mo}-${d}`
  let offset = 'Z'
  if (oh !== undefined) {
    const minutes = om === undefined ? 0 : om.length === 1 ? Number(om) * 6 : Number(om)
    offset = `${sign === '-' ? '-' : '+'}${oh.padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }
  // A date with no time is the bank's calendar day: midday UTC keeps that day in every workspace zone from −12 to +11
  // (midnight GMT, the spec's reading, is the evening before in the Americas and moved month-end balances a day back).
  const at = m[4] === undefined && oh === undefined ? isoTimestamp(`${date}T12:00:00Z`) : isoTimestamp(`${date}T${hh}:${mi}:${ss}${offset}`)
  return { date, at }
}

export function ofxAmount(s: string, currency: string): number {
  const v = s.trim()
  try {
    if (v.includes(',') && v.includes('.')) throw invalid(`ambiguous OFX amount ${JSON.stringify(v.slice(0, 30))}`, 'ambiguous_amount')
    return toMinor(v, currency, v.includes(',') ? { decimal: ',' } : {})
  } catch (e) {
    if (isConnectorError(e)) throw invalid(`OFX amount: ${e.message}`, 'ambiguous_amount')
    throw e
  }
}

// ---------- To rows ----------

const ACCOUNT_TYPES: Record<string, [AccountType, string]> = {
  CHECKING: ['depository', 'Checking'],
  SAVINGS: ['depository', 'Savings'],
  MONEYMRKT: ['depository', 'Money market'],
  CD: ['depository', 'CD'],
  CREDITLINE: ['loan', 'Credit line'],
}

/** Last four letters/digits of an account id, for display. */
export function maskAccountId(id: string): string {
  return id.replace(/[^0-9A-Za-z]/g, '').slice(-4)
}

/** Stable account id: sha256 of BANKID + ACCTID, so the full number is never stored in an id. */
export function ofxAccountExternalId(st: Pick<OfxStatement, 'bankId' | 'accountId' | 'kind'>): string {
  const h = createHash('sha256').update(`${st.kind}|${st.bankId ?? ''}|${st.accountId.trim()}`).digest('hex')
  return `ofx_${h.slice(0, 24)}`
}

export interface OfxStatementRows {
  account: FileAccount
  rows: ParsedRow[]
  closing?: ClosingBalance
  warnings: string[]
}

const GENERIC_TYPES = new Set(['DEBIT', 'CREDIT', 'OTHER'])

export function ofxStatementRows(doc: OfxDocument, st: OfxStatement, opts: { invertSign?: boolean } = {}): OfxStatementRows {
  const warnings: string[] = []
  const sign = opts.invertSign ? -1 : 1
  const mask = maskAccountId(st.accountId)
  const [accountType, label] = st.kind === 'creditcard' ? (['credit_card', 'Credit card'] as const) : ACCOUNT_TYPES[st.accountType ?? ''] ?? (['depository', 'Account'] as const)
  const account: FileAccount = {
    externalId: ofxAccountExternalId(st),
    name: `${doc.institution ? doc.institution + ' ' : ''}${label} ••${mask}`,
    accountType,
    currency: st.currency,
    mask,
    ...(doc.institution ? { institution: doc.institution } : {}),
    source: {
      kind: st.kind,
      accountType: st.accountType ?? null,
      mask,
      currency: st.currency,
      institution: doc.institution ?? null,
      start: st.start ?? null,
      end: st.end ?? null,
      ledger: st.ledger ?? null,
      available: st.available ?? null,
    },
  }

  const rows: ParsedRow[] = []
  for (const t of st.transactions) {
    const currency = t.currency ? normalizeCurrency(t.currency, st.currency) : st.currency
    if (currency !== st.currency) warnings.push(`line ${t.line}: amount is in ${currency}, not the account currency ${st.currency}`)
    const minor = sign * ofxAmount(t.amount, currency)
    const amount: Money = { minor: minor === 0 ? 0 : minor, currency }
    const { date } = parseOfxDate(t.posted)
    const linkRefs: Record<string, string> = {}
    if (t.checkNum) linkRefs.check_number = t.checkNum
    if (t.refNum) linkRefs.ref = t.refNum
    const rawText = [t.name, t.memo].filter(Boolean).join(' ') || undefined
    const voids = t.correctFitId && (t.correctAction === 'DELETE' || t.correctAction === 'REPLACE') ? t.correctFitId : undefined
    rows.push({
      line: t.line,
      kind: t.correctAction === 'DELETE' && voids ? 'void_only' : 'txn',
      date,
      amount,
      status: 'posted',
      ...(rawText ? { description: rawText } : {}),
      ...(t.name ? { counterparty: t.name } : {}),
      ...(t.trnType && !GENERIC_TYPES.has(t.trnType) ? { category: `ofx:${t.trnType.toLowerCase()}` } : {}),
      ...(t.fitId ? { ref: t.fitId } : {}),
      ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
      ...(voids ? { voids } : {}),
      cells: t.fields,
    })
  }

  let closing: ClosingBalance | undefined
  if (st.ledger) {
    const when = parseOfxDate(st.ledger.asOf ?? st.end ?? rows[rows.length - 1]?.date.replace(/-/g, '') ?? '')
    const current: Money = { minor: sign * ofxAmount(st.ledger.amount, st.currency) || 0, currency: st.currency }
    const available = st.available ? { minor: sign * ofxAmount(st.available.amount, st.currency) || 0, currency: st.currency } : undefined
    closing = { current, at: when.at, date: when.date, ...(available ? { available } : {}) }
  }
  return { account, rows, ...(closing ? { closing } : {}), warnings }
}
