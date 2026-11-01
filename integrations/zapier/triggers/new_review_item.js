const { get, text, companyField } = require('../lib')

const perform = async (z, bundle) => {
  const data = await get(z, bundle, '/v1/review', { company: bundle.inputData.company })
  return (data.items || []).map((i) => ({
    id: i.id,
    company: i.company,
    kind: i.kind,
    title: text(i.title),
    detail: text(i.detail),
    created_at: i.created_at,
    choices: (i.choices || []).map((c) => c.label).join('; '),
  }))
}

module.exports = {
  key: 'new_review_item',
  noun: 'Review Item',
  display: {
    label: 'New Item to Review',
    description: 'Triggers when Aggregate has a question for a person, like whether owner money was a loan or an investment.',
  },
  operation: {
    type: 'polling',
    inputFields: [companyField],
    perform,
    sample: {
      id: 'owner_money:01M4R3JWHVKDKJ21JNNJ3YWGMQ',
      company: 'Northwind Labs',
      kind: 'whose_money',
      title: 'Owner money: a loan or an investment?',
      detail: 'Jul 24 Alex Morgan $25,000.00',
      created_at: '2026-10-12T13:07:13.595Z',
      choices: 'Owner loan (to be paid back); Owner investment',
    },
    outputFields: [
      { key: 'id', label: 'Item ID' },
      { key: 'company', label: 'Company' },
      { key: 'title', label: 'Question' },
      { key: 'detail', label: 'Detail' },
      { key: 'choices', label: 'Answers to choose from' },
      { key: 'created_at', label: 'Asked at', type: 'datetime' },
    ],
  },
}
