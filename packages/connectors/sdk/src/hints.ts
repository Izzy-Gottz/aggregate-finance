// Category hints from a bank's own words, for sources that send no categories (SimpleFIN, statement files). Only
// phrases that mean one thing; anything else stays unhinted. The ledger reads these like a provider's category
// (core posting.ts), and every result stays editable.

const INFLOW: Array<[RegExp, string]> = [
  // "INTRST PYMNT", "INTEREST PAYMENT", "INTEREST EARNED", or just "INTEREST".
  [/\b(intrst|interest)\s*(pymnt|pmt|payment|paid|earned|credit|cr)\b|^\s*interest\s*$/i, 'INCOME_INTEREST_EARNED'],
  [/\bdividends?\b/i, 'INCOME_DIVIDENDS'],
  // A paycheck: "PAYROLL", "DIRECT DEP", "DIR DEP", "SALARY", "PAYDAY".
  [/\b(payroll|direct\s*dep(osit)?|dir\s*dep|salary|pay\s*day|paycheck)\b/i, 'INCOME_WAGES'],
]

const OUTFLOW: Array<[RegExp, string]> = [
  [/\b(service\s*charge|(monthly\s*)?(maintenance|service)\s*fee|overdraft(\s*fee)?|nsf\s*fee|wire\s*(transfer\s*)?fee|atm\s*fee|foreign\s*transaction\s*fee)\b/i, 'BANK_FEES'],
]

/** A category hint for a transaction from its description, or undefined when the words don't settle it. */
export function textCategoryHint(text: string | undefined, inflow: boolean): string | undefined {
  if (!text) return undefined
  for (const [re, hint] of inflow ? INFLOW : OUTFLOW) if (re.test(text)) return hint
  return undefined
}
