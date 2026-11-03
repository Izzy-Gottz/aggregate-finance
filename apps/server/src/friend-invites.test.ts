// Invites to someone's own account: fixed words, limits that hold, and nothing learned about who has an account.
import type { Kysely } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { withBypass } from '@agfn/db'
import { canonicalEmail, networkOf, firstName, friendEmail, friendLink, friendStopLink, NEW_ACCOUNT_PER_DAY, PER_DAY, PER_NETWORK_PER_DAY, pruneFriendInvites, recordFriendSignup, validStop } from './friend-invites.ts'
import { signIn, startServer } from './scenarios/harness.ts'

const post = (s: Awaited<ReturnType<typeof signIn>>, email: string) => s.post<{ message?: string }>('/api/friend-invite', { email })
const ON = { env: { AGFN_FRIEND_INVITES: '1' } }
const invites = (outbox: string[]) => outbox.filter((m) => m.includes('invited you to try Aggregate'))

describe('the email', () => {
  it('is fixed words with a first name, a link and no promise of free months', () => {
    const m = friendEmail(firstName('Dana Reyes'), friendLink('https://app.aggregate.finance/', '0123456789abcdef'), 'https://app.aggregate.finance/invites/stop?h=a&s=b')
    expect(m.text).toContain('1401 Pennsylvania Ave, Wilmington, DE 19806-4124, USA')
    expect(m.html).toContain('1401 Pennsylvania Ave, Wilmington, DE 19806-4124, USA')
    expect(m.subject).toBe('Dana invited you to try Aggregate')
    expect(m.text).toContain('Ask your AI about your finances. It can’t move money. Free during beta.')
    expect(m.text).toContain('https://app.aggregate.finance/?start=1&from=0123456789abcdef')
    expect(m.text).not.toMatch(/months free/i)
    expect(m.text).toContain('You won’t get another email about this invite')
    expect(m.text).not.toContain('only email')
    expect(m.text).toContain('Don’t send me invites: https://app.aggregate.finance/invites/stop?h=a&s=b')
    expect(m.html).toContain('invites/stop?h=a&s=b')
  })

  it('an account name can’t become a message', () => {
    expect(firstName('https://evil.example click')).toBe('A friend')
    expect(firstName('<b>x</b>')).toBe('A friend')
    expect(firstName('')).toBe('A friend')
    expect(firstName('Anne-Marie Lee')).toBe('Anne-Marie')
    expect(firstName('Urgent-invoice-overdue')).toBe('A friend')
    expect(firstName('Abcdefghijklmnopqrstuvwxyz')).toBe('A friend')
  })
})

describe('Don’t send me invites', () => {
  it('needs a real signature, writes only on the button, can be undone, and later invites look sent', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'inviter2@example.test', 'Acme')
      srv.outbox.splice(0)
      expect((await post(s, 'quiet@example.test')).status).toBe(200)
      await sent(srv, 1)
      const mail = invites(srv.outbox)[0]!
      const path = /\/invites\/stop\?h=([a-f0-9]{64})&(?:amp;)?s=([a-f0-9]{64})/.exec(mail)!
      const [h, sig] = [path[1]!, path[2]!]
      const optouts = () => withBypass('test', () => (srv.booted.services.db as never as Kysely<any>).selectFrom('friend_invite_optouts').select('email_hash').execute())
      const send = (action: string, signature = sig) => srv.app.request('/invites/stop', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ h, s: signature, action }) })

      expect((await srv.app.request(`/invites/stop?h=${h}&s=${'0'.repeat(64)}`)).status).toBe(404)
      expect((await send('stop', '0'.repeat(64))).status).toBe(404)
      expect((await srv.app.request(`/invites/stop?h=${h}&s=${sig}`)).status).toBe(200)
      expect(await optouts(), 'opening the link writes nothing').toEqual([])

      expect((await send('stop')).status).toBe(200)
      expect(await optouts()).toEqual([{ email_hash: h }])

      srv.outbox.splice(0)
      const other = await signIn(srv, 'inviter3@example.test', 'Beta')
      srv.outbox.splice(0)
      expect((await post(other, 'quiet@example.test')).status).toBe(200)
      expect(invites(srv.outbox)).toHaveLength(0)

      expect((await send('allow')).status).toBe(200)
      expect(await optouts()).toEqual([])
    } finally {
      await srv.close()
    }
  })

  it('makes links only for hashes it signed', () => {
    const link = new URL(friendStopLink('https://x.test/', 'secret', 'a'.repeat(64)))
    expect(validStop('secret', link.searchParams.get('h')!, link.searchParams.get('s')!)).toBe(true)
    expect(validStop('other', link.searchParams.get('h')!, link.searchParams.get('s')!)).toBe(false)
    expect(validStop('secret', 'b'.repeat(64), link.searchParams.get('s')!)).toBe(false)
  })
})

