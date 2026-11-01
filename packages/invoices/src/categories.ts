// Map a provider's chart-of-accounts name to a Aggregate ledger system role (meridn-c6's SystemRole keys).
// Deterministic keyword rules; unknown names fall back to the generic role for the classification.

export type IncomeRole = 'revenue' | 'interest_income' | 'other_income' | 'refunds'
export type ExpenseRole =
  | 'cogs'
  | 'payroll_expense'
  | 'payroll_taxes'
  | 'payroll_benefits'
  | 'contractors'
  | 'processor_fees'
  | 'bank_fees'
  | 'software'
  | 'cloud'
  | 'marketing'
  | 'travel'
  | 'meals'
  | 'rent'
  | 'professional_fees'
  | 'insurance'
  | 'taxes'
  | 'bad_debt'
  | 'uncategorized_expense'
  | 'other_expense'

const EXPENSE_RULES: Array<[RegExp, ExpenseRole]> = [
  [/\b(cost of (goods|sales|revenue)|cogs|merchandise|inventory|materials|freight in)\b/i, 'cogs'],
  [/\bpayroll tax|employer tax|futa|suta|fica\b/i, 'payroll_taxes'],
  [/\b(benefit|health insurance|401\s?k|pension|superannuation|retirement)\b/i, 'payroll_benefits'],
  [/\b(salar|wage|payroll|compensation|bonus)/i, 'payroll_expense'],
  [/\b(contractor|subcontract|freelanc|outside services|consult)/i, 'contractors'],
  [/\b(merchant|stripe|paypal|processing|processor) (fee|charge)s?\b|\bpayment processing\b/i, 'processor_fees'],
  [/\bbank (fee|charge|service)s?\b|\bservice charges?\b/i, 'bank_fees'],
  [/\b(aws|amazon web|gcp|google cloud|azure|hosting|cloud|server|infrastructure|data center)\b/i, 'cloud'],
  [/\b(software|saas|subscriptions?|computer|it services|dues and subscriptions)\b/i, 'software'],
  [/\b(marketing|advertis|promotion|ads)\b/i, 'marketing'],
  [/\b(travel|airfare|lodging|hotel|mileage|auto|vehicle|parking)\b/i, 'travel'],
  [/\b(meal|entertainment|food)\b/i, 'meals'],
  [/\b(rent|lease|office space|coworking|occupancy)\b/i, 'rent'],
  [/\b(legal|accounting|professional|bookkeeping|audit)\b/i, 'professional_fees'],
  [/\binsurance\b/i, 'insurance'],
  [/\b(tax|taxes|licen[cs]es? and fees)\b/i, 'taxes'],
  [/\b(bad debt|doubtful)\b/i, 'bad_debt'],
]

export function expenseRoleFor(accountName: string | undefined): ExpenseRole {
  if (!accountName) return 'uncategorized_expense'
  for (const [re, role] of EXPENSE_RULES) if (re.test(accountName)) return role
  if (/\b(uncategori[sz]ed|ask my accountant|suspense)\b/i.test(accountName)) return 'uncategorized_expense'
  return 'other_expense'
}

export function incomeRoleFor(accountName: string | undefined): IncomeRole {
  if (!accountName) return 'revenue'
  if (/\binterest\b/i.test(accountName)) return 'interest_income'
  if (/\b(refund|returns? and allowances|discount)/i.test(accountName)) return 'refunds'
  if (/\b(other income|gain|miscellaneous income)\b/i.test(accountName)) return 'other_income'
  return 'revenue'
}
