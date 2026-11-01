const { get, money, text, companyField } = require('../lib')

// Newest rows first; Zapier deduplicates on id, so each transaction triggers once.
const perform = async (z, bundle) => {
  const data = await get(z, bundle, '/v1/transactions', { company: bundle.inputData.company, direction: bundle.inputData.direction, limit: 100 })
  return (data.transactions || []).map((t) => ({
    ...t,
    counterparty: text(t.counterparty),
    amount_value: t.amount ? t.amount.amount : null,
    currency: t.amount ? t.amount.currency : null,
    amount: money(t.amount),
  }))
}

module.exports = {
  key: 'new_transaction',
  noun: 'Transaction',
  display: {
    label: 'New Transaction',
    description: 'Triggers when a new transaction appears in Aggregate (from a bank, card, processor or a person).',
  },
  operation: {
    type: 'polling',
    inputFields: [
      companyField,
      { key: 'direction', label: 'Direction', choices: { in: 'Money in', out: 'Money out' }, required: false, helpText: 'Leave empty for both.' },
    ],
    perform,
    sample: {
      id: '01M4R3JZQCKT0R5P5HVCJSQVZ7',
      date: '2026-10-12',
      amount: '168.27 USD',
      amount_value: '168.27',
      currency: 'USD',
      company: 'Harbor Coffee',
      counterparty: null,
      category: 'revenue',
      kind: 'revenue',
      status: 'posted',
      account_id: '01M4R3JVHPX7SEGJBQ8DZNKMMK',
      added_by: 'synced from Demo data · Harbor Coffee',
      needs_review: false,
    },
    outputFields: [
      { key: 'id', label: 'Transaction ID' },
      { key: 'date', label: 'Date' },
      { key: 'amount', label: 'Amount (with currency)' },
      { key: 'amount_value', label: 'Amount (negative = money out)', type: 'number' },
      { key: 'currency', label: 'Currency' },
      { key: 'company', label: 'Company' },
      { key: 'counterparty', label: 'Counterparty' },
      { key: 'category', label: 'Category' },
      { key: 'status', label: 'Status' },
      { key: 'needs_review', label: 'Needs review', type: 'boolean' },
    ],
  },
}
