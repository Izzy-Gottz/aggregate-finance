// Shared helpers: the base URL, the bearer key, and plain errors from Aggregate's {error, message, hint} bodies.

const DEFAULT_BASE = 'https://app.aggregate.finance'

const baseUrl = (bundle) => String(bundle.authData.base_url || DEFAULT_BASE).replace(/\/+$/, '')

const addKey = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.api_key) request.headers.Authorization = `Bearer ${bundle.authData.api_key}`
  request.headers.Accept = 'application/json'
  return request
}

const plainErrors = (response, z) => {
  if (response.status < 400) return response
  let body = {}
  try {
    body = response.json || JSON.parse(response.content)
  } catch (e) {
    body = {}
  }
  const message = [body.message, body.hint].filter(Boolean).join(' ') || `Aggregate answered HTTP ${response.status}.`
  if (response.status === 401) throw new z.errors.Error(`Aggregate didn't accept this key. Create a new one in Connect your AI. ${message}`, 'AuthenticationError', 401)
  if (response.status === 429) throw new z.errors.ThrottledError(message, Number(response.getHeader('retry-after')) || 60)
  throw new z.errors.Error(message, body.error || 'AggregateError', response.status)
}

/** {amount: "1234.56", currency: "USD"} → "1234.56 USD" (Zapier fields are flat). */
const money = (m) => (m && typeof m === 'object' && 'amount' in m ? `${m.amount} ${m.currency}` : null)

/** Text written by third parties arrives as {untrusted_text: {text}}; Zaps get the plain text. */
const text = (v) => (v && typeof v === 'object' && v.untrusted_text ? v.untrusted_text.text : v == null ? null : String(v))

const get = async (z, bundle, path, params) => {
  const res = await z.request({ url: `${baseUrl(bundle)}${path}`, params: Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) })
  return res.data !== undefined ? res.data : res.json
}

const companyField = { key: 'company', label: 'Company', helpText: 'A company name, "Personal", or leave empty for every company this key can see.', required: false }

module.exports = { DEFAULT_BASE, baseUrl, addKey, plainErrors, money, text, get, companyField }
