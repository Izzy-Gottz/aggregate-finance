const { get, money, text, companyField } = require('../lib')

const perform = async (z, bundle) => {
  const data = await get(z, bundle, '/v1/upcoming', { days: bundle.inputData.days || 14, company: bundle.inputData.company })
  return (data.items || []).map((i, n) => ({
    id: i.record_id || `${i.date}:${i.company}:${n}`,
    date: i.date,
    company: i.company,
    kind: i.kind,
    what: text(i.what),
    amount: money(i.amount),
    amount_value: i.amount ? i.amount.amount : null,
    confidence: i.confidence,
  }))
}

module.exports = {
  key: 'upcoming',
  noun: 'Upcoming Payment',
  display: {
    label: 'Find Upcoming Payments',
    description: 'Finds money expected in or out soon: invoices due, bills, payroll and subscriptions (money out is negative).',
  },
  operation: {
    inputFields: [
      { key: 'days', label: 'Days ahead', type: 'integer', default: '14', required: false },
      companyField,
    ],
    perform,
    sample: {
      id: '01M4R3JYGK39WN33N64XXBJNG3',
      date: '2026-10-12',
      company: 'Bluebird Studio',
      kind: 'expected_income',
      what: 'INV-1045 Ferris & Co',
      amount: '12200.00 USD',
      amount_value: '12200.00',
      confidence: 'scheduled',
    },
    outputFields: [
      { key: 'date', label: 'Date' },
      { key: 'company', label: 'Company' },
      { key: 'kind', label: 'Kind' },
      { key: 'what', label: 'What' },
      { key: 'amount', label: 'Amount' },
      { key: 'confidence', label: 'Confidence' },
    ],
  },
}
