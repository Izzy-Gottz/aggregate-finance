import { describe, expect, it } from 'vitest'
import { guardedFetch, isBlockedAddress, parseStoreUrl, safeLookup, type Resolver } from './safe-url.ts'

const PUBLIC = '93.184.216.34'
const resolves = (...ips: string[]): Resolver => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('store address', () => {
  it.each([
    ['https://shop.example.com', 'https://shop.example.com'],
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['  https://SHOP.example.com/store/  ', 'https://shop.example.com/store'],
    ['shop.example.com', 'https://shop.example.com'],
    ['https://shop.example.com:443', 'https://shop.example.com'],
  ])('takes %s', (input, base) => expect(parseStoreUrl(input)).toBe(base))

  it.each([
    ['plain http', 'http://shop.example.com'],
    ['another scheme', 'ftp://shop.example.com'],
    ['file scheme', 'file:///etc/passwd'],
    ['user in the address', 'https://user:pw@shop.example.com'],
    ['query', 'https://shop.example.com/?a=1'],
    ['fragment', 'https://shop.example.com/#x'],
    ['another port', 'https://shop.example.com:8443'],
    ['IPv4 literal', 'https://8.8.8.8'],
    ['metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['decimal IP', 'https://2130706433'],
    ['hex IP', 'https://0x7f.0.0.1'],
    ['octal IP', 'https://0177.0.0.1'],
    ['IPv6 literal', 'https://[2606:4700::1111]'],
    ['IPv6 loopback', 'https://[::1]'],
    ['localhost', 'https://localhost'],
    ['localhost with a dot', 'https://localhost.'],
    ['sub.localhost', 'https://a.localhost'],
    ['.local', 'https://printer.local'],
    ['.internal', 'https://db.internal'],
    ['Fly private name', 'https://agfn-prod.internal'],
    ['Fly flycast', 'https://agfn.flycast'],
    ['one label', 'https://intranet'],
    ['empty', ''],
    ['nonsense', 'https://'],
  ])('refuses %s', (_name, input) => expect(() => parseStoreUrl(input)).toThrow())
})

describe('addresses', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '198.18.0.1', '192.0.2.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd00::1', 'fdaa::1', 'fdaa:0:1234::2', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0:4136:e378::1', '2001:db8::1',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))

  it.each(['8.8.8.8', '1.1.1.1', PUBLIC, '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  )

  it('blocks what it cannot read', () => expect(isBlockedAddress('not an address')).toBe(true))
})

describe('guardedFetch', () => {
  const init = { method: 'GET', signal: AbortSignal.timeout(1000) }
  const ok = async () => new Response('[]', { status: 200 })

  it('passes a public host through, with redirects off', async () => {
    const seen: Array<RequestInit | undefined> = []
    const f = guardedFetch({ resolve: resolves(PUBLIC), fetch: async (_u, i) => (seen.push(i), new Response('[1]')) })
    expect(await (await f('https://shop.example.com/wp-json', init)).text()).toBe('[1]')
    expect(seen[0]?.redirect).toBe('manual')
  })

  it.each([['IPv4 private', '10.1.2.3'], ['loopback', '127.0.0.1'], ['metadata', '169.254.169.254'], ['CGNAT', '100.100.1.1'], ['Fly 6PN', 'fdaa:0:1::3'], ['ULA', 'fd12::1'], ['link-local', 'fe80::1']])(
    'refuses a host that resolves to %s, before any request',
    async (_n, ip) => {
      let called = 0
      const f = guardedFetch({ resolve: resolves(ip), fetch: async () => (called++, new Response('[]')) })
      await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent', forUser: true })
      expect(called).toBe(0)
    },
  )

  it('refuses when any one answer is private (a mixed record)', async () => {
    const f = guardedFetch({ resolve: resolves(PUBLIC, '10.0.0.1'), fetch: ok })
    await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('refuses a name that resolves to nothing, as retryable', async () => {
    const f = guardedFetch({ resolve: resolves(), fetch: ok })
    await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'transient' })
  })

  it('a DNS failure says nothing about the host or the resolver', async () => {
    const f = guardedFetch({ resolve: async () => { throw new Error('getaddrinfo ENOTFOUND secret.example.com') }, fetch: ok })
    const e = await f('https://shop.example.com/x', init).catch((x: Error) => x)
    expect((e as Error).message).not.toContain('secret')
    expect(e).toMatchObject({ kind: 'transient' })
  })

  it('checks every URL it is given, not only the first', async () => {
    const f = guardedFetch({ resolve: resolves(PUBLIC), fetch: ok })
    await expect(f('http://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent' })
    await expect(f('https://169.254.169.254/latest', init)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it.each([301, 302, 303, 307, 308])('never follows a %i and never reads its body', async (status) => {
    let calls = 0
    const f = guardedFetch({ resolve: resolves(PUBLIC), fetch: async () => (calls++, new Response('secret body', { status, headers: { location: 'https://169.254.169.254/' } })) })
    const e = await f('https://shop.example.com/x', init).catch((x: Error) => x)
    expect(calls).toBe(1)
    expect(e).toMatchObject({ kind: 'permanent', forUser: true })
    expect((e as Error).message).not.toMatch(/secret body|169\.254/)
  })

  it('stops reading past the size cap', async () => {
    const f = guardedFetch({ resolve: resolves(PUBLIC), maxBytes: 10, fetch: async () => new Response('x'.repeat(11)) })
    await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent', forUser: true })
  })

  it('believes neither a small nor a missing content-length', async () => {
    const f = guardedFetch({ resolve: resolves(PUBLIC), maxBytes: 10, fetch: async () => new Response('x'.repeat(50), { headers: { 'content-length': '2' } }) })
    await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('refuses a stated oversize at once', async () => {
    let read = false
    const body = new ReadableStream({ pull() { read = true } }, { highWaterMark: 0 })
    const f = guardedFetch({ resolve: resolves(PUBLIC), maxBytes: 10, fetch: async () => new Response(body, { headers: { 'content-length': '11' } }) })
    await expect(f('https://shop.example.com/x', init)).rejects.toMatchObject({ kind: 'permanent' })
    expect(read).toBe(false)
  })

  it('an endless body ends when the timeout does', async () => {
    const c = new AbortController()
    let live = true
    const body = new ReadableStream({ pull: (ctl) => new Promise((r) => setTimeout(() => { if (live) ctl.enqueue(new Uint8Array(1)); r() }, 1)), cancel() { live = false } })
    const f = guardedFetch({ resolve: resolves(PUBLIC), fetch: async () => new Response(body) })
    setTimeout(() => c.abort(), 20)
    await expect(f('https://shop.example.com/x', { signal: c.signal })).rejects.toBeTruthy()
  })
})

describe('safeLookup (the check made again as the connection opens)', () => {
  const call = (lookup: ReturnType<typeof safeLookup>, all: boolean) =>
    new Promise<unknown>((resolve, reject) => lookup('shop.example.com', { all }, (err: Error | null, a?: unknown, f?: unknown) => (err ? reject(err) : resolve(all ? a : [a, f]))))

  it('hands over public answers in both shapes node asks for', async () => {
    expect(await call(safeLookup(resolves(PUBLIC)), true)).toEqual([{ address: PUBLIC, family: 4 }])
    expect(await call(safeLookup(resolves(PUBLIC)), false)).toEqual([PUBLIC, 4])
  })

  it('DNS rebinding: public for the first check, private by the time the socket opens', async () => {
    let n = 0
    const rebinding: Resolver = async () => [{ address: n++ === 0 ? PUBLIC : '169.254.169.254', family: 4 }]
    const opened: string[] = []
    const lookup = safeLookup(rebinding)
    const f = guardedFetch({
      resolve: rebinding,
      fetch: async () => {
        // What the real transport does: it resolves once more through safeLookup before connecting.
        const got = (await call(lookup, true)) as Array<{ address: string }>
        opened.push(got[0]!.address)
        return new Response('[]')
      },
    })
    await expect(f('https://shop.example.com/x', { method: 'GET' })).rejects.toMatchObject({ kind: 'permanent' })
    expect(opened).toEqual([])
  })
})
