// Chart of accounts: the default template every entity gets, and the stable role keys other slices post against.
import type { AccountType } from '@agfn/contracts'

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

/** Fixed (one per entity) role keys. Parameterized roles are built with the helpers below. */
export const FIXED_ROLES = [
  // assets
  'cash_on_hand', 'ar', 'vat_receivable', 'clearing_payouts', 'clearing_transfers', 'clearing_equity', 'clearing_investments',
  'clearing_unmatched_receipts', 'prepaid', 'inventory', 'fixed_assets', 'other_assets',
  // liabilities
  'ap', 'payroll_liabilities', 'sales_tax_payable', 'deferred_revenue', 'customer_deposits', 'other_liabilities', 'suspense',
  // equity
  'opening_balance_equity', 'paid_in_capital', 'safes', 'convertible_notes', 'owner_contributions',
  'owner_money_unspecified', 'owner_draws', 'retained_earnings',
  // income
  'revenue', 'refunds', 'interest_income', 'wages_income', 'other_income', 'fx_gain_loss', 'investment_gains',
  // expenses
  'cogs', 'payroll_expense', 'payroll_taxes', 'payroll_benefits', 'contractors', 'processor_fees', 'bank_fees',
  'software', 'cloud', 'marketing', 'travel', 'meals', 'groceries', 'shopping', 'entertainment', 'rent', 'utilities', 'housing', 'professional_fees', 'insurance', 'taxes', 'bad_debt',
  'investment_writeoffs', 'uncategorized_expense', 'other_expense',
] as const

export type FixedRole = (typeof FIXED_ROLES)[number]

/** Parameterized roles: one ledger account per source account or per counterpart entity. */
export type ParamRole =
  | `cash:${string}`
  | `processor:${string}`
  | `card:${string}`
  | `loan:${string}`
  | `due_from:${string}`
  | `due_to:${string}`
  | `owner_payable:${string}`
  | `investment:${string}`

export type SystemRole = FixedRole | ParamRole

export const EXPENSE_ROLES = [
  'cogs', 'payroll_expense', 'payroll_taxes', 'payroll_benefits', 'contractors', 'processor_fees', 'bank_fees',
  'software', 'cloud', 'marketing', 'travel', 'meals', 'groceries', 'shopping', 'entertainment', 'rent', 'utilities', 'housing', 'professional_fees', 'insurance', 'taxes', 'bad_debt',
  'investment_writeoffs', 'uncategorized_expense', 'other_expense',
] as const satisfies readonly FixedRole[]
export type ExpenseRole = (typeof EXPENSE_ROLES)[number]

export const INCOME_ROLES = ['revenue', 'refunds', 'interest_income', 'wages_income', 'other_income', 'fx_gain_loss', 'investment_gains'] as const satisfies readonly FixedRole[]
export type IncomeRole = (typeof INCOME_ROLES)[number]

export const PAYROLL_ROLES = ['payroll_expense', 'payroll_taxes', 'payroll_benefits', 'contractors'] as const satisfies readonly ExpenseRole[]

/** Balance-sheet roles a bill or purchase line may name (inventory bought, equipment, a prepayment, a loan paid down, sales tax paid). */
export const BILL_BALANCE_SHEET_ROLES: readonly string[] = ['inventory', 'fixed_assets', 'prepaid', 'other_assets', 'other_liabilities', 'sales_tax_payable']

/** Expense roles that are not cash spending (excluded from burn even on a cash basis). */
export const NON_CASH_EXPENSE_ROLES: readonly string[] = ['bad_debt', 'investment_writeoffs']

interface Template {
  code: string
  name: string
  type: LedgerAccountType
}