describe('invite hashes', () => {
  it('are deleted once the 30-day repeat check no longer needs them', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'inviter4@example.test', 'Acme')
      expect((await post(s, 'old@example.test')).status).toBe(200)
      const db = srv.booted.services.db as never as Kysely<any>
      expect(await withBypass('test', () => pruneFriendInvites(db, new Date(Date.now() + 29 * 86_400_000)))).toBe(0)
      expect(await withBypass('test', () => pruneFriendInvites(db, new Date(Date.now() + 31 * 86_400_000)))).toBe(1)
    } finally {
      await srv.close()
    }
  })
})

/** Accounts older than a day get the full allowance. */
const age = (srv: Awaited<ReturnType<typeof startServer>>) => withBypass('test', () => (srv.booted.services.db as unknown as Kysely<any>).updateTable('people').set({ created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).execute())
const sent = async (srv: Awaited<ReturnType<typeof startServer>>, n: number) => {
  await vi.waitFor(() => expect(invites(srv.outbox).length).toBeGreaterThanOrEqual(n))
  await new Promise((r) => setTimeout(r, 20))
  expect(invites(srv.outbox)).toHaveLength(n)
}
const body = async (r: { status: number; body: unknown }) => [r.status, JSON.stringify(r.body)]

describe('POST /api/friend-invite', () => {
  it('off by default: no route, nothing offered, and links already sent still work', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'off@example.test', 'Acme')
      srv.outbox.splice(0)
      expect((await s.get('/api/friend-invite')).status).toBe(404)
      expect((await post(s, 'friend@example.test')).status).toBe(404)
      expect(invites(srv.outbox)).toHaveLength(0)
      expect(JSON.stringify((await s.get('/api/workspace')).body)).not.toContain('friendInvites')
      expect((await srv.app.request('/invites/stop?h=x&s=y')).status).toBe(404) // the route answers: a bad signature, not a missing page
      expect(await (await srv.app.request('/invites/stop?h=x&s=y')).text()).toContain('This link isn’t valid.')
    } finally {
      await srv.close()
    }
  })

  it('answers the same whether or not the address has an account, the first time, the second, and past the limit', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'inviter@example.test', 'Acme')
      await signIn(srv, 'taken@example.test', 'Beta')
      await age(srv)
      srv.outbox.splice(0)
      const answers = []
      for (const email of ['taken@example.test', 'free@example.test', 'taken@example.test', 'free@example.test']) answers.push(await body(await post(s, email)))
      expect(new Set(answers.map(String)).size).toBe(1)
      expect(answers[0]).toEqual([200, '{"ok":true}'])
      await sent(srv, 1)
      for (let i = 0; i < PER_DAY + 3; i++) answers.push(await body(await post(s, `more${i}@example.test`)))
      answers.push(await body(await post(s, 'taken@example.test')), await body(await post(s, 'free2@example.test')))
      expect(new Set(answers.map(String)).size).toBe(1)
      await sent(srv, PER_DAY - 3) // the four tries above count, repeats included: only an address new to them sends
    } finally {
      await srv.close()
    }
  })

  it('refuses only what says nothing about anyone else: a bad address', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'inviter@example.test', 'Acme')
      expect((await post(s, 'nope')).status).toBe(400)
      expect((await post(s, 'inviter+x@example.test')).status).toBe(200)
      await new Promise((r) => setTimeout(r, 20))
      expect(invites(srv.outbox)).toHaveLength(0)
    } finally {
      await srv.close()
    }
  })

  it('an IPv6 /64 is one network, however it’s written', () => {
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2')
    expect(networkOf('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2')
    expect(networkOf('2001:0db8:0001:0002::')).toBe('2001:db8:1:2')
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0')
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9')
  })

  it('one mailbox is one address: +tags, and dots on Gmail', async () => {
    expect(canonicalEmail('A.b+x@GoogleMail.com')).toBe('ab@gmail.com')
    expect(canonicalEmail('a.b+x@example.test')).toBe('a.b@example.test')
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'inviter@example.test', 'Acme')
      await age(srv)
      srv.outbox.splice(0)
      for (const e of ['ab@gmail.com', 'a.b@gmail.com', 'a.b+1@googlemail.com']) expect((await post(s, e)).status).toBe(200)
      await sent(srv, 1)
    } finally {
      await srv.close()
    }
  })

  it('an account under a day old gets three', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'new@example.test', 'Acme')
      srv.outbox.splice(0)
      for (let i = 0; i < 5; i++) expect((await post(s, `n${i}@example.test`)).status).toBe(200)
      await sent(srv, NEW_ACCOUNT_PER_DAY)
    } finally {
      await srv.close()
    }
  })

  it('one network gets 20 attempts a day across accounts, and the same answer past that; the hash goes after a day', async () => {
    const srv = await startServer({ env: { AGFN_FRIEND_INVITES: '1', CLIENT_IP_HEADER: 'x-test-ip', AGFN_FRIEND_INVITES_PER_DAY: '100' } })
    try {
      const people: Array<Awaited<ReturnType<typeof signIn>>> = []
      for (let i = 0; i < 4; i++) people.push(await signIn(srv, `p${i}@example.test`, `Co ${i}`))
      await age(srv)
      srv.outbox.splice(0)
      const from = (s: (typeof people)[number], email: string, ip: string) => s.send<{ ok: boolean }>('POST', '/api/friend-invite', { email }, { 'x-test-ip': ip })
      for (let i = 0; i < 28; i++) {
        const r = await from(people[i % 4]!, `net${i}@example.test`, '203.0.113.9')
        expect([r.status, r.body]).toEqual([200, { ok: true }])
      }
      await sent(srv, PER_NETWORK_PER_DAY)
      expect((await from(people[3]!, 'other@example.test', '203.0.113.10')).status).toBe(200) // another network still can
      await sent(srv, PER_NETWORK_PER_DAY + 1)
      const db = srv.booted.services.db as unknown as Kysely<any>
      await withBypass('test', () => pruneFriendInvites(db, new Date(Date.now() + 2 * 86_400_000)))
      const left = await withBypass('test', () => db.selectFrom('friend_invites').select('ip_hash').where('ip_hash', 'is not', null).execute())
      expect(left).toHaveLength(0)
    } finally {
      await srv.close()
    }
  })

  it('the total for everyone holds, and counts only real sends', async () => {
    const srv = await startServer({ env: { AGFN_FRIEND_INVITES: '1', AGFN_FRIEND_INVITES_PER_DAY: '2' } })
    try {
      const [a, b] = [await signIn(srv, 'a@example.test', 'Acme'), await signIn(srv, 'b@example.test', 'Beta')]
      await age(srv)
      srv.outbox.splice(0)
      expect((await post(a, 'b@example.test')).status).toBe(200) // an account: no send, no place taken
      for (const e of ['x@example.test', 'y@example.test']) expect((await post(a, e)).status).toBe(200)
      expect((await post(b, 'z@example.test')).status).toBe(200)
      await sent(srv, 2)
    } finally {
      await srv.close()
    }
  })

  it('a second inviter of the same address looks sent and sends nothing', async () => {
    const srv = await startServer(ON)
    try {
      const [a, b] = [await signIn(srv, 'a@example.test', 'Acme'), await signIn(srv, 'b@example.test', 'Beta')]
      srv.outbox.splice(0)
      expect((await post(a, 'shared@example.test')).status).toBe(200)
      expect((await post(b, 'shared@example.test')).status).toBe(200)
      await sent(srv, 1)
    } finally {
      await srv.close()
    }
  })

  it('the link remembers who invited a new person, and gives no perk', async () => {
    const srv = await startServer(ON)
    try {
      const s = await signIn(srv, 'host@example.test', 'Acme')
      const { link } = (await s.get<{ link: string }>('/api/friend-invite')).body
      expect(link).toMatch(/\/\?start=1&from=[a-f0-9]{16}$/)
      const res = await srv.app.request(link.replace(/^https?:\/\/[^/]+/, ''))
      expect(res.headers.get('set-cookie')).toContain('agfn_friend=')
      expect((await srv.app.request('/?from=../../x')).headers.get('set-cookie') ?? '').not.toContain('agfn_friend')

      const guest = await signIn(srv, 'guest@example.test', 'Beta')
      const db = srv.booted.services.db as never
      const ids = await withBypass('test', () => (db as Kysely<any>).selectFrom('people').select(['id', 'email']).execute())
      const id = (email: string) => ids.find((p: { email: string }) => p.email === email)!.id as string
      const code = link.slice(-16)
      await withBypass('test', async () => {
        await recordFriendSignup(db, id('guest@example.test'), code)
        await recordFriendSignup(db, id('host@example.test'), code) // your own link records nothing
      })
      const rows = await withBypass('test', () => (db as Kysely<any>).selectFrom('friend_signups').selectAll().execute())
      expect(rows).toMatchObject([{ person_id: id('guest@example.test'), inviter_id: id('host@example.test') }])
      expect(JSON.stringify((await guest.get('/api/me')).body)).not.toMatch(/months|perk/i)
    } finally {
      await srv.close()
    }
  })
})
