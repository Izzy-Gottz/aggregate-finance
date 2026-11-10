// aggregate.finance Worker script. It runs only for video files (run_worker_first in ../site/wrangler.jsonc); every
// other path is served straight from static assets. Workers static assets ignore Range headers and always answer 200
// with the whole file, and Safari/iOS will not play a video without 206 range responses. This adds them.
//
// CPU (free plan: 10 ms per request) is the constraint, and JS stream transforms are expensive, so:
// - no Range, or a range that is the whole file from byte 0 ("bytes=0-", Safari's usual full read): the asset body is
//   passed through natively (~1 ms);
// - other ranges: answered by the Cache API, which slices natively and returns 206 itself. The cache key carries the
//   asset ETag, so a deploy never serves stale bytes. On a cache miss the file is read once into memory and sliced
//   (a few ms for these files) and a copy is stored for the next request. The Cache API works on the custom domain
//   only; on workers.dev every ranged request takes the in-memory path.
// Total sizes come from sizes.json, written by sizes.mjs at deploy (the binding sends no Content-Length).
import sizes from './sizes.json'

export default {
  async fetch(request, env, ctx) {
    const range = request.headers.get('Range')
    const url = new URL(request.url)
    const res = await env.ASSETS.fetch(new Request(url, { method: 'GET', headers: withoutRange(request.headers) }))
    if (res.status !== 200) return res
    const headers = new Headers(res.headers)
    headers.set('Accept-Ranges', 'bytes')
    const head = request.method === 'HEAD'
    const size = sizes[decodeURIComponent(url.pathname)]
    if (typeof size === 'number') headers.set('Content-Length', String(size))
    const r = range && typeof size === 'number' ? parseRange(range, size) : 'whole'
    if (r === 'whole') return new Response(head ? null : res.body, { status: 200, headers })
    if (!r) {
      res.body?.cancel()
      headers.set('Content-Range', `bytes */${size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    const [start, end] = r
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    if (head) {
      res.body?.cancel()
      return new Response(null, { status: 206, headers })
    }
    if (start === 0 && end === size - 1) return new Response(res.body, { status: 206, headers })

    const key = new URL(url)
    key.search = '?v=' + encodeURIComponent(res.headers.get('ETag') || 'none')
    const cache = typeof caches !== 'undefined' ? caches.default : null
    if (cache) {
      const hit = await cache.match(new Request(key, { headers: { Range: `bytes=${start}-${end}` } }))
      if (hit && hit.status === 206) {
        res.body?.cancel()
        return new Response(hit.body, { status: 206, headers })
      }
    }
    const buf = await res.arrayBuffer()
    if (cache && buf.byteLength === size) {
      const stored = new Response(buf, {
        headers: { 'Content-Type': headers.get('Content-Type') || 'video/mp4', 'Cache-Control': 'public, max-age=604800' },
      })
      ctx.waitUntil(cache.put(key, stored).catch(() => {}))
    }
    return new Response(buf.slice(start, end + 1), { status: 206, headers })
  },
}

function withoutRange(h) {
  const out = new Headers(h)
  out.delete('Range')
  out.delete('If-Range')
  return out
}

// One range ("bytes=a-b", "bytes=a-", "bytes=-n"). Multiple or malformed ranges get the whole file (RFC 9110
// allows ignoring Range). Returns [start, end], 'whole', or null for an unsatisfiable range (416).
function parseRange(value, size) {
  const v = value.trim()
  if (!v.startsWith('bytes=') || v.includes(',')) return 'whole'
  const m = /^(\d*)-(\d*)$/.exec(v.slice(6).trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'whole'
  let start, end
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || end < start) return null
  return [start, end]
}
