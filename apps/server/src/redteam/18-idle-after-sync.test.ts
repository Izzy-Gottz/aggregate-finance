// Red team: the server must still answer once background work after a sync kicks in (the cache warmer runs 8 s after
// a sync settles). On SQLite, the self-host default, a warm pass that held the only connection in a transaction while
// other reads waited on it froze every request from then on.
import { expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { warmerFor } from '../finance.ts'
import { connectProvider, entities, signIn, startServer } from '../scenarios/harness.ts'

it('after a sync and its cache warm, requests are still answered', async () => {
  const srv = await startServer()
  try {
    const s = await signIn(srv, 'idle18@example.com', 'Acme')
    const acme = (await entities(s)).Acme as string
    const bank = await connectProvider(srv, s, 'plaid', { entityId: acme, name: 'Bank' })
    bank.push((c) => [{ type: 'account.upsert', externalId: 'a', connectionId: c, name: 'Checking', accountType: 'depository', currency: 'USD' }] as NormalizedEvent[])
    const warmer = warmerFor(srv.booted.services)!
    const schedule = vi.spyOn(warmer, 'schedule')
    // The warm after a sync is only for a workspace someone read in the last day: signing in read it, a day ago here.
    const now = Date.now()
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 3600_000)
    await bank.sync()
    later.mockRestore()
    expect(schedule).not.toHaveBeenCalled()
    expect((await s.get(`/api/connections/${bank.id}`)).status).toBe(200)
    await bank.sync()
    expect(schedule).toHaveBeenCalledTimes(1)
    // Run the scheduled warm now instead of waiting 8 s; it must finish, and so must the next request.
    const done = await Promise.race([warmer.flush().then(() => 'warmed'), new Promise((r) => setTimeout(() => r('hung'), 10_000))])
    expect(done).toBe('warmed')
    const t = Date.now()
    expect((await s.get('/api/me')).status).toBe(200)
    expect(Date.now() - t).toBeLessThan(5_000)
  } finally {
    await srv.close()
  }
}, 60_000)
