// Schema check always; live checks against a running Aggregate when AGFN_ZAPIER_TEST_KEY is set, e.g.
//   npx aggregate-finance demo   (prints a key), then
//   AGFN_ZAPIER_TEST_KEY=agfn_live_… AGFN_ZAPIER_TEST_URL=http://127.0.0.1:8787 npm test
const { test } = require('node:test')
const assert = require('node:assert/strict')
// The same check `zapier validate` runs: functions compiled, then the schema.
const { compileApp, validateApp } = require('zapier-platform-core/src/tools/schema')
const { createAppTester, tools } = require('zapier-platform-core')
const App = require('../index')

test('the app definition passes Zapier\'s schema', () => {
  assert.deepEqual(validateApp(compileApp(App)).map((e) => e.stack), [])
})

const key = process.env.AGFN_ZAPIER_TEST_KEY
const live = { skip: !key && 'set AGFN_ZAPIER_TEST_KEY to run against a server' }
const bundle = (inputData = {}) => ({ authData: { api_key: key, base_url: process.env.AGFN_ZAPIER_TEST_URL || 'http://127.0.0.1:8787' }, inputData })
tools.env.inject()
const appTester = createAppTester(App)

test('auth test returns whoami with a connection label', live, async () => {
  const me = await appTester(App.authentication.test, bundle())
  assert.ok(me.connection)
  assert.ok(Array.isArray(me.companies))
})

test('a bad key gives a plain error', live, async () => {
  await assert.rejects(appTester(App.authentication.test, { ...bundle(), authData: { ...bundle().authData, api_key: 'agfn_live_nope' } }), /didn't accept this key/)
})

test('New Transaction returns rows with unique ids and flat amounts', live, async () => {
  const rows = await appTester(App.triggers.new_transaction.operation.perform, bundle())
  assert.ok(rows.length > 0)
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length)
  for (const r of rows) assert.match(String(r.amount_value), /^-?\d+(\.\d+)?$/)
})

test('New Transaction filters money out', live, async () => {
  const rows = await appTester(App.triggers.new_transaction.operation.perform, bundle({ direction: 'out' }))
  for (const r of rows) assert.ok(Number(r.amount_value) < 0, r.amount)
})

test('New Item to Review gives plain text, not untrusted_text objects', live, async () => {
  const rows = await appTester(App.triggers.new_review_item.operation.perform, bundle())
  for (const r of rows) {
    assert.ok(r.id)
    assert.equal(typeof r.title, 'string')
  }
})

test('Get Cash and Runway finds one company', live, async () => {
  const me = await appTester(App.authentication.test, bundle())
  const company = me.companies.find((c) => c.kind === 'company').name
  const rows = await appTester(App.searches.company_overview.operation.perform, bundle({ company }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company, company)
  assert.match(rows[0].cash, / [A-Z]{3}$/)
})

test('Find Upcoming Payments returns dated items with ids', live, async () => {
  const rows = await appTester(App.searches.upcoming.operation.perform, bundle({ days: 30 }))
  for (const r of rows) {
    assert.ok(r.id)
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/)
  }
})
