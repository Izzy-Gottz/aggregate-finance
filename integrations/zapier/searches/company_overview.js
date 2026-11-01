const { get, money } = require('../lib')

// One row per company: cash, burn, runway and what's owed, with Aggregate's fixed definitions.
const perform = async (z, bundle) => {
  const data = await get(z, bundle, '/v1/overview', { company: bundle.inputData.company })
  return (data.companies || []).map((c) => ({
    id: c.company,
    company: c.company,
    as_of: data.as_of,
    cash: money(c.cash),
    cash_value: c.cash ? c.cash.amount : null,
    card_debt: money(c.card_debt),
    net_burn_3mo: money(c.net_burn_3mo),
    runway_months: c.runway_months,
    runway_state: c.runway_state,
    mrr: money(c.mrr),
    owed_to_you: c.owed_to_you ? money(c.owed_to_you.total) : null,
    overdue_to_you: c.owed_to_you ? money(c.owed_to_you.overdue) : null,
    bills_due_30d: money(c.bills_due_30d),
    next_payroll_date: c.next_payroll ? c.next_payroll.date : null,
    next_payroll_estimate: c.next_payroll ? money(c.next_payroll.estimate) : null,
  }))
}

module.exports = {
  key: 'company_overview',
  noun: 'Company Overview',
  display: {
    label: 'Get Cash and Runway',
    description: "Finds a company's cash, net burn, runway, money owed and next payroll.",
  },
  operation: {
    inputFields: [{ key: 'company', label: 'Company', required: true, helpText: 'A company name, or "Personal".' }],
    perform,
    sample: {
      id: 'Northwind Labs',
      company: 'Northwind Labs',
      as_of: '2026-10-13T01:12:52.947Z',
      cash: '626479.77 USD',
      cash_value: '626479.77',
      card_debt: '15655.65 USD',
      net_burn_3mo: '29428.50 USD',
      runway_months: 21.3,
      runway_state: 'ok',
      mrr: '49553.17 USD',
      owed_to_you: '0.00 USD',
      overdue_to_you: '0.00 USD',
      bills_due_30d: '9035.00 USD',
      next_payroll_date: '2026-10-15',
      next_payroll_estimate: '30396.31 USD',
    },
    outputFields: [
      { key: 'company', label: 'Company' },
      { key: 'cash', label: 'Cash' },
      { key: 'net_burn_3mo', label: 'Net burn per month (last 3 months)' },
      { key: 'runway_months', label: 'Runway (months)', type: 'number' },
      { key: 'runway_state', label: 'Runway state' },
      { key: 'owed_to_you', label: 'Owed to you' },
      { key: 'overdue_to_you', label: 'Overdue to you' },
      { key: 'bills_due_30d', label: 'Bills due in 30 days' },
      { key: 'next_payroll_date', label: 'Next payroll date' },
    ],
  },
}
