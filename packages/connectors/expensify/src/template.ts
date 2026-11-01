// The export template (Expensify runs it with FreeMarker over the exported reports). One JSON object per expense per
// line, so no separators are needed between items. Every value is URL-encoded (?url, a built-in in every FreeMarker
// version) and decoded here: merchant names and comments can hold quotes, backslashes and newlines, and Expensify's
// FreeMarker may not have ?json_string. Every field has a default (!), so a field missing on a report or an expense
// gives an empty value instead of failing the whole export. Amounts are integer cents.

const q = (expr: string) => `\${((${expr})!"")?string?url('UTF-8')}`
const n = (expr: string) => `<#if (${expr})?has_content>\${(${expr})?c}</#if>`
const b = (expr: string) => `<#if (${expr})!false>1<#else>0</#if>`

const FIELDS: Array<[keyof ExportRow, string]> = [
  ['r', q('report.reportID')],
  ['rn', q('report.reportName')],
  ['rs', q('report.status')],
  ['rc', q('report.currency')],
  ['re', q('report.accountEmail')],
  ['rp', q('report.policyName')],
  ['t', q('expense.transactionID')],
  ['m', q('expense.merchant')],
  ['mm', q('expense.modifiedMerchant')],
  ['a', n('expense.amount')],
  ['ma', n('expense.modifiedAmount')],
  ['ca', n('expense.convertedAmount')],
  ['c', q('expense.currency')],
  ['d', q('expense.created')],
  ['md', q('expense.modifiedCreated')],
  ['cat', q('expense.category')],
  ['tag', q('expense.tag')],
  ['note', q('expense.comment')],
  ['reim', b('expense.reimbursable')],
  ['card', q('expense.cardID')],
]

export const EXPORT_TEMPLATE =
  '<#list reports as report><#list report.transactionList as expense>{' +
  FIELDS.map(([k, v]) => `"${k}":"${v}"`).join(',') +
  '}\n</#list></#list>'

/** One exported expense line, decoded. */
export type ExportRow = { [K in 'r' | 'rn' | 'rs' | 'rc' | 're' | 'rp' | 't' | 'm' | 'mm' | 'a' | 'ma' | 'ca' | 'c' | 'd' | 'md' | 'cat' | 'tag' | 'note' | 'reim' | 'card']: string }

export function parseExport(text: string): ExportRow[] {
  const out: ExportRow[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    const raw = JSON.parse(s) as Record<string, string>
    const row = {} as ExportRow
    for (const [k] of FIELDS) row[k] = decode(raw[k] ?? '')
    out.push(row)
  }
  return out
}

/** FreeMarker's ?url encodes spaces as %20 (never +), so decodeURIComponent reads it back exactly. */
function decode(v: string): string {
  try {
    return decodeURIComponent(v).trim()
  } catch {
    return v.trim()
  }
}
