// Cross-instance: two separate pools (two server machines) on one real Postgres. Set AGFN_TEST_PG_URL to run it
// (e.g. a throwaway container); PGlite is one session, where advisory locks are re-entrant, so it only checks the no-wait path.
import { describe, expect, it } from 'vitest'
import { advisoryLock } from './advisory.ts'
import { connect } from './connect.ts'
import { connectPglite } from './pglite.ts'

const url = process.env.AGFN_TEST_PG_URL

describe('advisoryLock', () => {
  it('takes and releases on PGlite without blocking other queries', async () => {
    const h = await connectPglite({ empty: true })
    try {
      const release = await advisoryLock(h.db, 42)
      expect((await (h.db as any).selectNoFrom((eb: any) => eb.val(1).as('x')).executeTakeFirst()).x).toBe('1')
      await release()
    } finally {
      await h.close()
    }
  })

  it('is a no-op on SQLite', async () => {
    const h = await connect('sqlite::memory:')
    try {
      await (await advisoryLock(h.db, 42))()
    } finally {
      await h.close()
    }
  })

  it.runIf(!!url)('holds across two separate pools (two machines)', async () => {
    const a = await connect(url!)
    const b = await connect(url!)
    try {
      const order: string[] = []
      const releaseA = await advisoryLock(a.db, 43)
      const waiting = advisoryLock(b.db, 43).then((r) => (order.push('b got it'), r))
      await new Promise((r) => setTimeout(r, 300))
      order.push('a releases')
      await releaseA()
      await (await waiting)()
      expect(order).toEqual(['a releases', 'b got it'])
    } finally {
      await a.close()
      await b.close()
    }
  })
})