const FIXED: Record<FixedRole, Template> = {
  cash_on_hand: { code: '1050', name: 'Cash on hand', type: 'asset' },
  ar: { code: '1200', name: 'Accounts receivable', type: 'asset' },
  vat_receivable: { code: '1250', name: 'VAT receivable', type: 'asset' },
  prepaid: { code: '1300', name: 'Prepaid expenses', type: 'asset' },
  inventory: { code: '1400', name: 'Inventory', type: 'asset' },
  fixed_assets: { code: '1600', name: 'Fixed assets', type: 'asset' },
  other_assets: { code: '1900', name: 'Other assets', type: 'asset' },
  clearing_payouts: { code: '1510', name: 'Payouts in transit', type: 'asset' },
  clearing_transfers: { code: '1520', name: 'Transfers in transit', type: 'asset' },
  clearing_equity: { code: '1530', name: 'Equity money in transit', type: 'asset' },
  clearing_investments: { code: '1550', name: 'Investment money in transit', type: 'asset' },
  clearing_unmatched_receipts: { code: '1540', name: 'Receipts not yet seen at the bank', type: 'asset' },
  ap: { code: '2000', name: 'Accounts payable', type: 'liability' },
  payroll_liabilities: { code: '2200', name: 'Payroll liabilities', type: 'liability' },
  sales_tax_payable: { code: '2300', name: 'Sales tax payable', type: 'liability' },
  deferred_revenue: { code: '2400', name: 'Deferred revenue', type: 'liability' },
  customer_deposits: { code: '2450', name: 'Customer deposits', type: 'liability' },
  other_liabilities: { code: '2800', name: 'Other liabilities', type: 'liability' },
  suspense: { code: '2900', name: 'Unexplained money in (needs review)', type: 'liability' },
  opening_balance_equity: { code: '3000', name: 'Opening balances', type: 'equity' },
  paid_in_capital: { code: '3100', name: 'Paid-in capital', type: 'equity' },
  safes: { code: '3200', name: 'SAFEs', type: 'equity' },
  convertible_notes: { code: '3250', name: 'Convertible notes', type: 'equity' },
  owner_contributions: { code: '3300', name: 'Owner contributions', type: 'equity' },
  owner_money_unspecified: { code: '3350', name: 'Owner money, loan or investment not yet said', type: 'equity' },
  owner_draws: { code: '3400', name: 'Owner draws', type: 'equity' },
  retained_earnings: { code: '3900', name: 'Retained earnings', type: 'equity' },
  revenue: { code: '4000', name: 'Revenue', type: 'income' },
  refunds: { code: '4100', name: 'Refunds and disputes', type: 'income' },
  interest_income: { code: '4500', name: 'Interest income', type: 'income' },
  wages_income: { code: '4700', name: 'Wages and salary', type: 'income' },
  other_income: { code: '4800', name: 'Other income', type: 'income' },
  fx_gain_loss: { code: '4900', name: 'FX gain/loss', type: 'income' },
  investment_gains: { code: '4950', name: 'Realized gains on investments', type: 'income' },
  cogs: { code: '5000', name: 'Cost of revenue', type: 'expense' },
  payroll_expense: { code: '6000', name: 'Payroll', type: 'expense' },
  payroll_taxes: { code: '6010', name: 'Payroll taxes', type: 'expense' },
  payroll_benefits: { code: '6020', name: 'Benefits', type: 'expense' },
  contractors: { code: '6100', name: 'Contractors', type: 'expense' },
  processor_fees: { code: '6200', name: 'Processor fees', type: 'expense' },
  bank_fees: { code: '6210', name: 'Bank fees', type: 'expense' },
  software: { code: '6300', name: 'Software', type: 'expense' },
  cloud: { code: '6310', name: 'Cloud and infrastructure', type: 'expense' },
  marketing: { code: '6400', name: 'Marketing', type: 'expense' },
  travel: { code: '6500', name: 'Travel', type: 'expense' },
  meals: { code: '6510', name: 'Meals', type: 'expense' },
  groceries: { code: '6520', name: 'Groceries and supplies', type: 'expense' },
  shopping: { code: '6530', name: 'Shopping', type: 'expense' },
  entertainment: { code: '6540', name: 'Entertainment and streaming', type: 'expense' },
  rent: { code: '6600', name: 'Rent and office', type: 'expense' },
  utilities: { code: '6605', name: 'Utilities', type: 'expense' },
  housing: { code: '6610', name: 'Mortgage and housing', type: 'expense' },
  professional_fees: { code: '6700', name: 'Professional fees', type: 'expense' },
  insurance: { code: '6800', name: 'Insurance', type: 'expense' },
  taxes: { code: '6900', name: 'Taxes', type: 'expense' },
  bad_debt: { code: '6950', name: 'Bad debt', type: 'expense' },
  investment_writeoffs: { code: '6960', name: 'Investment write-offs', type: 'expense' },
  uncategorized_expense: { code: '6990', name: 'Uncategorized spending', type: 'expense' },
  other_expense: { code: '6999', name: 'Other expenses', type: 'expense' },
}

