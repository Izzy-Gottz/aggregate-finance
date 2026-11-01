// What a person reads when a statement file can't be imported: what happened and what to do next, in plain words.
// The parsers' own messages ("CdtDbtInd must be CRDT or DBIT", "no ACCTID") stay in logs and in the AI's warnings;
// this is only the line the upload screen shows (documents.ts reports it as the file's message).

const OR_CSV = 'or upload a CSV export'

/** Plain message for an import failure's code; the line number is kept when the parser gave one. */
export function plainImportError(code: string | undefined, technical: string): string {
  const line = /\bline (\d+)\b/.exec(technical)?.[1]
  const at = line ? ` (around line ${line})` : ''
  switch (code) {
    case 'empty_file':
      return 'This file is empty. Download the statement from your bank again and upload it.'
    case 'file_too_large':
      return 'This file is too large to read. Download a shorter date range and upload that.'
    case 'binary_file':
    case 'unsupported_document':
      return 'This isn’t a file we can read as a statement. Upload a CSV, OFX/QFX, camt.053 or PDF statement from your bank.'
    case 'ofx_no_statement':
      return `This OFX/QFX file has no bank or card statement in it. Download the account’s transactions from your bank again, ${OR_CSV}.`
    case 'ofx_malformed':
    case 'ofx_bad_date':
      return `This OFX/QFX file is damaged or incomplete${at}. Download it from your bank again, ${OR_CSV}.`
    case 'camt_unsupported':
      return `This bank XML file isn’t an account statement. Download the statement export (camt.053) from your bank, ${OR_CSV}.`
    case 'camt_malformed':
    case 'xml_malformed':
    case 'xml_entity':
    case 'xml_doctype':
      return `This bank XML file is damaged or incomplete${at}. Download it from your bank again, ${OR_CSV}.`
    case 'ambiguous_amount':
      return `An amount${at} could be read two ways (like 1.234,56 or 1,234.56), so nothing was imported. Export the file with plain amounts like 1234.56, or ask your AI to read it.`
    case 'csv_unterminated_quote':
      return `This CSV has a broken quote${at}, so its rows can’t be read. Download it from your bank again.`
    case 'needs_mapping':
    case 'mapping_column_missing':
    case 'mapping_mismatch':
      return 'We couldn’t tell which columns are the date, description and amount. Ask your AI to read the file, or upload your bank’s standard CSV export.'
    case 'missing_account':
      return 'This file wasn’t attached to an account. Upload it again from the account it belongs to.'
    default:
      return 'We couldn’t read this file. Upload a CSV or PDF statement from your bank, or ask your AI to read it.'
  }
}
