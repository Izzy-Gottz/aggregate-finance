// @agfn/connector-files: bank and card statement files (CSV, OFX/QFX/QBO, camt.053) → NormalizedEvents; PDFs and images
// are validated and handed back as documents for the person's AI to read (a PDF with its text layer, read in a
// capped worker: pdf/extract.ts). Deterministic: no AI, no network.

export * from './connector.ts'
export * from './csv.ts'
export * from './dates.ts'
export * from './document.ts'
export * from './events.ts'
export * from './import.ts'
export * from './ofx.ts'
export { decodeText, normalizeLabel, type DecodedText } from './text.ts'
export * from './camt.ts'
export * from './xml.ts'
export * from './presets.ts'
export * from './question.ts'
export { extractPdfText, PDF_LIMITS, type PdfText } from './pdf/extract.ts'
export type { PdfLine, PdfCell } from './pdf/lines.ts'
export { parsePdfStatement, detectLayout, type PdfStatement, type PdfStatementResult } from './pdf/statement.ts'
export { PDF_LAYOUTS, type PdfLayout } from './pdf/layouts.ts'