export function isFixedRole(role: string): role is FixedRole {
  return Object.hasOwn(FIXED, role)
}

export function isExpenseRole(role: string): role is ExpenseRole {
  return (EXPENSE_ROLES as readonly string[]).includes(role)
}

export function isIncomeRole(role: string): role is IncomeRole {
  return (INCOME_ROLES as readonly string[]).includes(role)
}

export function cashRole(sourceAccountId: string, accountType: AccountType): ParamRole {
  switch (accountType) {
    case 'credit_card':
      return `card:${sourceAccountId}`
    case 'loan':
      return `loan:${sourceAccountId}`
    case 'processor_balance':
      return `processor:${sourceAccountId}`
    default:
      return `cash:${sourceAccountId}`
  }
}

export interface RoleDefinition extends Template {
  role: SystemRole
  /** For parameterized roles: the source account id or counterpart entity id. */
  param: string | null
  normalBalance: 'debit' | 'credit'
}

export interface RoleNames {
  /** Display name of a source account (for cash/card/processor/loan roles). */
  sourceAccountName?: string
  /** Display name of a counterpart entity (for due_to/due_from/owner_payable). */
  entityName?: string
}

/** Resolve any role key to its account definition. Throws on an unknown key, so typos never create accounts. */
export function defineRole(role: string, names: RoleNames = {}): RoleDefinition {
  if (isFixedRole(role)) {
    const t = FIXED[role]
    return { ...t, role, param: null, normalBalance: normalOf(t.type) }
  }
  const m = /^(cash|processor|card|loan|due_from|due_to|owner_payable|investment):(.+)$/.exec(role)
  if (!m) throw new Error(`Unknown ledger role "${role}"`)
  const kind = m[1] as 'cash' | 'processor' | 'card' | 'loan' | 'due_from' | 'due_to' | 'owner_payable' | 'investment'
  const param = m[2] as string
  const src = names.sourceAccountName ?? param
  const ent = names.entityName ?? param
  const byKind: Record<typeof kind, Template> = {
    cash: { code: '1000', name: src, type: 'asset' },
    processor: { code: '1100', name: src, type: 'asset' },
    card: { code: '2100', name: src, type: 'liability' },
    loan: { code: '2500', name: src, type: 'liability' },
    due_from: { code: '1400', name: `Owed by ${ent}`, type: 'asset' },
    due_to: { code: '2600', name: `Owed to ${ent}`, type: 'liability' },
    owner_payable: { code: '2700', name: `Owed to ${ent} (owner)`, type: 'liability' },
    investment: { code: '1700', name: `Investment in ${src}`, type: 'asset' },
  }
  const t = byKind[kind]
  return { ...t, role: role as ParamRole, param, normalBalance: normalOf(t.type) }
}

export function normalOf(type: LedgerAccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit'
}

/** The default template created for every new entity (parameterized accounts appear as they're used). */
export function defaultTemplate(): RoleDefinition[] {
  return FIXED_ROLES.map((r) => defineRole(r))
}

/** Roles that hold money owned by the entity right now (for cash-flow statements). */
export function isCashLikeRole(role: string): boolean {
  return role.startsWith('cash:') || role.startsWith('processor:') || role === 'cash_on_hand'
}

export function isClearingRole(role: string): boolean {
  return role.startsWith('clearing_')
}

/** Cash-flow statement section for the counter-account of a cash movement. */
export function cashFlowSection(role: string): 'operating' | 'investing' | 'financing' | 'internal' {
  if (isCashLikeRole(role) || role.startsWith('card:') || isClearingRole(role)) return 'internal'
  if (role.startsWith('loan:') || role.startsWith('owner_payable:') || role.startsWith('due_to:') || role.startsWith('due_from:')) {
    return 'financing'
  }
  if (role.startsWith('investment:') || role === 'investment_gains') return 'investing'
  if (['opening_balance_equity', 'paid_in_capital', 'safes', 'convertible_notes', 'owner_contributions', 'owner_money_unspecified', 'owner_draws'].includes(role)) {
    return 'financing'
  }
  return 'operating'
}
