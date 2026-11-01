// @agfn/equity: the cap table tool (MASTER §2 Equity, §5). Browser-safe math lives in ./math.ts.
export * from './math.ts'
export * from './service.ts'
export { looksLikeXlsx, XlsxError } from './xlsx.ts'
export { importCapTableXlsx, type WorkbookImportResult } from './workbook.ts'
