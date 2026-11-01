import { describe, expect, it } from 'vitest'
import { withTestAddressesLogged } from './mailer.ts'

describe('withTestAddressesLogged', () => {
  it('sends real addresses through the real mailer and only .test addresses to the log', async () => {
    const real: string[] = []
    const logged: string[] = []
    const m = withTestAddressesLogged({ send: async (x) => void real.push(x.to) }, { send: async (x) => void logged.push(x.to) })
    for (const to of ['a@example.com', 'smoke+1@example.test', 'b@ex.test', 'c@notatest.com', 'd@test']) await m.send({ to, subject: 's', text: 't' })
    expect(real).toEqual(['a@example.com', 'c@notatest.com'])
    expect(logged).toEqual(['smoke+1@example.test', 'b@ex.test', 'd@test'])
  })
})
