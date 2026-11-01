// Aggregate for Zapier: a read-only client of Aggregate's REST API (/v1, the same operations as the MCP tools).
// It adds nothing to the server. See README.md.

const { version } = require('./package.json')
const { version: platformVersion } = require('zapier-platform-core')
const authentication = require('./authentication')
const { addKey, plainErrors } = require('./lib')
const newTransaction = require('./triggers/new_transaction')
const newReviewItem = require('./triggers/new_review_item')
const companyOverview = require('./searches/company_overview')
const upcoming = require('./searches/upcoming')

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addKey],
  afterResponse: [plainErrors],
  triggers: { [newTransaction.key]: newTransaction, [newReviewItem.key]: newReviewItem },
  searches: { [companyOverview.key]: companyOverview, [upcoming.key]: upcoming },
}
