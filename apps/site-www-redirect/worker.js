// www.aggregate.finance → https://aggregate.finance (308, path and query kept). Was the host redirect in
// apps/site/vercel.json. A Worker because the Cloudflare token in use can't edit zone Redirect Rules; a Single
// Redirect Rule on the zone would do the same job without a Worker if one is added later.
export default {
  fetch(request) {
    const url = new URL(request.url)
    return new Response(null, {
      status: 308,
      headers: {
        Location: `https://aggregate.finance${url.pathname}${url.search}`,
        'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  },
}
