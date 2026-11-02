import { describe, expect, it } from 'vitest'
import { isNativeRedirect } from './auth.ts'

describe('isNativeRedirect', () => {
  it('never treats a script scheme as a native app', () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x']) expect(isNativeRedirect(uri)).toBe(false)
  })
})
