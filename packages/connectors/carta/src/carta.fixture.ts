import type { FixtureRoute } from '@agfn/connector-sdk/testing'

// A made-up holder: every name, id, date and amount here is invented. Only the shapes follow Carta's Portfolio API
// as its docs and playground return them (Oct 12 2026): wrapped scalars, 20-decimal quantities, "0E-50" prices,
// reissues recorded as zero-price share sales, exercises linked by optionGrantTransactionDetail.certificatedId (sic).
/** Match on the path alone (paged requests add ?pageToken=). */
export const path = (re: RegExp) => (url: URL) => re.test(url.pathname)
const m = (amount: string, cur = 'USD') => ({ currencyCode: { value: cur }, amount: { value: amount } })
const q = (n: string) => ({ value: `${n}.00000000000000000000` })
const d = (v: string) => ({ value: v })
const sale = (securityId: string, qty: string, proceeds: string, date: string, status = 'COMPLETED') => ({ transactionType: 'TRANSACTION_TYPE_SHARE_SALE', transactionStatus: `TRANSACTION_STATUS_${status}`, securityType: 'SECURITY_TYPE_SHARE', shareTransactionDetail: { securityId, saleQuantity: q(qty), salePrice: m(proceeds) }, transactionTime: `${date}T00:00:00Z` })
const P = '/v1alpha1/portfolios/501/issuers'

