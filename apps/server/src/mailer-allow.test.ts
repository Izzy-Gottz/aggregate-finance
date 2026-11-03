import { afterEach, describe, expect, it, vi } from 'vitest'
import { withMailAllowList, withTestAddressesLogged } from './mailer.ts'

const mail = (to: string) => ({ to, subject: 's', text: 't' })

describe('withMailAllowList', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends only to listed addresses, exactly, ignoring case and spaces', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent: string[] = []
    const m = withMailAllowList({ send: async (x) => void sent.push(x.to) }, ' Me@Example.com, ,you@example.com')
    await m.send(mail('me@example.com'))
    await m.send(mail('YOU@example.com'))
    await m.send(mail('me+test@example.com'))
    await m.send(mail('someone@else.com'))
    expect(sent).toEqual(['me@example.com', 'YOU@example.com'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('else.com')
  })

  it('leaves .test logging working in front of it', async () => {
    const sent: string[] = []
    const logged: string[] = []
    const m = withTestAddressesLogged(withMailAllowList({ send: async (x) => void sent.push(x.to) }, 'me@example.com'), { send: async (x) => void logged.push(x.to) })
    await m.send(mail('smoke@example.test'))
    expect(logged).toEqual(['smoke@example.test'])
    expect(sent).toEqual([])
  })
})
