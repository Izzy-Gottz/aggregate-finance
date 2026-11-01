import { describe, expect, it } from 'vitest'
import { AI_DISCLOSURE, aiDisclosure } from '@agfn/contracts'
import { consentShown } from './consent.ts'

describe('consentShown', () => {
  it('keeps the current disclosure line, refuses an older page, and records nothing for callers that showed none', async () => {
    expect(consentShown(AI_DISCLOSURE.version, aiDisclosure('Claude'))).toEqual({ version: AI_DISCLOSURE.version, text: aiDisclosure('Claude') })
    expect(aiDisclosure('Claude')).toContain('Claude')
    expect(consentShown(undefined, 'x')).toBeUndefined()
    let res: Response | undefined
    try {
      consentShown('2020-01-01', 'x')
    } catch (e) {
      res = (e as { getResponse(): Response }).getResponse()
    }
    expect(res?.status).toBe(409)
    expect(await res?.json()).toMatchObject({ error: 'consent_outdated' })
  })
})