export const ROUTES: FixtureRoute[] = [
  { match: path(/\/portfolios$/), respond: { json: { portfolios: [{ portfolioId: '501', legalName: "Alex Rivera's Portfolio" }, { portfolioId: '502', legalName: 'Example Ventures Fund I, L.P.' }], nextPageToken: '' } } },
  { match: path(/\/portfolios\/501\/issuers$/), respond: { json: { issuers: [{ id: '11', legalName: 'Lumen Labs, Inc.', doingBusinessAsName: 'Lumen' }, { id: '12', legalName: 'Northpeak' }, { id: '13', legalName: 'Tidewater Cloud, Inc.' }, { id: '14', legalName: 'Gone Co' }, { id: '15', legalName: 'Kind Co' }], nextPageToken: 'MTE=' } } },

  // Lumen (common): founder shares; 2 of them split off (cancel + reissue at pps 0) and sold for $30; an exercise whose
  // certificate shows $3.00 but paid the $0.15 strike. The 409A marks what's held.
  {
    match: path(new RegExp(`${P}/11/certificates$`)),
    respond: {
      json: {
        certificates: [
          { id: '101', shareClassName: 'Common', issueDate: d('2014-03-03'), quantity: q('120000'), pricePerShare: m('0.2500000000'), canceledDate: d('2021-07-15'), canceledQuantity: q('0') },
          { id: '102', shareClassName: 'Common', issueDate: d('2021-07-15'), quantity: q('119998'), pricePerShare: m('0E-30'), canceledQuantity: q('0') },
          { id: '103', shareClassName: 'Common', issueDate: d('2021-07-15'), quantity: q('2'), pricePerShare: m('0E-30'), canceledDate: d('2021-07-15'), canceledQuantity: q('0') },
          { id: '104', shareClassName: 'Common', issueDate: d('2019-02-11'), quantity: q('3000'), pricePerShare: m('3.000000000000000000000000000'), canceledQuantity: q('0') },
        ],
        nextPageToken: '',
      },
    },
  },
  { match: path(new RegExp(`${P}/11/restrictedStockAwards$`)), respond: { json: { restrictedStockAwards: [{ id: '105', shareClassName: 'Common', issueDate: d('2017-09-01'), quantity: q('10000'), pricePerShare: m('0.0100') }], nextPageToken: '' } } },
  {
    match: path(new RegExp(`${P}/11/convertibleNotes$`)),
    respond: {
      json: {
        convertibleNotes: [
          { id: '1', issueDatetime: d('2025-04-14T09:00:00Z'), cashPaid: m('30000.0'), priceCap: m('9000000.0'), discountPercentage: d('0.15'), noteBlock: { name: 'Post-money SAFE 2025', noteType: 'SAFE', status: 'EXECUTED' } },
          { id: '2', issueDatetime: d('2024-03-01T09:00:00Z'), cashPaid: m('12000.0'), interestRate: d('5.00000000'), maturityDatetime: d('2026-03-01T00:00:00Z'), noteBlock: { name: 'Bridge 2024', noteType: 'CONVERTIBLE_DEBT', status: 'EXECUTED' } },
          { id: '3', issueDatetime: d('2023-05-01T09:00:00Z'), conversionDatetime: d('2024-02-10T00:00:00Z'), canceledDatetime: d('2024-02-10T00:00:00Z'), cashPaid: m('4000.0'), noteBlock: { name: 'Seed SAFE', noteType: 'SAFE', status: 'EXECUTED' } },
          { id: '4', issueDatetime: d('2018-07-01T07:00:00Z'), cashPaid: m('1500000.0'), noteBlock: { name: 'Bridge Note', noteType: 'CONVERTIBLE_DEBT', status: 'DRAFT' } },
        ],
        nextPageToken: '',
      },
    },
  },
  { match: path(new RegExp(`${P}/11/fairMarketValue$`)), respond: { json: { fairMarketValue: { asOfDate: d('2026-10-12'), price: m('18.400000000000'), stale: false } } } },
  {
    match: path(new RegExp(`${P}/11/securityTransactions$`)),
    respond: {
      json: {
        securitytransactions: [
          sale('101', '119998', '0E-50', '2021-07-15'),
          sale('101', '2', '0E-50', '2021-07-15'),
          sale('103', '2', '30.00000000000000000000', '2021-07-15'),
          { transactionType: 'TRANSACTION_TYPE_OPTION_GRANT_EXERCISE', transactionStatus: 'TRANSACTION_STATUS_COMPLETED', securityType: 'SECURITY_TYPE_OPTION_GRANT', optionGrantTransactionDetail: { securityId: '201', exerciseQuantity: q('3000'), netExerciseQuantity: q('3000'), exercisePrice: m('0.150000000000'), certificatedId: '104' }, transactionTime: '2019-02-11T00:00:00Z' },
          // Not done yet: no event.
          { transactionType: 'TRANSACTION_TYPE_OPTION_GRANT_EXERCISE', transactionStatus: 'TRANSACTION_STATUS_SUBMITTED', securityType: 'SECURITY_TYPE_OPTION_GRANT', optionGrantTransactionDetail: { securityId: '202', exerciseQuantity: q('100'), exercisePrice: m('0.15'), certificatedId: '9999' }, transactionTime: '2026-10-01T00:00:00Z' },
        ],
        nextPageToken: '',
      },
    },
  },

  // Northpeak (preferred): Series B exchanged for Series A the same day (zero-price "sale", new certificate at pps 0);
  // then the Series A sold in full, in two sales (salePrice is each sale's total proceeds). Preferred is never marked by
  // a common 409A.
  {
    match: path(new RegExp(`${P}/12/certificates$`)),
    respond: {
      json: {
        certificates: [
          { id: '301', shareClassName: 'Series B Preferred', issueDate: d('2014-05-05'), quantity: q('200000'), pricePerShare: m('0.30'), canceledDate: d('2024-07-22') },
          { id: '302', shareClassName: 'Series A Preferred', issueDate: d('2024-07-22'), quantity: q('200000'), pricePerShare: m('0E-30'), canceledDate: d('2026-08-25') },
        ],
      },
    },
  },
  { match: path(new RegExp(`${P}/12/securityTransactions$`)), respond: { json: { securitytransactions: [sale('301', '200000', '0E-50', '2024-07-22'), sale('302', '120000', '85000.00', '2026-03-10'), sale('302', '80000', '125000.00', '2026-08-25')] } } },
  { match: path(new RegExp(`${P}/12/fairMarketValue$`)), respond: { json: { fairMarketValue: { asOfDate: d('2026-10-12'), price: m('2.75'), stale: false } } } },

  // Tidewater Cloud: one USD certificate and one AUD certificate (two positions; one currency each); the 409A has no
  // price.
  { match: path(new RegExp(`${P}/13/certificates$`)), respond: { json: { certificates: [{ id: '401', shareClassName: 'Series Seed Preferred', issueDate: d('2014-02-01'), quantity: q('1500'), pricePerShare: m('0.80') }, { id: '402', shareClassName: 'Ordinary Shares', issueDate: d('2021-04-06'), quantity: q('2500'), pricePerShare: m('0.25', 'AUD') }] } } },
  { match: path(new RegExp(`${P}/13/fairMarketValue$`)), respond: { json: { fairMarketValue: { asOfDate: d('2026-10-12'), stale: false } } } },

  // Gone Co: every certificate canceled and nothing sold at a price (transferred away / distributed in kind).
  { match: path(new RegExp(`${P}/14/certificates$`)), respond: { json: { certificates: [{ id: '601', shareClassName: 'Common', issueDate: d('2016-01-04'), quantity: q('4000'), pricePerShare: m('0.125'), canceledDate: d('2025-11-30') }] } } },
  { match: path(new RegExp(`${P}/14/securityTransactions$`)), respond: { json: { securitytransactions: [sale('601', '4000', '0E-50', '2025-11-30')] } } },
  // 409A withheld from this app.
  { match: path(new RegExp(`${P}/14/fairMarketValue$`)), respond: { status: 403, json: { message: 'insufficient scope' } } },

  // Kind Co: most shares distributed in kind (a zero-price transfer, nothing reissued for them), 2 split off and sold.
  { match: path(new RegExp(`${P}/15/certificates$`)), respond: { json: { certificates: [{ id: '701', shareClassName: 'Common', issueDate: d('2015-06-01'), quantity: q('8000'), pricePerShare: m('1.25'), canceledDate: d('2021-07-15') }, { id: '702', shareClassName: 'Common', issueDate: d('2021-07-15'), quantity: q('2'), pricePerShare: m('0E-30'), canceledDate: d('2021-07-15') }] } } },
  { match: path(new RegExp(`${P}/15/securityTransactions$`)), respond: { json: { securitytransactions: [sale('701', '7998', '0E-50', '2021-07-15'), sale('701', '2', '0E-50', '2021-07-15'), sale('702', '2', '30.00', '2021-07-15')] } } },

  // Everything else is empty.
  { match: path(/\/issuers\/\w+\/(certificates|restrictedStockAwards|convertibleNotes|securityTransactions)$/), respond: { json: {} } },
  { match: path(/\/issuers\/\w+\/fairMarketValue$/), respond: { json: {} } },
]
