import { describe, expect, it } from 'vitest'
import { demoLine } from './workspace.ts'

describe('the demo line on the waiting page', () => {
  it('says the place honestly, with ordinals and minutes', () => {
    expect(demoLine({ position: 1, minutes: 1 })).toBe('Your demo is next in line, about 1 minute. It fills by itself; this page updates when it’s ready.'.replace('’', "'"))
    expect(demoLine({ position: 3, minutes: 5 })).toMatch(/^You're 3rd in line for a demo, about 5 minutes\./)
    expect(demoLine({ position: 12, minutes: 20 })).toMatch(/^You're 12th in line/)
    expect(demoLine({ position: 22, minutes: 30 })).toMatch(/^You're 22nd in line/)
  })
})
