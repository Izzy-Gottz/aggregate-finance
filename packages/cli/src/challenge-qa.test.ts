// The challenge's operator commands refuse anywhere but the challenge deployment, and the reset asks for --confirm.
import { describe, expect, it } from 'vitest'
import { challengeCheckFlagCommand, challengeQaCommand, challengeResetCommand } from './challenge-qa.ts'
import type { Io } from './io.ts'

const io = (env: NodeJS.ProcessEnv): Io => ({ env, cwd: '/', out: () => {}, err: () => {} })
const noBoot = async () => {
  throw new Error('must not boot')
}

describe('challenge operator commands', () => {
  it('refuse without AGFN_CHALLENGE=1, before booting anything', async () => {
    await expect(challengeResetCommand(['--confirm', 'RESET'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
    await expect(challengeCheckFlagCommand(['FLAG-x'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
    await expect(challengeQaCommand(['--label', 'x'], io({}), noBoot)).rejects.toThrow(/only on the challenge/)
  })
  it('the reset needs --confirm RESET', async () => {
    await expect(challengeResetCommand([], io({ AGFN_CHALLENGE: '1' }), noBoot)).rejects.toThrow(/--confirm RESET/)
  })
})
