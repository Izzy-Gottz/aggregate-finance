const { baseUrl, DEFAULT_BASE } = require('./lib')

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'Aggregate key',
      type: 'password',
      required: true,
      helpText: 'In Aggregate, open **Connect your AI → + Connect another AI → Create a key**, choose what Zapier can see (read-only is enough), and paste the key (`agfn_live_…`).',
    },
    {
      key: 'base_url',
      label: 'Server address',
      type: 'string',
      required: false,
      default: DEFAULT_BASE,
      helpText: `Leave as ${DEFAULT_BASE} unless you run Aggregate on your own server.`,
    },
  ],
  test: (z, bundle) => z.request({ url: `${baseUrl(bundle)}/v1/whoami` }).then((r) => r.data !== undefined ? r.data : r.json),
  connectionLabel: '{{connection}}',
}
